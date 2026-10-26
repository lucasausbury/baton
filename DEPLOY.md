# Deploying to Hetzner

The server is one small always-on process with a SQLite file. Two containers:
the app, and Caddy in front for TLS. The app's port is never published to the
host, so the only way in is over HTTPS.

## Before you start

- A Hetzner Cloud account.
- A domain you can add a subdomain to.
- This repository reachable from the server — push it to a private GitHub repo
  (`gh repo create ai-worker-manager --private --source . --push`) or `rsync` it
  across. It is not public and doesn't need to be.

## 1. Provision the server

Create a **CAX11** (shared Arm, 2 vCPU, 4GB, ~€4/month) with Ubuntu 24.04. Arm
is the cheapest option and every image used here is multi-arch. Add your SSH key
during creation.

This box only ever runs the control plane. Agents run on your own machines, so
it needs no CPU to speak of.

Build the image **on the server** rather than pushing one from your laptop —
then the architecture matches whatever you provisioned and you never think about
it again.

## 2. Point DNS at it

An `A` record for `awm.yourdomain.com` to the server's IPv4, and an `AAAA` to
its IPv6 if you want it. Wait for it to resolve before step 5, because Caddy
gets its certificate by being reachable on that name.

```bash
dig +short awm.yourdomain.com
```

## 3. Lock it down

```bash
ssh root@<ip>
adduser --gecos "" lucas && usermod -aG sudo lucas
rsync --archive --chown=lucas:lucas ~/.ssh /home/lucas
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

Then disable password SSH in `/etc/ssh/sshd_config` (`PasswordAuthentication no`,
`PermitRootLogin no`) and `systemctl restart ssh`. Reconnect as `lucas` before
closing the root session.

Hetzner also has a firewall at the project level, which is worth setting to the
same three ports as a second layer.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sh    # Docker's own install script
sudo usermod -aG docker lucas
exit                                       # log back in for the group to apply
```

## 5. Deploy

```bash
sudo mkdir -p /opt/awm && sudo chown lucas:lucas /opt/awm
git clone <your-repo> /opt/awm && cd /opt/awm

cp .env.example .env
chmod 600 .env
openssl rand -hex 32    # AWM_ADMIN_TOKEN
openssl rand -hex 16    # AWM_NTFY_TOPIC -- see the note in .env.example
$EDITOR .env            # fill in AWM_DOMAIN, the two secrets, AWM_PUBLIC_URL

docker compose up -d --build
docker compose logs -f   # watch Caddy get its certificate
```

Check it:

```bash
curl https://awm.yourdomain.com/healthz        # {"ok":true,"workers":0}
curl -o /dev/null -w '%{http_code}\n' https://awm.yourdomain.com/v1/work   # 401
```

A 401 on `/v1/work` is correct — that endpoint needs a worker token.

## 6. Connect Claude to it

**From Claude Code, this works today:**

```bash
claude mcp add --transport http awm https://awm.yourdomain.com/mcp \
  --header "Authorization: Bearer <AWM_ADMIN_TOKEN>"
```

**From the Claude mobile and desktop apps, it does not yet.** Adding a remote
MCP server there means adding it as a custom connector, and a custom connector
authenticates in one of three ways: OAuth 2.0, a static credential in a request
header, or nothing at all. The static-header option (`static_headers`) is
documented as "Beta, for a limited set of organizations" — if your organization
doesn't have it, the **Request headers** field simply isn't shown when you add
the connector. Putting the token in the URL is not a way around this: the MCP
authorization spec prohibits tokens in query strings, and the connector docs say
explicitly never to accept one there.

So the mobile path needs OAuth with Dynamic Client Registration, which is
supported by default but is a real piece of work on this server: a `401` carrying
a `WWW-Authenticate: Bearer resource_metadata=…` pointer, protected-resource and
authorization-server metadata documents, a `/register` endpoint, PKCE S256, a
token endpoint with refresh-token rotation, and `https://claude.ai/api/mcp/auth_callback`
registered as a redirect URI. For a single-user server the "sign in" step can be
a single password field, so it's tractable — just not free.

Until that exists, drive it from Claude Code on your laptop, and check whether
your account sees the **Request headers** field when adding a custom connector.
If it does, you can skip the OAuth work entirely.

## 7. Register your machines

On the server:

```bash
cd /opt/awm
docker compose exec awm node --no-warnings=ExperimentalWarning src/cli.ts \
  worker add "MacBook Pro" --platform darwin
```

Copy the token it prints — it isn't recoverable. Then add a profile and a
project, and set up the worker as described in the README.

## 8. Backups

The whole system's state is one SQLite file, so a nightly online backup is the
whole backup. `crontab -e`:

```cron
0 3 * * * cd /opt/awm && docker compose exec -T awm node --no-warnings=ExperimentalWarning scripts/backup.ts >> /var/log/awm-backup.log 2>&1
```

That keeps the last 7 in `/data/backups` inside the volume, which protects you
from a bad migration or a careless delete but **not** from losing the server.
For that, pull them off the box:

```cron
30 3 * * * rsync -az -e ssh lucas@<ip>:/var/lib/docker/volumes/awm_awm-data/_data/backups/ ~/backups/awm/
```

Or enable Hetzner's own backups for the server (20% of its cost), which is the
lazy and probably correct answer.

## 9. Updating

```bash
cd /opt/awm && git pull && docker compose up -d --build
```

The database is on a named volume, so rebuilding the image never touches it.

## If something is wrong

| Symptom | Likely cause |
| - | - |
| Caddy won't get a certificate | DNS not resolving yet, or 80/443 blocked |
| `/healthz` works, `/mcp` returns 503 | `AWM_ADMIN_TOKEN` is empty in `.env` |
| `/mcp` returns 401 | Token mismatch between `.env` and your client |
| Runners connect then stall | Check `docker compose logs awm` for the reaper requeueing claims |
| Notifications silent | `AWM_NTFY_TOPIC` unset — the server logs them instead |

`docker compose logs -f awm` and `docker compose logs -f caddy` are the two
places to look.

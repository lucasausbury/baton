# Deploying to Hetzner

The server is one small always-on process with a SQLite file. Two containers:
the app, and Caddy in front for TLS. The app's port is never published to the
host, so the only way in is over HTTPS.

## Before you start

- A Hetzner Cloud account.
- A domain you can add a subdomain to.
- This repository reachable from the server — push it to a private GitHub repo
  (`gh repo create baton --private --source . --push`) or `rsync` it
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

An `A` record for `baton.yourdomain.com` to the server's IPv4, and an `AAAA` to
its IPv6 if you want it. Wait for it to resolve before step 5, because Caddy
gets its certificate by being reachable on that name.

```bash
dig +short baton.yourdomain.com
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
sudo mkdir -p /opt/baton && sudo chown lucas:lucas /opt/baton
git clone <your-repo> /opt/baton && cd /opt/baton

cp .env.example .env
chmod 600 .env
openssl rand -hex 32    # BATON_ADMIN_TOKEN
openssl rand -hex 16    # BATON_NTFY_TOPIC -- see the note in .env.example
$EDITOR .env            # fill in BATON_DOMAIN, the two secrets, BATON_PUBLIC_URL

docker compose up -d --build
docker compose logs -f   # watch Caddy get its certificate
```

Check it:

```bash
curl https://baton.yourdomain.com/healthz        # {"ok":true,"workers":0}
curl -o /dev/null -w '%{http_code}\n' https://baton.yourdomain.com/v1/work   # 401
```

A 401 on `/v1/work` is correct — that endpoint needs a worker token.

## 6. Connect Claude to it

**From Claude Code, this works today:**

```bash
claude mcp add --transport http baton https://baton.yourdomain.com/mcp \
  --header "Authorization: Bearer <BATON_ADMIN_TOKEN>"
```

**From the Claude mobile and desktop apps,** add it as a custom connector:
Settings → Connectors → Add custom connector, with the URL
`https://baton.yourdomain.com/mcp`. Claude discovers that the server wants OAuth,
sends you to a consent screen, and you enter `BATON_LOGIN_PASSWORD`. After that it
stays connected and refreshes its own token.

The server is its own OAuth authorization server, which it has to be: a custom
connector authenticates with OAuth, a static credential in a request header, or
nothing. The static-header option is beta for a limited set of organizations —
if yours doesn't have it, the **Request headers** field isn't shown at all — and
the MCP authorization spec prohibits putting the token in the URL. With one user,
"signing in" is proving you know one password.

Both routes stay open. The admin token keeps working for Claude Code, so you
aren't forced through OAuth on a machine where a header is simpler.

> [!NOTE]
>
> The consent screen is the only thing standing between a stranger with your URL
> and every machine you've registered. Failed attempts are rate limited to 10 per
> 15 minutes per address, but pick a password worth that trust.

## 7. Register your machines

On the server:

```bash
cd /opt/baton
docker compose exec baton node --no-warnings=ExperimentalWarning src/cli.ts \
  worker add "MacBook Pro" --platform darwin
```

Copy the token it prints — it isn't recoverable. Then add a profile and a
project, and set up the worker as described in the README.

## 8. Backups

The whole system's state is one SQLite file, so a nightly online backup is the
whole backup. `crontab -e`:

```cron
0 3 * * * cd /opt/baton && docker compose exec -T baton node --no-warnings=ExperimentalWarning scripts/backup.ts >> /var/log/baton-backup.log 2>&1
```

That keeps the last 7 in `/data/backups` inside the volume, which protects you
from a bad migration or a careless delete but **not** from losing the server.
For that, pull them off the box:

```cron
30 3 * * * rsync -az -e ssh lucas@<ip>:/var/lib/docker/volumes/baton_baton-data/_data/backups/ ~/backups/baton/
```

Or enable Hetzner's own backups for the server (20% of its cost), which is the
lazy and probably correct answer.

## 9. Updating

```bash
cd /opt/baton && git pull && docker compose up -d --build
```

The database is on a named volume, so rebuilding the image never touches it.

## If something is wrong

| Symptom | Likely cause |
| - | - |
| Caddy won't get a certificate | DNS not resolving yet, or 80/443 blocked |
| `/healthz` works, `/mcp` returns 503 | `BATON_ADMIN_TOKEN` is empty in `.env` |
| `/mcp` returns 401 | Token mismatch between `.env` and your client |
| Runners connect then stall | Check `docker compose logs baton` for the reaper requeueing claims |
| Notifications silent | `BATON_NTFY_TOPIC` unset — the server logs them instead |

`docker compose logs -f baton` and `docker compose logs -f caddy` are the two
places to look.

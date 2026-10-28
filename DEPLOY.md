# Deploying baton

The server is one small always-on process with a SQLite file. Two containers:
the app, and Caddy in front for TLS. The app's port is never published to the
host, so the only way in is over HTTPS.

## Before you start

- A small Linux server with a public IP that you can SSH into. Any VPS will do.
- A domain you can add a subdomain to.

The repository is public at `github.com/lucasausbury/baton`, so the server
clones it with no credentials and updates are a `git pull`. It holds no
secrets: `.env` and `runner.config.json` are gitignored, and GitHub's secret
scanning with push protection is on, so a credential that slips into a commit
is blocked at push rather than discovered by a bot.

## 1. Provision the server

One vCPU and 1GB of RAM is plenty -- the smallest instance most providers sell
is already more than this needs. The box only ever runs the control plane: it
holds the queue, relays approvals and stores a SQLite file. The agents run on
your own machines, so it needs no CPU to speak of and a few GB of disk.

The commands below assume Ubuntu 24.04. Any distribution with Docker works,
with the obvious substitutions. Arm instances are usually cheaper and every
image used here is multi-arch, so take one if your provider offers it. Add your
SSH key when you create the instance.

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
adduser --gecos "" deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

`deploy` is just a name -- use whatever you like, and substitute it in the
commands from here on.

Then disable password SSH in `/etc/ssh/sshd_config` (`PasswordAuthentication no`,
`PermitRootLogin no`) and `systemctl restart ssh`. Reconnect as `deploy` before
closing the root session.

Most providers also offer a firewall outside the machine itself -- a project or
cloud firewall, a security group. Setting that to the same three ports is a
worthwhile second layer, since it survives anything that goes wrong inside the
box.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sh    # Docker's own install script
sudo usermod -aG docker deploy
exit                                       # log back in for the group to apply
```

## 5. Deploy

```bash
sudo mkdir -p /opt/baton && sudo chown deploy:deploy /opt/baton
git clone https://github.com/lucasausbury/baton.git /opt/baton && cd /opt/baton

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

On each worker machine, not on the server:

```bash
npm run enroll -- --server https://baton.yourdomain.com
```

It asks for the login password, works out what the machine has, asks what each
project may do unattended, and writes `runner.config.json` itself. The worker
token never passes through you.

There is still `cli.ts worker add` on the server if you want to register a
machine without touching it, but then you have to carry the token across
yourself — it is printed once and is not recoverable.

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
30 3 * * * rsync -az -e ssh deploy@<ip>:/var/lib/docker/volumes/baton_baton-data/_data/backups/ ~/backups/baton/
```

Or turn on your provider's own snapshots or backups for the whole server, which
is the lazy and probably correct answer.

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

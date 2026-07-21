# Deploying cbAnnotServer (Cell Browser login / annotation API)

The backend is a Flask app. In production it runs under **gunicorn** on the
cells server, and **Apache reverse-proxies `/api`** to it. This is the route
Max chose (ticket #37492): it avoids tying us to RedHat's system Python the way
mod_wsgi would, and it lets the Genome Browser reuse the same auth service later
without every server being locked to one interpreter.

```
browser ──HTTPS──▶ Apache (cells vhost) ──/api──▶ gunicorn ──▶ Flask (wsgi.py)
         static files ◀── docroot (htdocs-cells)                      │
                                                                 SQLite on /hive
```

Everything the frontend talks to is under `/api`; everything else is the normal
static Cell Browser served from the docroot.

## Pieces

| File | What it is |
|------|------------|
| `wsgi.py` (parent dir) | WSGI entry point: `wsgi:application` |
| `gunicorn.conf.py` (parent dir) | gunicorn settings, all env-overridable |
| `run-gunicorn.sh` | Activates the venv and execs gunicorn; run by systemd/cron |
| `cbAnnotServer.service` | systemd unit (recommended keep-alive) |
| `watchdog.sh` | cron keep-alive fallback if systemd isn't available |
| `apache-cells-api.conf` | ProxyPass snippet to paste into the cells vhosts |
| `cb.conf.sample` | Site config template for the docroot (read by the frontend) |

## One-time setup

1. **Virtualenv + deps** (in `src/cbAnnotServer`):
   ```
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt      # includes gunicorn
   ```
2. **Database dir** (SQLite on GPFS/`hive`, which honors file locking):
   ```
   mkdir -p /hive/data/inside/cells/cbAnnotServer
   ```
   Postgres is a drop-in later via `CBANNOT_DATABASE_URI`.
3. **Secret key** — generate once and keep it stable so logins survive restarts:
   ```
   python -c 'import secrets; print(secrets.token_hex(32))'
   ```

## Runtime configuration (environment)

Set these where the process is launched (the systemd unit, or an env file the
cron watchdog sources). See `config.py` for the full list.

| Variable | Production value |
|----------|------------------|
| `CBANNOT_SECRET_KEY` | the long random string from step 3 |
| `CBANNOT_DATABASE_URI` | `sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db` |
| `CBANNOT_BIND` | `127.0.0.1:5051` (must match the ProxyPass target) |
| `CBANNOT_COOKIE_SECURE` | `true` (site is HTTPS) |
| `CBANNOT_SITE_BASE_URL` | `https://cells.ucsc.edu` (used in email links) |
| `CBANNOT_MAIL_BACKEND` | `smtp` once real email is wired; default `console` prints tokens to the log |

## Keeping it running

**Preferred — systemd** (`cbAnnotServer.service`). Restarts on crash and on
reboot. Installing it needs root, so hand it to the admins:
```
# after filling in the placeholders in the unit file
sudo cp cbAnnotServer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cbAnnotServer
systemctl status cbAnnotServer
```

**Fallback — cron watchdog** (`watchdog.sh`) if systemd isn't an option. Add to
the deploy user's crontab:
```
* * * * *  /ABS/PATH/src/cbAnnotServer/deploy/watchdog.sh >> /var/log/cbAnnotServer/watchdog.log 2>&1
@reboot    /ABS/PATH/src/cbAnnotServer/deploy/watchdog.sh >> /var/log/cbAnnotServer/watchdog.log 2>&1
```

## Apache

In each cells VirtualHost in `/usr/local/apache/conf.d/vhosts.conf`:

1. **Remove the dead dataset-search proxy** (present in the `cells-test` vhost):
   ```
   ProxyPass        /api/search http://127.0.0.1:3001/search
   ProxyPassReverse /api/search http://127.0.0.1:3001/search
   ```
   That prototype is retired — the 3001 backend is gone and nothing calls
   `/api/search`. Removing it also avoids a ProxyPass ordering trap (a bare
   `/api` before a more specific `/api/search` would shadow it).
2. **Add** the `apache-cells-api.conf` snippet (the `/api` → gunicorn proxy).

Then:
```
sudo apachectl configtest && sudo apachectl graceful
```
This edit needs root and coordination with whoever owns the cells box.

## Frontend config (`cb.conf`)

Copy `cb.conf.sample` to `cb.conf` in each docroot (`htdocs-cells`,
`htdocs-cells-beta`). The frontend fetches it at startup to learn where the
login API lives. On cells.ucsc.edu leave `annotApiBase` empty (same host, Apache
proxies `/api` locally). On a mirror/sandbox with no backend, point it at a
server that has one:
```
annotApiBase=https://cells.ucsc.edu
```
`cbUpgrade` never overwrites `cb.conf`, so it survives code deploys.

## Verifying end to end

```
# 1. gunicorn answers on the loopback port
curl -s http://127.0.0.1:5051/api/health          # -> {"ok": true}

# 2. Apache forwards /api to it
curl -s https://cells-test.gi.ucsc.edu/api/health # -> {"ok": true}

# 3. In the browser: Sign in menu -> create account -> verify -> sign in.
#    With CBANNOT_MAIL_BACKEND=console the verification link is printed to the
#    service log (journalctl -u cbAnnotServer, or the watchdog gunicorn log).
```

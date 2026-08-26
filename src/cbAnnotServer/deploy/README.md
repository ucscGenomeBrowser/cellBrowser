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
| `restart-gunicorn.sh` | reload (`SIGHUP`) or hard-restart the running gunicorn; run as its owner (otto) |
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
| `CBANNOT_MAIL_BACKEND` | `smtp` to actually send email; default `console` only prints tokens to the log (this is why verification emails don't arrive until it's flipped) |
| `CBANNOT_MAIL_SERVER` | SMTP host, e.g. `localhost` (hgwdev/cells run a local Sendmail on port 25) |
| `CBANNOT_MAIL_PORT` | `25` for the local MTA |
| `CBANNOT_MAIL_FROM` | envelope/from address, e.g. `noreply@cells.ucsc.edu` |
| `CBANNOT_GOOGLE_CLIENT_ID` / `CBANNOT_GOOGLE_CLIENT_SECRET` | Google OAuth client (blank = Google button hidden) |
| `CBANNOT_ORCID_CLIENT_ID` / `CBANNOT_ORCID_CLIENT_SECRET` | ORCID OAuth client (blank = ORCID button hidden) |
| `CBANNOT_ORCID_ENV` | `production` (orcid.org) or `sandbox` (sandbox.orcid.org) |

## Email (verification / password reset)

The service ships with `CBANNOT_MAIL_BACKEND=console`, which **prints** the
verification link to the log and sends nothing — handy in dev, but it means real
signups never receive an email. To actually send, set on the running service:
```
CBANNOT_MAIL_BACKEND=smtp
CBANNOT_MAIL_SERVER=localhost      # local Sendmail listens on :25
CBANNOT_MAIL_PORT=25
CBANNOT_MAIL_FROM=noreply@cells.ucsc.edu
```
then restart gunicorn (on cells the otto watchdog re-launches it and re-sources
the env file). Signup no longer 500s if the MTA hiccups — the account is still
created and the user can use "resend verification".

## OAuth sign-in (Google / ORCID)

Google and ORCID are OpenID Connect providers wired up in `oauth.py`. Each stays
**dormant until both its client id and secret are set**, so this ships safely
before the apps are registered — no button appears and the `/api/auth/oauth/...`
routes 404. The PI registers the client apps (ticket #37492) and drops the
credentials into the env file; no code change or release is needed to turn them on.

Registered **redirect URIs** must match exactly:
```
https://cells-test.gi.ucsc.edu/api/auth/oauth/google/callback
https://cells-test.gi.ucsc.edu/api/auth/oauth/orcid/callback
https://cells.ucsc.edu/api/auth/oauth/google/callback     # prod, later
https://cells.ucsc.edu/api/auth/oauth/orcid/callback       # prod, later
```

Because OAuth users have no local password (and ORCID may not share an email),
`users.email` and `users.password_hash` became nullable and two columns were
added. **Existing databases must be migrated once** (create_all won't alter an
existing table). With the service stopped:
```
CBANNOT_DATABASE_URI=sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db \
    ./venv/bin/python3 deploy/migrate_oauth.py     # backs up the DB, then rebuilds `users`
```
It's idempotent and preserves all rows. A fresh install (`db.create_all()` /
`schema.sql`) already has the new shape and needs no migration.

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

### Code-only sandboxes (`dataRoot`)

`dataRoot` points the frontend at data served from somewhere other than the
directory the code was loaded from, so you can run a sandbox that holds only
`index.html`, `js/`, `css/` and `cb.conf` against the shared dataset tree
instead of copying hundreds of GB:

```
# in htdocs-cells-mspeir/cb.conf
dataRoot=https://cells-test.gi.ucsc.edu
```

Everything under the data tree moves with it: the dataset directories,
`search.json`, `genes/` and `downloads/markers/`. The code's own files, and
`cb.conf` itself, are always read from the directory serving the page.

Set up such a sandbox with:
```
cbUpgrade -o /usr/local/apache/htdocs-cells-mspeir --code
cp cb.conf.sample /usr/local/apache/htdocs-cells-mspeir/cb.conf
# then edit dataRoot in that file
```

An absolute URL crosses origins, so the data host must send
`Access-Control-Allow-Origin` (the `cells*` vhosts on hgwdev already do). To
stay same-origin, use a server-absolute path instead (`dataRoot=/cells-data`)
and add an Apache `Alias` for it.

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

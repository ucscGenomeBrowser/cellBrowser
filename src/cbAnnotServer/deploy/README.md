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
| `providers.conf.sample` | Sign-in provider template (server-side, holds secrets, chmod 600) |
| `migrate_identities.py` | One-off DB migration to the `oauth_identities` table |

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
| `CBANNOT_PROVIDERS_CONF` | path to the sign-in provider conf file; default `/hive/data/inside/cells/cbAnnotServer/providers.conf` (see OAuth below) |

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

## OAuth sign-in (Google, ORCID, CILogon, anything else that speaks OIDC)

Providers are **configured, not coded**. Every one is an OpenID Connect issuer,
so none needs its own code path: drop a stanza into `providers.conf`, restart
gunicorn, and the button appears in the sign-in dialog. No code change, no
release, no frontend edit.

Copy `deploy/providers.conf.sample` to
`/hive/data/inside/cells/cbAnnotServer/providers.conf` (or set
`CBANNOT_PROVIDERS_CONF`) and fill in credentials:

```ini
[provider:google]
client_id     = ...
client_secret = ...

[provider:cilogon]
client_id     = cilogon:/client_id/xxxxxxxx
client_secret = ...
```

`google`, `orcid`, `orcid-sandbox`, `cilogon`, `globus` and `microsoft` are
built-in presets (`providers.py`) supplying the discovery URL, scope and button
label, so credentials are the whole stanza. Any other OIDC issuer works too —
give it a `discovery` URL and a `label`. Full key list is in the sample file.

**This file holds client secrets: keep it off the web tree and `chmod 600` it.**
The service logs a warning at startup if it is group- or world-readable. It is
*not* the frontend's `cb.conf`, which the browser fetches over HTTP.

A stanza with no `client_id`/`client_secret` is skipped silently, so a provider
can ship dormant: no button appears and `/api/auth/oauth/<slug>/...` 404s until
the app is registered. `GET /api/auth/providers` reports what is live, and the
frontend builds its buttons from that list — nothing in `cellBrowser.js` names
an individual provider.

Registered **redirect URIs** must match exactly, one per provider slug:
```
https://cells-test.gi.ucsc.edu/api/auth/oauth/<slug>/callback
https://cells.ucsc.edu/api/auth/oauth/<slug>/callback          # prod, later
```

The legacy `CBANNOT_GOOGLE_*` / `CBANNOT_ORCID_*` environment variables still
work and are folded in as if they were stanzas, so an existing deployment keeps
running untouched. A stanza for the same slug wins. Prefer the conf file for
anything new.

### Institutional login (InCommon / eduGAIN)

Use **CILogon**, not Shibboleth. CILogon is an OIDC broker in front of InCommon
and eduGAIN — thousands of campus IdPs, plus ORCID, Google and Microsoft — so
from this service's point of view it is one more OIDC provider. Becoming a SAML
service provider directly would mean `mod_shib`, federation metadata,
certificates, per-IdP attribute release negotiation, and a second authentication
path in the app; the broker avoids all of it.

Two settings matter when enabling it:

- **`subject_claim`** (default `sub`). Some campus IdPs recycle
  `eduPersonPrincipalName` when a person leaves, which would hand a departed
  user's account to whoever inherits the username. Where the federation
  guarantees a permanent identifier, name that claim instead.
- **`trust_email` stays `no`.** CILogon relays whatever the upstream campus IdP
  asserts, across thousands of institutions of varying rigour. See below.

### How an external login maps to an account

`oauth_identities` holds one row per `(provider, subject)`, and a user may have
several. Resolution order in `oauth._find_or_create`:

1. A known `(provider, subject)` is that account, always.
2. Otherwise, if the provider is `trust_email = yes` **and** asserted
   `email_verified` **and** the address matches an existing account, adopt that
   account and attach this identity to it.
3. Otherwise create a new account.

Both conditions in step 2 matter. An issuer that hands out unverified addresses
would otherwise let someone take over an existing account by signing up there
with the victim's address — which is why `trust_email` defaults to off
everywhere but Google, and why the `email_verified` claim is checked on top of
it. When an account is created from an untrusted email it starts with no address
of its own; the user can add and verify one, or link from a signed-in session.

**Linking.** The same person arriving through Google directly and through
CILogon presents two different subjects, and without linking the second becomes
a second, empty account. Signing in while already signed in
(`/api/auth/oauth/<slug>/login?link=1`, reachable from *Linked sign-ins…* in the
account menu) attaches the new identity to the current account instead. The
account menu dialog also unlinks; both it and the API refuse to remove the last
remaining way in. `cbannot_admin.py identities` lists everything, and
`cbannot_admin.py unlink <id>` does the same from the shell.

An identity already bound to a *different* account is refused rather than moved:
merging two accounts means merging their annotations and DE runs, which should
not happen behind the user's back.

### Database migrations

Two one-off scripts, both idempotent, both backing the DB up first. Run with
the service stopped, oldest first — each is a no-op if it does not apply:

```
export CBANNOT_DATABASE_URI=sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db
./venv/bin/python3 deploy/migrate_oauth.py       # pre-OAuth DBs: nullable email/password + oauth columns
./venv/bin/python3 deploy/migrate_identities.py  # moves those columns into oauth_identities
```

`migrate_identities.py` copies every existing OAuth login into the new table and
rebuilds `users` without `oauth_provider`/`oauth_sub` (SQLite cannot drop a
column out of a UNIQUE constraint in place). A fresh install via
`db.create_all()` or `schema.sql` already has the right shape.

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

# 3. The provider list matches providers.conf (empty "providers" = none loaded;
#    check the startup log line "OAuth sign-in enabled for: ...")
curl -s https://cells-test.gi.ucsc.edu/api/auth/providers

# 4. In the browser: Sign in menu -> create account -> verify -> sign in.
#    With CBANNOT_MAIL_BACKEND=console the verification link is printed to the
#    service log (journalctl -u cbAnnotServer, or the watchdog gunicorn log).

# 5. Each configured provider: Sign in menu -> its button -> consent -> you land
#    back in the app signed in. Then account menu -> "Linked sign-ins..." ->
#    add a second provider -> confirm it attaches to the SAME account rather
#    than creating a new one (cbannot_admin.py identities shows both on one
#    user_id).
```

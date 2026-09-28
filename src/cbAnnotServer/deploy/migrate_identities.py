#!/usr/bin/env python3
"""
One-off migration: move OAuth logins out of users.oauth_provider/oauth_sub and
into the oauth_identities table.

Why this is needed: db.create_all() creates missing tables but never alters an
existing one, so it will add `oauth_identities` on its own yet leave the two
dead columns (and their UNIQUE constraint) on `users`. More importantly, the
rows already in those columns have to be carried across or those users lose
their sign-in.

What it does, in one transaction:
  1. creates oauth_identities if it is missing;
  2. copies every users row that has an oauth_provider into it, preserving
     last_login and created_at;
  3. rebuilds `users` without oauth_provider / oauth_sub (SQLite cannot DROP
     COLUMN out of a UNIQUE constraint in place), preserving every row.

Usage (run once, with the service stopped, after backing up the DB):

    CBANNOT_DATABASE_URI=sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db \\
        python3 deploy/migrate_identities.py

Idempotent: if users.oauth_provider is already gone it reports "already
migrated" and exits. It writes a timestamped <db>.bak-<epoch> copy first.

Run deploy/migrate_oauth.py before this one on a database old enough to predate
the OAuth columns entirely; that script is a no-op on anything newer.
"""
import os
import shutil
import sqlite3
import sys
import time


def db_path_from_uri(uri):
    prefix = "sqlite:///"
    if not uri.startswith(prefix):
        sys.exit(f"only sqlite URIs are supported here, got: {uri}")
    # Strip exactly "sqlite:///"; a fourth slash is the leading "/" of an
    # absolute path, so sqlite:////abs/path yields "/abs/path".
    return uri[len(prefix):]


IDENTITIES = """
CREATE TABLE IF NOT EXISTS oauth_identities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    subject         TEXT NOT NULL,
    email           TEXT,
    display_name    TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login      TIMESTAMP,
    UNIQUE (provider, subject)
)
"""

NEW_USERS = """
CREATE TABLE users_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE,
    password_hash   TEXT,
    display_name    TEXT,
    email_verified  BOOLEAN NOT NULL DEFAULT 0,
    verify_token    TEXT,
    reset_token     TEXT,
    reset_expires   TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login      TIMESTAMP
)
"""

USER_COLS = ("id, email, password_hash, display_name, email_verified, "
             "verify_token, reset_token, reset_expires, created_at, last_login")


def main():
    uri = os.environ.get("CBANNOT_DATABASE_URI") \
        or "sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db"
    path = db_path_from_uri(uri)
    if not os.path.exists(path):
        sys.exit(f"database not found: {path}")

    conn = sqlite3.connect(path)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    if not cols:
        sys.exit("no 'users' table found -- is this the right database?")
    if "oauth_provider" not in cols:
        print(f"already migrated (users.oauth_provider is gone): {path}")
        conn.close()
        return

    backup = f"{path}.bak-{int(time.time())}"
    shutil.copy2(path, backup)
    print(f"backed up {path} -> {backup}")

    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        with conn:  # one transaction
            conn.execute(IDENTITIES)
            # Carry existing OAuth logins across. INSERT OR IGNORE guards the
            # case where this ran halfway before: the UNIQUE(provider, subject)
            # makes a repeated copy a no-op rather than an error.
            cur = conn.execute(
                "INSERT OR IGNORE INTO oauth_identities "
                "  (user_id, provider, subject, email, display_name, created_at, last_login) "
                "SELECT id, oauth_provider, oauth_sub, email, display_name, created_at, last_login "
                "  FROM users WHERE oauth_provider IS NOT NULL AND oauth_sub IS NOT NULL"
            )
            moved = cur.rowcount

            conn.execute(NEW_USERS)
            conn.execute(f"INSERT INTO users_new ({USER_COLS}) SELECT {USER_COLS} FROM users")
            conn.execute("DROP TABLE users")
            conn.execute("ALTER TABLE users_new RENAME TO users")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_identities_user    ON oauth_identities(user_id)")

        n_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        n_ident = conn.execute("SELECT COUNT(*) FROM oauth_identities").fetchone()[0]
        print(f"migrated: {moved} OAuth login(s) moved to oauth_identities "
              f"({n_ident} row(s) total), users rebuilt with {n_users} row(s) preserved")
        # A rebuilt table leaves the old pages behind; reclaim them.
        conn.execute("VACUUM")
    finally:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
One-off migration: add OAuth (Google / ORCID) support to an existing
cbAnnotServer SQLite database.

Why this is needed: db.create_all() only creates missing tables — it never
alters an existing one. The OAuth work makes users.email and users.password_hash
nullable and adds users.oauth_provider / users.oauth_sub. Making the two
columns nullable requires a full table rebuild (SQLite can ADD COLUMN but cannot
drop a NOT NULL constraint in place), so this script rebuilds `users`, copying
every row, then recreates the indexes.

Usage (run once, with the service stopped, after backing up the DB):

    CBANNOT_DATABASE_URI=sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db \\
        python3 deploy/migrate_oauth.py

It is idempotent: if `oauth_provider` already exists it reports "already
migrated" and exits without touching anything. It also writes a timestamped
<db>.bak-<epoch> copy next to the database before making changes.
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
    # Strip exactly "sqlite:///"; the remainder is the path. A fourth slash
    # (sqlite:////abs/path) is the leading "/" of an absolute path, so this
    # yields "/abs/path"; a three-slash URI yields a relative "rel/path".
    return uri[len(prefix):]


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
    oauth_provider  TEXT,
    oauth_sub       TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login      TIMESTAMP,
    UNIQUE (oauth_provider, oauth_sub)
)
"""


def main():
    uri = os.environ.get("CBANNOT_DATABASE_URI") \
        or "sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db"
    path = db_path_from_uri(uri)
    if not os.path.exists(path):
        sys.exit(f"database not found: {path}")

    conn = sqlite3.connect(path)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    if not cols:
        sys.exit("no 'users' table found — is this the right database?")
    if "oauth_provider" in cols:
        print(f"already migrated (users.oauth_provider exists): {path}")
        conn.close()
        return

    backup = f"{path}.bak-{int(time.time())}"
    shutil.copy2(path, backup)
    print(f"backed up {path} -> {backup}")

    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        with conn:  # transaction
            conn.execute(NEW_USERS)
            conn.execute(
                "INSERT INTO users_new "
                "(id, email, password_hash, display_name, email_verified, "
                " verify_token, reset_token, reset_expires, created_at, last_login) "
                "SELECT id, email, password_hash, display_name, email_verified, "
                " verify_token, reset_token, reset_expires, created_at, last_login "
                "FROM users"
            )
            conn.execute("DROP TABLE users")
            conn.execute("ALTER TABLE users_new RENAME TO users")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_oauth        ON users(oauth_provider, oauth_sub)")
        n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        print(f"migrated: users rebuilt with OAuth columns, {n} rows preserved")
    finally:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.close()


if __name__ == "__main__":
    main()

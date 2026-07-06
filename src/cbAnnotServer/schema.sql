-- cbAnnotServer schema
-- Used for fresh installs. The same shape is expressed via SQLAlchemy in models.py;
-- SQLAlchemy can create the tables directly with db.create_all(), so this file is
-- here for reference and for environments that prefer raw SQL bootstrap.

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    display_name    TEXT,
    email_verified  BOOLEAN NOT NULL DEFAULT 0,
    verify_token    TEXT,
    reset_token     TEXT,
    reset_expires   TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login      TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token);
CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token);

CREATE TABLE IF NOT EXISTS annotations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dataset_name    TEXT NOT NULL,
    data            TEXT NOT NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, dataset_name)
);

CREATE TABLE IF NOT EXISTS shared_annotations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    annotation_id   INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
    token           TEXT UNIQUE NOT NULL,
    label           TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS de_analyses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dataset_name    TEXT NOT NULL,
    label           TEXT NOT NULL,
    pop1_definition TEXT NOT NULL,
    pop2_definition TEXT NOT NULL,
    method          TEXT NOT NULL,
    parameters      TEXT,
    results         TEXT NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_de_user_dataset ON de_analyses(user_id, dataset_name);

CREATE TABLE IF NOT EXISTS shared_de_analyses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    de_analysis_id  INTEGER NOT NULL REFERENCES de_analyses(id) ON DELETE CASCADE,
    token           TEXT UNIQUE NOT NULL,
    label           TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

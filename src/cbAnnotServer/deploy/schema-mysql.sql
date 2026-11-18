-- cbAnnotServer tables for hgcentral (MySQL/MariaDB), RM #38664.
--
-- The service does not create tables on MySQL, so create these by hand once:
--     hgsql hgcentraltest < schema-mysql.sql
-- The service account then needs only SELECT, INSERT, UPDATE, DELETE on them.
--
-- Generated from models.py (SQLAlchemy's MariaDB dialect); keep the two in step.
-- InnoDB because the ON DELETE CASCADE foreign keys need it. utf8mb4_bin because
-- share tokens are case-sensitive and the server default charset is latin1.
-- MEDIUMTEXT (16 MB) holds the JSON blobs; TEXT would stop at 64 KB.

-- Accounts. email and password_hash are NULL for an account that signs in only
-- through Google/ORCID/etc. (see cbOauthIdentities).
CREATE TABLE IF NOT EXISTS `cbUsers` (
    id              INTEGER NOT NULL AUTO_INCREMENT,
    email           VARCHAR(255),
    password_hash   VARCHAR(255),
    display_name    VARCHAR(255),
    email_verified  BOOL NOT NULL,
    verify_token    VARCHAR(64),
    reset_token     VARCHAR(64),
    reset_expires   DATETIME,
    created_at      DATETIME NOT NULL,
    last_login      DATETIME,
    PRIMARY KEY (id),
    UNIQUE (email),
    INDEX `ix_cbUsers_reset_token` (reset_token),
    INDEX `ix_cbUsers_verify_token` (verify_token)
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

-- External sign-ins bound to an account, one row per (provider, subject).
CREATE TABLE IF NOT EXISTS `cbOauthIdentities` (
    id              INTEGER NOT NULL AUTO_INCREMENT,
    user_id         INTEGER NOT NULL,
    provider        VARCHAR(64) NOT NULL,
    subject         VARCHAR(255) NOT NULL,
    email           VARCHAR(255),
    display_name    VARCHAR(255),
    created_at      DATETIME NOT NULL,
    last_login      DATETIME,
    PRIMARY KEY (id),
    CONSTRAINT uq_identity_provider_subject UNIQUE (provider, subject),
    INDEX `ix_cbOauthIdentities_user_id` (user_id),
    FOREIGN KEY (user_id) REFERENCES `cbUsers` (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

-- A user's custom cell annotations, one row per user and dataset.
CREATE TABLE IF NOT EXISTS `cbAnnotations` (
    id              INTEGER NOT NULL AUTO_INCREMENT,
    user_id         INTEGER NOT NULL,
    dataset_name    VARCHAR(255) NOT NULL,
    data            MEDIUMTEXT NOT NULL,
    updated_at      DATETIME NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_annot_user_dataset UNIQUE (user_id, dataset_name),
    FOREIGN KEY (user_id) REFERENCES `cbUsers` (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

-- Share links for annotations.
CREATE TABLE IF NOT EXISTS `cbSharedAnnotations` (
    id              INTEGER NOT NULL AUTO_INCREMENT,
    annotation_id   INTEGER NOT NULL,
    token           VARCHAR(64) NOT NULL,
    label           VARCHAR(255),
    created_at      DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (token),
    FOREIGN KEY (annotation_id) REFERENCES `cbAnnotations` (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

-- Saved differential expression comparisons, with their results.
CREATE TABLE IF NOT EXISTS `cbDeAnalyses` (
    id              INTEGER NOT NULL AUTO_INCREMENT,
    user_id         INTEGER NOT NULL,
    dataset_name    VARCHAR(255) NOT NULL,
    label           VARCHAR(255) NOT NULL,
    pop1_definition MEDIUMTEXT NOT NULL,
    pop2_definition MEDIUMTEXT NOT NULL,
    method          VARCHAR(64) NOT NULL,
    parameters      MEDIUMTEXT,
    results         MEDIUMTEXT NOT NULL,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_de_user_dataset (user_id, dataset_name),
    FOREIGN KEY (user_id) REFERENCES `cbUsers` (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

-- Share links for saved comparisons.
CREATE TABLE IF NOT EXISTS `cbSharedDeAnalyses` (
    id              INTEGER NOT NULL AUTO_INCREMENT,
    de_analysis_id  INTEGER NOT NULL,
    token           VARCHAR(64) NOT NULL,
    label           VARCHAR(255),
    created_at      DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (token),
    FOREIGN KEY (de_analysis_id) REFERENCES `cbDeAnalyses` (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

"""
SQLAlchemy models. Schema matches deploy/schema-mysql.sql (the MySQL tables).

The `data` field on Annotation and the `results` field on DeAnalysis are stored
as JSON strings — kept opaque at the DB layer so the frontend can evolve the
shape without DB migrations.

In production the tables live in hgcentral (MySQL/MariaDB) next to the Genome
Browser's own tables, so every name starts with "cb" and is camelCase like the
rest of hgcentral. Column names keep their original snake_case.
"""
from datetime import datetime
from flask_login import UserMixin
from sqlalchemy.dialects import mysql

from extensions import db

# MySQL settings for every table. InnoDB: the ON DELETE CASCADE foreign keys need
# it (hgcentral's default engine is MyISAM). utf8mb4: the server default is
# latin1. utf8mb4_bin: share tokens are case-sensitive random strings, and a
# binary collation also keeps email matching exactly as it was under SQLite.
_MYSQL = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4",
          "mysql_collate": "utf8mb4_bin"}

# Saved annotations and DE results are JSON that can run to megabytes. MySQL's
# TEXT holds only 64 KB, so use MEDIUMTEXT (16 MB) there; SQLite's TEXT has no
# limit. config.MAX_CONTENT_LENGTH keeps a request below what fits.
LongText = db.Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")


class User(UserMixin, db.Model):
    __tablename__ = "cbUsers"
    __table_args__ = (_MYSQL,)
    # An account is identified by email+password, by one or more external OAuth
    # identities (see OAuthIdentity), or by both. Hence email and password_hash
    # are both nullable: an ORCID login may carry no email at all, and an
    # OAuth-only account has no local password.

    id              = db.Column(db.Integer, primary_key=True)
    email           = db.Column(db.String(255), unique=True)          # nullable: ORCID may not share one
    password_hash   = db.Column(db.String(255))                       # nullable: OAuth users have none
    display_name    = db.Column(db.String(255))
    email_verified  = db.Column(db.Boolean, nullable=False, default=False)
    verify_token    = db.Column(db.String(64), index=True)
    reset_token     = db.Column(db.String(64), index=True)
    reset_expires   = db.Column(db.DateTime)
    created_at      = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_login      = db.Column(db.DateTime)

    identities   = db.relationship("OAuthIdentity", backref="user", cascade="all, delete-orphan",
                                   order_by="OAuthIdentity.id")
    annotations  = db.relationship("Annotation",  backref="user", cascade="all, delete-orphan")
    de_analyses  = db.relationship("DeAnalysis",  backref="user", cascade="all, delete-orphan")

    def can_sign_in_without(self, identity):
        """Would this account still have a way to sign in if `identity` were
        unlinked? True if a usable password remains, or another identity does."""
        if self.password_hash and self.email:
            return True
        return any(i.id != identity.id for i in self.identities)


class OAuthIdentity(db.Model):
    """One external sign-in bound to a local account.

    A user may hold several: signing in through Google directly and through a
    broker such as CILogon produces two different (provider, subject) pairs for
    the same person, and without this table the second one would silently
    become a second, empty account. The linking flow in oauth.py attaches an
    extra identity to the account the user is already signed in to.

    `subject` is whichever claim the provider's conf entry names as stable
    (subject_claim, default "sub"): Google's "sub", the ORCID iD, or a
    federation's permanent subject-id. `email` and `display_name` are what that
    provider reported, kept per-identity because two providers may disagree.
    """
    __tablename__ = "cbOauthIdentities"
    __table_args__ = (
        db.UniqueConstraint("provider", "subject", name="uq_identity_provider_subject"),
        _MYSQL,
    )

    id           = db.Column(db.Integer, primary_key=True)
    user_id      = db.Column(db.Integer, db.ForeignKey("cbUsers.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    provider     = db.Column(db.String(64), nullable=False)   # conf-file slug
    subject      = db.Column(db.String(255), nullable=False)  # stable id at that provider
    email        = db.Column(db.String(255))                  # as reported, may be unverified
    display_name = db.Column(db.String(255))
    created_at   = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_login   = db.Column(db.DateTime)


class Annotation(db.Model):
    __tablename__ = "cbAnnotations"
    __table_args__ = (db.UniqueConstraint("user_id", "dataset_name",
                                          name="uq_annot_user_dataset"), _MYSQL)

    id           = db.Column(db.Integer, primary_key=True)
    user_id      = db.Column(db.Integer, db.ForeignKey("cbUsers.id", ondelete="CASCADE"), nullable=False)
    dataset_name = db.Column(db.String(255), nullable=False)
    data         = db.Column(LongText, nullable=False)   # JSON blob
    updated_at   = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    shares = db.relationship("SharedAnnotation", backref="annotation", cascade="all, delete-orphan")


class SharedAnnotation(db.Model):
    __tablename__ = "cbSharedAnnotations"
    __table_args__ = (_MYSQL,)

    id            = db.Column(db.Integer, primary_key=True)
    annotation_id = db.Column(db.Integer, db.ForeignKey("cbAnnotations.id", ondelete="CASCADE"), nullable=False)
    token         = db.Column(db.String(64), unique=True, nullable=False)
    label         = db.Column(db.String(255))
    created_at    = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


class DeAnalysis(db.Model):
    __tablename__ = "cbDeAnalyses"
    __table_args__ = (db.Index("idx_de_user_dataset", "user_id", "dataset_name"), _MYSQL)

    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey("cbUsers.id", ondelete="CASCADE"), nullable=False)
    dataset_name    = db.Column(db.String(255), nullable=False)
    label           = db.Column(db.String(255), nullable=False)
    pop1_definition = db.Column(LongText, nullable=False)  # JSON; may list cell ids
    pop2_definition = db.Column(LongText, nullable=False)  # JSON; may list cell ids
    method          = db.Column(db.String(64), nullable=False)
    parameters      = db.Column(LongText)                  # JSON
    results         = db.Column(LongText, nullable=False)   # JSON
    created_at      = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at      = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    shares = db.relationship("SharedDeAnalysis", backref="de_analysis", cascade="all, delete-orphan")


class SharedDeAnalysis(db.Model):
    __tablename__ = "cbSharedDeAnalyses"
    __table_args__ = (_MYSQL,)

    id             = db.Column(db.Integer, primary_key=True)
    de_analysis_id = db.Column(db.Integer, db.ForeignKey("cbDeAnalyses.id", ondelete="CASCADE"), nullable=False)
    token          = db.Column(db.String(64), unique=True, nullable=False)
    label          = db.Column(db.String(255))
    created_at     = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


# DE results are gzipped JSON. A result for ~20,000 genes is about 6 MB as
# JSON and well under 2 MB compressed, which keeps it far below MySQL's 16 MB
# packet limit. MEDIUMBLOB holds 16 MB; BLOB would stop at 64 KB.
LongBlob = db.LargeBinary().with_variant(mysql.MEDIUMBLOB(), "mysql", "mariadb")


class DeJob(db.Model):
    """The DE job queue. The web service (any web node) adds a row and reads it
    back for status; the worker (deWorker.py, one machine) takes queued rows in
    order, runs them, and writes progress and the result into the row. Nothing
    else connects the two, so they can be on different machines as long as both
    reach the database. deWorker.py uses this table through plain SQL (it does
    not import Flask); keep the two in step."""
    __tablename__ = "cbDeJobs"
    __table_args__ = (
        db.Index("idx_dejob_state", "state", "id"),
        db.Index("idx_dejob_requester", "requester", "state"),
        _MYSQL,
    )

    id               = db.Column(db.Integer, primary_key=True)
    job_id           = db.Column(db.String(32), unique=True, nullable=False)   # what the browser polls with
    state            = db.Column(db.String(16), nullable=False, default="queued")  # queued running done failed canceled
    requester        = db.Column(db.String(255), nullable=False)  # account email, else IP; the per-person limit
    remote           = db.Column(db.String(100))                  # client IP
    dataset          = db.Column(db.String(255), nullable=False)
    spec             = db.Column(LongText, nullable=False)        # worker spec JSON; may list cell ids
    cancel_requested = db.Column(db.Boolean, nullable=False, default=False)
    stage            = db.Column(db.String(255))
    step             = db.Column(db.Integer)
    n_steps          = db.Column(db.Integer)
    progress         = db.Column(db.Float)
    error            = db.Column(db.Text)
    result           = db.Column(LongBlob)                        # gzipped result JSON
    n_pop1           = db.Column(db.Integer)
    n_pop2           = db.Column(db.Integer)
    n_genes          = db.Column(db.Integer)
    elapsed          = db.Column(db.Float)                        # seconds the computation took
    worker           = db.Column(db.String(100))                  # host:pid that ran it
    created_at       = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    started_at       = db.Column(db.DateTime)
    finished_at      = db.Column(db.DateTime)

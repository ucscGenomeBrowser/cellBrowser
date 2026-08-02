"""
SQLAlchemy models. Schema matches schema.sql.

The `data` field on Annotation and the `results` field on DeAnalysis are stored
as JSON strings — kept opaque at the DB layer so the frontend can evolve the
shape without DB migrations.
"""
from datetime import datetime
from flask_login import UserMixin

from extensions import db


class User(UserMixin, db.Model):
    __tablename__ = "users"
    # An account is identified either by email+password or by an external OAuth
    # identity (Google / ORCID). Hence email and password_hash are both
    # nullable: an ORCID login may carry no email at all, and any OAuth login
    # has no local password. (oauth_provider, oauth_sub) uniquely names the
    # external identity when present.
    __table_args__ = (
        db.UniqueConstraint("oauth_provider", "oauth_sub", name="uq_user_oauth"),
    )

    id              = db.Column(db.Integer, primary_key=True)
    email           = db.Column(db.String(255), unique=True)          # nullable: ORCID may not share one
    password_hash   = db.Column(db.String(255))                       # nullable: OAuth users have none
    display_name    = db.Column(db.String(255))
    email_verified  = db.Column(db.Boolean, nullable=False, default=False)
    verify_token    = db.Column(db.String(64), index=True)
    reset_token     = db.Column(db.String(64), index=True)
    reset_expires   = db.Column(db.DateTime)
    # External identity provider, when the account was created via OAuth.
    # oauth_provider is a short slug ("google" / "orcid"); oauth_sub is the
    # provider's stable subject id (Google "sub" claim / the ORCID iD).
    oauth_provider  = db.Column(db.String(32), index=True)
    oauth_sub       = db.Column(db.String(255))
    created_at      = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_login      = db.Column(db.DateTime)

    annotations  = db.relationship("Annotation",  backref="user", cascade="all, delete-orphan")
    de_analyses  = db.relationship("DeAnalysis",  backref="user", cascade="all, delete-orphan")


class Annotation(db.Model):
    __tablename__ = "annotations"
    __table_args__ = (db.UniqueConstraint("user_id", "dataset_name"),)

    id           = db.Column(db.Integer, primary_key=True)
    user_id      = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    dataset_name = db.Column(db.String(255), nullable=False)
    data         = db.Column(db.Text, nullable=False)   # JSON blob
    updated_at   = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    shares = db.relationship("SharedAnnotation", backref="annotation", cascade="all, delete-orphan")


class SharedAnnotation(db.Model):
    __tablename__ = "shared_annotations"

    id            = db.Column(db.Integer, primary_key=True)
    annotation_id = db.Column(db.Integer, db.ForeignKey("annotations.id", ondelete="CASCADE"), nullable=False)
    token         = db.Column(db.String(64), unique=True, nullable=False)
    label         = db.Column(db.String(255))
    created_at    = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


class DeAnalysis(db.Model):
    __tablename__ = "de_analyses"
    __table_args__ = (db.Index("idx_de_user_dataset", "user_id", "dataset_name"),)

    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    dataset_name    = db.Column(db.String(255), nullable=False)
    label           = db.Column(db.String(255), nullable=False)
    pop1_definition = db.Column(db.Text, nullable=False)   # JSON
    pop2_definition = db.Column(db.Text, nullable=False)   # JSON
    method          = db.Column(db.String(64), nullable=False)
    parameters      = db.Column(db.Text)                   # JSON
    results         = db.Column(db.Text, nullable=False)   # JSON
    created_at      = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at      = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    shares = db.relationship("SharedDeAnalysis", backref="de_analysis", cascade="all, delete-orphan")


class SharedDeAnalysis(db.Model):
    __tablename__ = "shared_de_analyses"

    id             = db.Column(db.Integer, primary_key=True)
    de_analysis_id = db.Column(db.Integer, db.ForeignKey("de_analyses.id", ondelete="CASCADE"), nullable=False)
    token          = db.Column(db.String(64), unique=True, nullable=False)
    label          = db.Column(db.String(255))
    created_at     = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

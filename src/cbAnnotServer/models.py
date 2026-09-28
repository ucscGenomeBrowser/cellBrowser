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
    __tablename__ = "oauth_identities"
    __table_args__ = (
        db.UniqueConstraint("provider", "subject", name="uq_identity_provider_subject"),
    )

    id           = db.Column(db.Integer, primary_key=True)
    user_id      = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    provider     = db.Column(db.String(64), nullable=False)   # conf-file slug
    subject      = db.Column(db.String(255), nullable=False)  # stable id at that provider
    email        = db.Column(db.String(255))                  # as reported, may be unverified
    display_name = db.Column(db.String(255))
    created_at   = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_login   = db.Column(db.DateTime)


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

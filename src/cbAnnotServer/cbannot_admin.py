#!/usr/bin/env python3
"""
cbAnnotServer account admin — list, inspect, delete, and verify user accounts.

Runs against the same database the service uses (CBANNOT_DATABASE_URI, or the
default hive SQLite path). It goes through the Flask app + SQLAlchemy models, so
deleting a user also removes that user's annotations and DE analyses via the
model cascades — no orphaned rows.

Run with the service's virtualenv, e.g.:

    ./venv/bin/python3 cbannot_admin.py list
    ./venv/bin/python3 cbannot_admin.py show  mspeir+cbtest@ucsc.edu
    ./venv/bin/python3 cbannot_admin.py delete mspeir+cbtest@ucsc.edu       # prompts
    ./venv/bin/python3 cbannot_admin.py delete 5 --yes                      # no prompt
    ./venv/bin/python3 cbannot_admin.py verify bwick@ucsc.edu               # mark email verified
    ./venv/bin/python3 cbannot_admin.py identities                          # all linked OAuth sign-ins
    ./venv/bin/python3 cbannot_admin.py unlink 3                            # drop one linked sign-in

A user is named by either their numeric id or their email address. The service
can stay running; these are quick single-row transactions.
"""
import argparse
import sys

from app import create_app
from extensions import db
from models import User, Annotation, DeAnalysis, OAuthIdentity


def _resolve(identifier):
    """Look up a user by numeric id or email. Returns the User or None."""
    if identifier.isdigit():
        return db.session.get(User, int(identifier))
    return db.session.query(User).filter_by(email=identifier.strip().lower()).first()


def _counts(user):
    n_annot = db.session.query(Annotation).filter_by(user_id=user.id).count()
    n_de = db.session.query(DeAnalysis).filter_by(user_id=user.id).count()
    return n_annot, n_de


def _logins(user):
    """How this account can sign in: the password (if any) plus every linked
    external provider, e.g. "password+google+orcid"."""
    ways = []
    if user.password_hash and user.email:
        ways.append("password")
    ways.extend(i.provider for i in user.identities)
    return "+".join(ways) or "(none)"


def _describe(user):
    verified = "yes" if user.email_verified else "NO"
    n_annot, n_de = _counts(user)
    return (f"  id={user.id}  {user.email or '(no email)'}  "
            f"name={user.display_name or '-'}  login={_logins(user)}  "
            f"verified={verified}  annotations={n_annot}  de={n_de}  "
            f"created={user.created_at}")


def cmd_list(args):
    users = db.session.query(User).order_by(User.id).all()
    if not users:
        print("no users")
        return
    print(f"{len(users)} user(s):")
    for u in users:
        print(_describe(u))


def cmd_show(args):
    user = _resolve(args.user)
    if not user:
        sys.exit(f"no such user: {args.user}")
    print(_describe(user))
    for i in user.identities:
        print(f"    identity id={i.id}  provider={i.provider}  subject={i.subject}  "
              f"email={i.email or '-'}  last_login={i.last_login or '-'}")


def cmd_identities(args):
    """List every linked external sign-in, so a duplicate account created
    before identity linking existed can be spotted and merged by hand."""
    rows = db.session.query(OAuthIdentity).order_by(
        OAuthIdentity.provider, OAuthIdentity.id).all()
    if not rows:
        print("no linked external sign-ins")
        return
    print(f"{len(rows)} linked sign-in(s):")
    for i in rows:
        print(f"  id={i.id}  provider={i.provider}  subject={i.subject}  "
              f"user_id={i.user_id}  user={i.user.email or '(no email)'}  "
              f"email={i.email or '-'}  last_login={i.last_login or '-'}")


def cmd_unlink(args):
    """Remove one linked sign-in. Refuses to strand an account with no way in,
    the same rule the API enforces."""
    identity = db.session.get(OAuthIdentity, args.identity_id)
    if not identity:
        sys.exit(f"no such identity id: {args.identity_id}")
    user = identity.user
    if not user.can_sign_in_without(identity) and not args.force:
        sys.exit(f"identity {identity.id} is the only way in to user id={user.id} "
                 f"({user.email or 'no email'}) -- pass --force to unlink anyway")
    print(f"unlinking {identity.provider}/{identity.subject} from user id={user.id}")
    db.session.delete(identity)
    db.session.commit()
    print("done")


def cmd_delete(args):
    user = _resolve(args.user)
    if not user:
        sys.exit(f"no such user: {args.user}")
    n_annot, n_de = _counts(user)
    print("About to delete:")
    print(_describe(user))
    print(f"This also removes {n_annot} annotation set(s) and {n_de} DE analysis(es).")
    if not args.yes:
        reply = input("Type the user's email to confirm: ").strip()
        if reply != (user.email or ""):
            sys.exit("confirmation did not match — nothing deleted")
    db.session.delete(user)
    db.session.commit()
    print(f"deleted user id={user.id} ({user.email})")


def cmd_verify(args):
    user = _resolve(args.user)
    if not user:
        sys.exit(f"no such user: {args.user}")
    if user.email_verified:
        print(f"already verified: {user.email}")
        return
    user.email_verified = True
    user.verify_token = None
    db.session.commit()
    print(f"marked verified: {user.email}")


def main():
    p = argparse.ArgumentParser(description="cbAnnotServer account admin")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list all users").set_defaults(func=cmd_list)

    sp = sub.add_parser("show", help="show one user (by id or email)")
    sp.add_argument("user")
    sp.set_defaults(func=cmd_show)

    sp = sub.add_parser("delete", help="delete a user and their saved data")
    sp.add_argument("user")
    sp.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    sp.set_defaults(func=cmd_delete)

    sp = sub.add_parser("verify", help="manually mark a user's email verified")
    sp.add_argument("user")
    sp.set_defaults(func=cmd_verify)

    sub.add_parser("identities", help="list all linked external sign-ins"
                   ).set_defaults(func=cmd_identities)

    sp = sub.add_parser("unlink", help="remove one linked external sign-in (by identity id)")
    sp.add_argument("identity_id", type=int)
    sp.add_argument("--force", action="store_true",
                    help="unlink even if it is the account's only way to sign in")
    sp.set_defaults(func=cmd_unlink)

    args = p.parse_args()
    app = create_app()
    with app.app_context():
        args.func(args)


if __name__ == "__main__":
    main()

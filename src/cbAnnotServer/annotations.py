"""
Annotation endpoints — load, save/overwrite, share, and load-by-share-token.

Annotations are scoped per (user, dataset). The `data` field is the same JSON
the frontend already serializes for localStorage; it is stored opaquely as a
JSON string so the frontend shape can evolve without DB migrations.

Save/load use a {"data": <obj>} envelope so the two directions are symmetric.

Routes (registered under /api/annotations):
    GET    /<dataset>          login required   load this user's annotations
    POST   /<dataset>          login required   save / overwrite
    POST   /<dataset>/share    login required   get-or-create a public share token
    GET    /shared/<token>     public           load a shared annotation set
"""
import json
import secrets

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_required

from extensions import db
from models import Annotation, SharedAnnotation

annotations_bp = Blueprint("annotations", __name__)


def _bad(msg, status=400):
    return jsonify({"error": msg}), status


def _ok(**extra):
    return jsonify({"ok": True, **extra})


def _new_token():
    return secrets.token_urlsafe(32)


def _find(dataset):
    """The current user's annotation row for a dataset, or None."""
    return (
        db.session.query(Annotation)
        .filter_by(user_id=current_user.id, dataset_name=dataset)
        .first()
    )


# ---------- load ----------

@annotations_bp.get("/shared/<token>")
def load_shared(token):
    # Public — anyone with the token can read. No auth.
    share = db.session.query(SharedAnnotation).filter_by(token=token).first()
    if not share:
        return _bad("invalid or unknown share token", status=404)
    annot = share.annotation
    return _ok(
        dataset=annot.dataset_name,
        label=share.label,
        data=json.loads(annot.data),
    )


@annotations_bp.get("/<path:dataset>")
@login_required
def load(dataset):
    annot = _find(dataset)
    if not annot:
        return _ok(data=None)
    return _ok(data=json.loads(annot.data), updated_at=annot.updated_at.isoformat())


# ---------- save / overwrite ----------

@annotations_bp.post("/<path:dataset>")
@login_required
def save(dataset):
    body = request.get_json(silent=True)
    if body is None or "data" not in body:
        return _bad('request body must be a JSON object with a "data" field')

    # Re-serialize so what we store is canonical JSON, not whatever bytes arrived.
    payload = json.dumps(body["data"])

    annot = _find(dataset)
    if annot:
        annot.data = payload
    else:
        annot = Annotation(user_id=current_user.id, dataset_name=dataset, data=payload)
        db.session.add(annot)
    db.session.commit()
    return _ok(updated_at=annot.updated_at.isoformat())


# ---------- share ----------

@annotations_bp.post("/<path:dataset>/share")
@login_required
def share(dataset):
    annot = _find(dataset)
    if not annot:
        return _bad("nothing to share — no saved annotations for this dataset", status=404)

    data = request.get_json(silent=True) or {}
    label = (data.get("label") or "").strip() or None

    # One share per annotation: reuse the existing token if there is one so the
    # same URL keeps working, and pick up a newly-provided label.
    existing = db.session.query(SharedAnnotation).filter_by(annotation_id=annot.id).first()
    if existing:
        if label is not None:
            existing.label = label
            db.session.commit()
        share_row = existing
    else:
        share_row = SharedAnnotation(annotation_id=annot.id, token=_new_token(), label=label)
        db.session.add(share_row)
        db.session.commit()

    base = current_app.config["SITE_BASE_URL"].rstrip("/")
    return _ok(
        token=share_row.token,
        label=share_row.label,
        url=f"{base}/api/annotations/shared/{share_row.token}",
    )

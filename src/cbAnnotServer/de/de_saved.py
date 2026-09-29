"""
Saved differential-expression comparisons — save, list, load, delete, share.

The account-facing half of DE (Redmine #24912). Distinct from de_submit.py, which
is the compute submit/poll seam: this persists a *comparison* so a logged-in user
can reopen or share it later. Mirrors annotations.py (per-user rows, opaque JSON
blobs, a share token) but a user has a LIST of comparisons per dataset, not one.

What is stored (see redmineNotes/24912/claude/de-save-design.md): the recipe, not
the 12 MB gene table — the two population selectors, the method + parameters, and a
small cached significant-gene subset (gzipped client-side) for an instant preview.
On reload the frontend re-submits pop1/pop2/method/parameters to /api/de for the
full interactive result. The blobs are stored opaquely, so the client shape can
evolve without a DB migration.

Routes (registered under /api/de/saved):
    GET    /<dataset>            login   list this user's comparisons (metadata only)
    POST   /<dataset>            login   create one
    GET    /item/<id>            login   full comparison incl. cached results (owner)
    DELETE /item/<id>            login   delete (owner)
    POST   /item/<id>/share      login   get-or-create a public share token (owner)
    GET    /shared/<token>       public  load a shared comparison
"""
import json
import secrets

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_required

from extensions import db
from models import DeAnalysis, SharedDeAnalysis

bp = Blueprint("de_saved", __name__)


def _bad(msg, status=400):
    return jsonify({"error": msg}), status


def _ok(**extra):
    return jsonify({"ok": True, **extra})


def _new_token():
    return secrets.token_urlsafe(32)


def _own(analysis_id):
    """The current user's comparison by id, or None (also blocks other users')."""
    return (
        db.session.query(DeAnalysis)
        .filter_by(id=analysis_id, user_id=current_user.id)
        .first()
    )


def _meta(a):
    """Lightweight row for the list — no blobs."""
    return {
        "id": a.id,
        "label": a.label,
        "dataset": a.dataset_name,
        "method": a.method,
        "created_at": a.created_at.isoformat(),
        "updated_at": a.updated_at.isoformat(),
    }


def _full(a):
    """Full row incl. the population definitions, parameters, and cached results."""
    return {
        **_meta(a),
        "pop1": json.loads(a.pop1_definition),
        "pop2": json.loads(a.pop2_definition),
        "parameters": json.loads(a.parameters) if a.parameters else None,
        "results": json.loads(a.results) if a.results else None,
    }


# ---------- list / create ----------

@bp.get("/<path:dataset>")
@login_required
def list_saved(dataset):
    rows = (
        db.session.query(DeAnalysis)
        .filter_by(user_id=current_user.id, dataset_name=dataset)
        .order_by(DeAnalysis.updated_at.desc())
        .all()
    )
    return _ok(items=[_meta(a) for a in rows])


@bp.post("/<path:dataset>")
@login_required
def create(dataset):
    body = request.get_json(silent=True) or {}
    for key in ("pop1", "pop2", "method"):
        if key not in body:
            return _bad('missing required field "%s"' % key)

    label = (body.get("label") or "").strip() or "Untitled comparison"
    analysis = DeAnalysis(
        user_id=current_user.id,
        dataset_name=dataset,
        label=label[:255],
        pop1_definition=json.dumps(body["pop1"]),
        pop2_definition=json.dumps(body["pop2"]),
        method=str(body["method"])[:64],
        parameters=json.dumps(body.get("parameters")),
        results=json.dumps(body.get("results")),   # NOT NULL — "null" if absent
    )
    db.session.add(analysis)
    db.session.commit()
    return _ok(id=analysis.id, updated_at=analysis.updated_at.isoformat())


# ---------- get / delete one ----------

@bp.get("/item/<int:analysis_id>")
@login_required
def get_item(analysis_id):
    a = _own(analysis_id)
    if not a:
        return _bad("no such saved comparison", status=404)
    return _ok(item=_full(a))


@bp.delete("/item/<int:analysis_id>")
@login_required
def delete_item(analysis_id):
    a = _own(analysis_id)
    if not a:
        return _bad("no such saved comparison", status=404)
    db.session.delete(a)
    db.session.commit()
    return _ok()


# ---------- share ----------

@bp.post("/item/<int:analysis_id>/share")
@login_required
def share_item(analysis_id):
    a = _own(analysis_id)
    if not a:
        return _bad("no such saved comparison", status=404)

    data = request.get_json(silent=True) or {}
    label = (data.get("label") or "").strip() or None

    # One share per comparison: reuse the token so the URL stays stable, and pick
    # up a newly-provided label.
    existing = (
        db.session.query(SharedDeAnalysis)
        .filter_by(de_analysis_id=a.id)
        .first()
    )
    if existing:
        if label is not None:
            existing.label = label
            db.session.commit()
        share_row = existing
    else:
        share_row = SharedDeAnalysis(de_analysis_id=a.id, token=_new_token(), label=label)
        db.session.add(share_row)
        db.session.commit()

    base = current_app.config["SITE_BASE_URL"].rstrip("/")
    return _ok(
        token=share_row.token,
        label=share_row.label,
        url=f"{base}/api/de/saved/shared/{share_row.token}",
    )


# ---------- public shared read ----------

@bp.get("/shared/<token>")
def load_shared(token):
    share = db.session.query(SharedDeAnalysis).filter_by(token=token).first()
    if not share:
        return _bad("invalid or unknown share token", status=404)
    a = share.de_analysis
    return _ok(label=share.label or a.label, item=_full(a))

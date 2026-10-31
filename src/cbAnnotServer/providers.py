"""
Sign-in provider configuration.

Every external sign-in provider the Cell Browser supports is an OpenID Connect
identity provider, so none of them needs its own code: a provider is fully
described by a discovery URL, a client id/secret, a scope, and a couple of
policy flags. This module turns that description into a list of ProviderSpec
records; oauth.py registers whatever it finds.

Providers are read from a server-side conf file (NOT the frontend's cb.conf,
which is fetched by the browser and therefore public — client secrets must
never go there). The path comes from CBANNOT_PROVIDERS_CONF and defaults to
providers.conf next to the SQLite database on /hive.

    [provider:cilogon]
    client_id     = cilogon:/client_id/1234abcd
    client_secret = ...

That is a complete entry: "cilogon" is one of the presets in KNOWN_PROVIDERS
below, which supplies the discovery URL, scope, and button label. A provider
that is not a preset just supplies its own discovery URL:

    [provider:example]
    label         = Sign in with Example
    discovery     = https://id.example.org/.well-known/openid-configuration
    client_id     = ...
    client_secret = ...
    scope         = openid email profile

Recognised keys, all optional except where noted:

    label          button text (default: "Sign in with <Slug>")
    discovery      OIDC discovery document URL (required if not a preset)
    client_id      required
    client_secret  required
    scope          space-separated OAuth scopes
    subject_claim  claim holding the stable per-user id (default "sub").
                   Campus IdPs reached through a broker sometimes reuse
                   eduPersonPrincipalName when a person leaves, so an
                   institutional provider should point this at a claim the
                   federation guarantees is permanent, e.g. "subject-id"
                   or "eduPersonUniqueId".
    trust_email    "yes" to let a verified email from this provider link the
                   login onto an existing account (default "no" — see
                   oauth._find_or_create). Turn this on only for a provider
                   that actually verifies addresses and asserts email_verified.
    enabled        "no" to keep an entry in the file but switch it off.

Legacy: the CBANNOT_GOOGLE_* / CBANNOT_ORCID_* environment variables from the
first OAuth release still work. They are folded in as if they were conf-file
entries, so an existing deployment keeps running untouched. A conf-file entry
for the same slug wins.
"""
import configparser
import os
import stat


class ProviderSpec:
    """One configured sign-in provider."""

    def __init__(self, slug, label, discovery, client_id, client_secret,
                 scope, subject_claim, trust_email):
        self.slug = slug
        self.label = label
        self.discovery = discovery
        self.client_id = client_id
        self.client_secret = client_secret
        self.scope = scope
        self.subject_claim = subject_claim
        self.trust_email = trust_email

    def __repr__(self):
        return "<ProviderSpec %s>" % self.slug


# Presets for the providers we expect people to use, so a conf-file entry only
# has to carry the credentials. "trust_email" is deliberately off everywhere
# except Google: linking an OAuth login onto an existing account by email
# address is only safe from an issuer that genuinely verifies addresses.
KNOWN_PROVIDERS = {
    "google": {
        "label": "Sign in with Google",
        "discovery": "https://accounts.google.com/.well-known/openid-configuration",
        "scope": "openid email profile",
        "trust_email": True,
    },
    "orcid": {
        "label": "Sign in with ORCID",
        "discovery": "https://orcid.org/.well-known/openid-configuration",
        # ORCID's "openid" scope yields the ORCID iD (sub) and the person's
        # name. Email comes back only when the user has made it public.
        "scope": "openid",
        "trust_email": False,
    },
    "orcid-sandbox": {
        "label": "Sign in with ORCID (sandbox)",
        "discovery": "https://sandbox.orcid.org/.well-known/openid-configuration",
        "scope": "openid",
        "trust_email": False,
    },
    # CILogon is an OIDC broker in front of InCommon / eduGAIN (thousands of
    # campus IdPs) plus ORCID, Google and Microsoft. It is how this service
    # gets institutional ("Sign in with your university") login without
    # becoming a SAML service provider itself.
    "cilogon": {
        "label": "Sign in with your institution",
        "discovery": "https://cilogon.org/.well-known/openid-configuration",
        "scope": "openid email profile org.cilogon.userinfo",
        "trust_email": False,
    },
    "globus": {
        "label": "Sign in with Globus",
        "discovery": "https://auth.globus.org/.well-known/openid-configuration",
        "scope": "openid email profile",
        "trust_email": False,
    },
    "microsoft": {
        "label": "Sign in with Microsoft",
        "discovery": "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
        "scope": "openid email profile",
        "trust_email": False,
    },
}

SECTION_PREFIX = "provider:"

_TRUE = ("1", "yes", "y", "true", "on")


def _as_bool(val, default=False):
    if val is None:
        return default
    return str(val).strip().lower() in _TRUE


def default_conf_path():
    """Where the provider conf file lives unless CBANNOT_PROVIDERS_CONF says
    otherwise: next to the database, on /hive, off the web tree."""
    return os.environ.get(
        "CBANNOT_PROVIDERS_CONF",
        "/hive/data/inside/cells/cbAnnotServer/providers.conf")


def _spec_from(slug, values, warn):
    """Build a ProviderSpec from a preset plus a dict of conf-file overrides.
    Returns None (after warning) if the entry is incomplete."""
    preset = KNOWN_PROVIDERS.get(slug, {})

    if not _as_bool(values.get("enabled"), default=True):
        return None

    client_id = (values.get("client_id") or "").strip()
    client_secret = (values.get("client_secret") or "").strip()
    if not client_id or not client_secret:
        # Not an error: this is how a provider ships dormant. Silently skip.
        return None

    discovery = (values.get("discovery") or preset.get("discovery") or "").strip()
    if not discovery:
        warn("sign-in provider %r has no 'discovery' URL and is not one of the "
             "known providers (%s) — skipping",
             slug, ", ".join(sorted(KNOWN_PROVIDERS)))
        return None

    return ProviderSpec(
        slug=slug,
        label=(values.get("label") or preset.get("label")
               or "Sign in with %s" % slug.capitalize()).strip(),
        discovery=discovery,
        client_id=client_id,
        client_secret=client_secret,
        scope=(values.get("scope") or preset.get("scope")
               or "openid email profile").strip(),
        subject_claim=(values.get("subject_claim") or "sub").strip(),
        trust_email=_as_bool(values.get("trust_email"),
                             default=preset.get("trust_email", False)),
    )


def _legacy_env_entries():
    """The pre-conf-file environment variables, as conf-file-shaped dicts.

    Returns {slug: {key: value}} for whichever of Google / ORCID has both
    CBANNOT_*_CLIENT_ID and CBANNOT_*_CLIENT_SECRET set."""
    out = {}
    gid = os.environ.get("CBANNOT_GOOGLE_CLIENT_ID", "").strip()
    gsec = os.environ.get("CBANNOT_GOOGLE_CLIENT_SECRET", "").strip()
    if gid and gsec:
        out["google"] = {"client_id": gid, "client_secret": gsec}

    oid = os.environ.get("CBANNOT_ORCID_CLIENT_ID", "").strip()
    osec = os.environ.get("CBANNOT_ORCID_CLIENT_SECRET", "").strip()
    if oid and osec:
        # CBANNOT_ORCID_ENV=sandbox selected sandbox.orcid.org, which is now a
        # separate preset slug. Keep the old spelling working, but keep the
        # user-visible slug "orcid" so existing oauth_identities rows still match.
        sandbox = os.environ.get("CBANNOT_ORCID_ENV", "production").strip().lower() == "sandbox"
        entry = {"client_id": oid, "client_secret": osec}
        if sandbox:
            entry["discovery"] = KNOWN_PROVIDERS["orcid-sandbox"]["discovery"]
            entry["label"] = KNOWN_PROVIDERS["orcid-sandbox"]["label"]
        out["orcid"] = entry
    return out


def load_providers(path=None, warn=None):
    """Read the provider conf file (if any), fold in the legacy env vars, and
    return a list of ProviderSpec in file order.

    `warn` is a logger-style callable (msg, *args); defaults to no-op so this
    can be called outside an app context.
    """
    if warn is None:
        def warn(*_a, **_k):
            pass
    path = path or default_conf_path()

    entries = _legacy_env_entries()      # conf file wins over these
    order = list(entries)

    if os.path.exists(path):
        # A conf file holding client secrets should not be group- or
        # world-readable. Warn rather than refuse: an operator mid-setup
        # should not have the service fail to boot over a permission bit.
        mode = os.stat(path).st_mode
        if mode & (stat.S_IRGRP | stat.S_IROTH):
            warn("sign-in provider conf %s is group/world readable "
                 "(mode %o) — it holds client secrets, chmod 600 it", path, mode & 0o777)

        # interpolation=None: a client secret may legitimately contain "%".
        cp = configparser.ConfigParser(interpolation=None)
        try:
            cp.read(path, encoding="utf-8")
        except configparser.Error as e:
            warn("could not parse sign-in provider conf %s: %s — no OAuth providers configured", path, e)
            return []
        for section in cp.sections():
            if not section.startswith(SECTION_PREFIX):
                continue
            slug = section[len(SECTION_PREFIX):].strip().lower()
            if not slug:
                continue
            if slug in entries:
                entries[slug].update(dict(cp[section]))    # override the env-var defaults
            else:
                entries[slug] = dict(cp[section])
                order.append(slug)

    specs = []
    for slug in order:
        spec = _spec_from(slug, entries[slug], warn)
        if spec is not None:
            specs.append(spec)
    return specs

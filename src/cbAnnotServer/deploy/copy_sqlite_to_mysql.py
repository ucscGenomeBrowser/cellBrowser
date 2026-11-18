#!/usr/bin/env python3
"""
Copy the cbAnnotServer SQLite database into the MySQL tables (RM #38664).

The target is CBANNOT_DATABASE_URI (mysql+pymysql://...), the same setting the
service uses, and its tables must already exist (schema-mysql.sql) and be empty.
The SQLite file is opened read-only, so the old service can keep running while
this copies. Row ids are kept, so share links stay the same. Everything goes in
one transaction: on any error nothing is written.

    CBANNOT_DATABASE_URI='mysql+pymysql://USER:PW@HOST/hgcentraltest?charset=utf8mb4' \\
        ../venv/bin/python copy_sqlite_to_mysql.py /path/to/cbAnnot.db

Reads either the original table names (users, annotations, ...) or the cb names.
"""
import os
import sys

from sqlalchemy import MetaData, Table, create_engine, func, inspect, select

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# target table <- source table, parents before children (foreign keys)
TABLES = [("cbUsers", "users"),
          ("cbOauthIdentities", "oauth_identities"),
          ("cbAnnotations", "annotations"),
          ("cbSharedAnnotations", "shared_annotations"),
          ("cbDeAnalyses", "de_analyses"),
          ("cbSharedDeAnalyses", "shared_de_analyses")]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    srcPath = sys.argv[1]
    if not os.path.isfile(srcPath):
        sys.exit("no such file: %s" % srcPath)
    uri = os.environ.get("CBANNOT_DATABASE_URI", "")
    if not uri.startswith("mysql"):
        sys.exit("set CBANNOT_DATABASE_URI to the mysql+pymysql:// target")

    from app import create_app      # checks the target tables exist
    from extensions import db

    src = create_engine("sqlite:///file:%s?mode=ro&uri=true" % srcPath)
    srcTables = set(inspect(src).get_table_names())
    srcMeta = MetaData()

    app = create_app()
    with app.app_context():
        dst = db.metadata.tables
        with db.engine.begin() as conn:
            for dstName, oldName in TABLES:
                n = conn.execute(select(func.count()).select_from(dst[dstName])).scalar()
                if n:
                    sys.exit("%s already has %d rows; this only copies into empty tables"
                             % (dstName, n))
            for dstName, oldName in TABLES:
                srcName = dstName if dstName in srcTables else oldName
                if srcName not in srcTables:
                    print("%-20s not in the SQLite file, skipped" % dstName)
                    continue
                st = Table(srcName, srcMeta, autoload_with=src)
                dt = dst[dstName]
                cols = [c for c in dt.columns.keys() if c in st.columns]
                dropped = sorted(set(st.columns.keys()) - set(cols))
                with src.connect() as sc:
                    rows = [dict(r._mapping) for r in
                            sc.execute(select(*[st.c[c] for c in cols]).order_by(st.c.id))]
                if rows:
                    conn.execute(dt.insert(), rows)
                got = conn.execute(select(func.count()).select_from(dt)).scalar()
                print("%-20s %5d rows from %s%s" % (dstName, got, srcName,
                      ("  (not copied: %s)" % ", ".join(dropped)) if dropped else ""))
                if got != len(rows):
                    raise RuntimeError("%s: copied %d of %d rows" % (dstName, got, len(rows)))
    print("done")


if __name__ == "__main__":
    main()

This directory is for UCSC-specific tools. Paths are hardcoded and these are unlikely to work 
anywhere else than on our internal compute systems.

## Scripts run by otto's crontab

updateNewsSec, cbPingHidden and tabulate_facets.pl run from otto's crontab
(kent/src/hg/utils/otto/otto.crontab). Cron runs an installed copy in
/hive/data/inside/cells/scripts, not anyone's checkout. To change what cron runs,
commit and push the fix, then run this in your checkout's ucsc/ directory:

    make install

It refuses uncommitted changes or a commit that is not on
origin/develop, and writes the installed commit to INSTALLED.txt in that
directory. `make validate` lists any installed script that differs from your
checkout. Never edit the installed copies in place.

cbCheckInstalled, also installed there, runs weekdays from otto's crontab and
mails cells@ when an installed script differs from develop on GitHub or was
edited in place.

That directory is for otto only. Keep running these scripts from your own
checkout, and do not put the shared directory on your PATH.

## The login/annotation/DE server

otto also runs the Cell Browser server in src/cbAnnotServer: gunicorn on
hgwdev (login, custom annotations, the DE API) and the DE worker on
hgcompute-08. Both run from /cluster/home/otto/cellsServer, which only otto
can write. It holds the installed code, the two pythons (venv for the server,
deenv for the DE worker), settings (etc/), the database (db/), the DE job
queue (deJobs/) and logs. Only the DE download cache is elsewhere, on /hive.

To change what they run, commit and push, then in your checkout:

    git fetch
    cd ucsc
    sudo -u otto make install-annot

and restart both with the commands it prints. otto can't write to your
checkout, so the fetch has to be yours. `sudo -u otto make setup-annot` creates
the directory and builds both pythons; run it once, and again after changing
either requirements.txt. `make validate-annot` lists any difference from your
checkout, and cbCheckInstalled checks this copy against develop too.

Settings, database and job queue are readable only by otto: the settings hold
the session key, and the database holds password hashes. Code and logs are
group-readable.

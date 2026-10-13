This directory is for UCSC-specific tools. Paths are hardcoded and these are unlikely to work 
anywhere else than on our internal compute systems.

## Scripts run by otto's crontab

updateNewsSec, cbPingHidden and tabulate_facets.pl run from otto's crontab
(kent/src/hg/utils/otto/otto.crontab). Cron runs an installed copy in
/hive/data/inside/cells/scripts, not anyone's checkout. To change what cron runs,
commit and push the fix, then:

    make -C ucsc install

`make install` refuses uncommitted changes or a commit that is not on
origin/develop, and writes the installed commit to INSTALLED.txt in that
directory. `make validate` lists any installed script that differs from your
checkout. Never edit the installed copies in place.

That directory is for otto only. Keep running these scripts from your own
checkout, and do not put the shared directory on your PATH.

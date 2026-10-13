# Install the scripts that otto's crontab runs to a shared location, so cron
# runs a committed, identifiable copy instead of someone's working tree.
# (RM #38523)
#
# This copy is for otto only. Developers keep running from their own checkout;
# never put PREFIX on an interactive PATH, and never edit files there in place.
#
#   make setup      once: create PREFIX and its python venv
#   make install    copy SCRIPTS to PREFIX and record the commit in INSTALLED.txt
#   make validate   report any difference between PREFIX and this checkout
#
# After fixing one of these scripts: commit, push, then "make install". A push
# alone does not change what cron runs.

PREFIX = /hive/data/inside/cells/scripts
SCRIPTS = updateNewsSec cbPingHidden tabulate_facets.pl
GROUP = genecats
# the venv is built from the system python, never from whatever conda is on PATH
SYSPYTHON = /usr/bin/python3

install: check-prefix check-clean
	umask 002; for s in ${SCRIPTS}; do install -m 775 $$s ${PREFIX}/$$s; done
	umask 002; ( echo "commit `git rev-parse HEAD`"; \
	  echo "installed `date '+%Y-%m-%d %H:%M'` by $${USER}"; \
	  md5sum ${SCRIPTS} ) > ${PREFIX}/INSTALLED.txt
	@cat ${PREFIX}/INSTALLED.txt

validate: check-prefix
	@status=0; for s in ${SCRIPTS}; do \
	  diff -q ${PREFIX}/$$s $$s > /dev/null || { echo "differs: ${PREFIX}/$$s"; status=1; }; \
	done; exit $$status

setup:
	umask 002; mkdir -p ${PREFIX}
	chgrp ${GROUP} ${PREFIX}
	chmod 2775 ${PREFIX}
	umask 002; ${SYSPYTHON} -m venv ${PREFIX}/env
	umask 002; ${PREFIX}/env/bin/pip install -q -r requirements.txt

# refuse a dirty tree, and a commit nobody else can see
check-clean:
	@git diff --quiet HEAD -- ${SCRIPTS} || \
	  { echo "uncommitted changes to ${SCRIPTS}; commit before installing"; exit 1; }
	@git fetch -q origin && git merge-base --is-ancestor HEAD origin/develop || \
	  { echo "HEAD is not on origin/develop; push before installing"; exit 1; }

check-prefix:
	@test -x ${PREFIX}/env/bin/python3 || { echo "${PREFIX} is not set up; run 'make setup' once first"; exit 1; }

.PHONY: install validate setup check-clean check-prefix

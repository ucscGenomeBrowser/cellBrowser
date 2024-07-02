#!/usr/bin/env bash
# File: extract_facet_values_from_test.sh by Marc Perry
# 
# INPUT: hard coded in script commands
# OUTPUT: 8 two-column TSV files, names are hard coded in script
# 
# There are no headers on the output tables.  The first column is the count (frequency)
# of the number of times the string (term, or facet, or tag) in the second column was
# found in the dataset.json file.  The tables are sorted by the first column, from
# lowest to highest frequency.
# 
# Usage (assumes that you have used chmod ugo+x to make this file executable):
# /path/to/script/extract_facet_values_from_test.sh
# 
# Last Updated: 2024-05-31, Status: working production script
set -beEu -o pipefail



cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.assays[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_assays_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.body_parts[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_body_parts_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.diseases[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_diseases_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.domains[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_domains_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.life_stages[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_life_stages_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.organisms[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_organisms_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.projects[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_projects_values.tsv
cat /usr/local/apache/htdocs-cells/dataset.json | jq '.datasets[]' | jq -r '.sources[]?' | sort | uniq -c | sort -n | perl -pe 's/^\s+(\d+) /$1\t/' > tallies_of_sources_values.tsv


#!/bin/bash
# Publish all-tracks hub + unpublished track files under htdocs-cells (cells-test).
# Skips excluded assemblies (hub_config.json exclude_assemblies).
set -euo pipefail

ln -sfn /hive/data/inside/cells/all-tracks-hub /usr/local/apache/htdocs-cells/all-tracks-hub

# extra_collections track sources (served at their datasets-relative path): one
# directory symlink per top-level source dir publishes all of their track files.
ln -sfn /hive/data/inside/cells/datasets/catlas-decoder /usr/local/apache/htdocs-cells/catlas-decoder
ln -sfn /hive/data/inside/cells/datasets/allen-brain-science /usr/local/apache/htdocs-cells/allen-brain-science

mkdir -p "/usr/local/apache/htdocs-cells/neuro-degen-atac"
ln -sf "/hive/data/inside/cells/datasets/neuro-degen-atac/peaks.bb" "/usr/local/apache/htdocs-cells/neuro-degen-atac/peaks.bb"
mkdir -p "/usr/local/apache/htdocs-cells/tabula-sapiens/all/v1_2021-04-21/gb_wrangling/barCharts"
ln -sf "/hive/data/inside/cells/datasets/tabula-sapiens/all/v1_2021-04-21/gb_wrangling/barCharts/annotation.barChart.bb" "/usr/local/apache/htdocs-cells/tabula-sapiens/all/v1_2021-04-21/gb_wrangling/barCharts/annotation.barChart.bb"
ln -sf "/hive/data/inside/cells/datasets/tabula-sapiens/all/v1_2021-04-21/gb_wrangling/barCharts/organ.barChart.bb" "/usr/local/apache/htdocs-cells/tabula-sapiens/all/v1_2021-04-21/gb_wrangling/barCharts/organ.barChart.bb"
mkdir -p "/usr/local/apache/htdocs-cells/mouse-dev-brain/hub_out"
ln -sf "/hive/data/inside/cells/datasets/mouse-dev-brain/hub_out/barChart.bb" "/usr/local/apache/htdocs-cells/mouse-dev-brain/hub_out/barChart.bb"
mkdir -p "/usr/local/apache/htdocs-cells/mouse-epi-juv-brain/h3k27me3"
ln -sf "/hive/data/inside/cells/datasets/mouse-epi-juv-brain/h3k27me3/GeneCaRNA_lncRNA_genes.bb" "/usr/local/apache/htdocs-cells/mouse-epi-juv-brain/h3k27me3/GeneCaRNA_lncRNA_genes.bb"

echo "published hub + 5 files"

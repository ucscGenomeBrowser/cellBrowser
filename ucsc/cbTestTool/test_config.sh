# test_config.sh — local path overrides for test_cb_tools.sh
#
# This file is sourced by test_cb_tools.sh before any tests run.
# Set any variables here to override the script's built-in defaults.
# This file is never run directly.
#
# Available variables:
#   CONDA_BASE    - path to your miniconda/anaconda install
#   DATA_DIR      - directory containing the input test files (sets all file
#                   paths below to DATA_DIR/<filename> if you only change one)
#   SCANPY_H5AD   - full path to the .h5ad input file
#   SCANPY_EXPR   - full path to the expression matrix (.tsv.gz)
#   SCANPY_META   - full path to the metadata (.tsv)
#   SEURAT_RDS    - full path to the Seurat .rds file

CONDA_BASE="/cluster/home/${USER}/miniconda3"

DATA_DIR="/hive/data/inside/cells/datasets/"
export SCANPY_H5AD="${DATA_DIR}/hackney-retina-atlas/orig/myeloid.h5ad"
export SCANPY_EXPR="${DATA_DIR}/tabula-muris-senis/facs/bat/exprMatrix.tsv.gz"
export SCANPY_META="${DATA_DIR}/tabula-muris-senis/facs/bat/meta.tsv"
export SEURAT_RDS="${DATA_DIR}/adult-mouse-brain-newborn/orig/Seu_RNA_neurogenesis.rds"

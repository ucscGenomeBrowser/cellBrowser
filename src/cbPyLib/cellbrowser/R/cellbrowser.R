# Build a UCSC cell browser website from a \code{Seurat} object
#
NULL
#' used by ExportToCellbrowser:
#' Return a matrix object from a Seurat object or show an error message
#'
#' @param object Seurat object
#' @param slotNames vector with the names of the slots to export
#' @return a list with filename prefix -> matrix object. prefix usually is "scale_data" or "counts"
#'
findMatrices = function(object, slotNames ) {
  slotMatrices = list()
  slots <- list()
  for (slotName in slotNames) {
      mat <- GetAssayData(object = object, slot = slotName)
      if (slotName == "scale.data")
          slotName <- "scale" #  dots in filenames are not good
      # do not use any prefixes if we export just a single matrix (stay compatible with old code)
      # empty string didn't work with R names(), so using special value "###" now
      if (length(slotNames)==1)
         slotName <- "###"
      slotMatrices [[slotName]] <- mat
  }
  return(slotMatrices)
}

#' used by ExportToCellbrowser:
#' Write a matrix to a file, as either as .tsv.gz or .mtx.gz+barcodes+genes
#' Filename is exprMatrix<suffix>.tsv.gz
#'
#' @param counts The matrix, usually a sparse matrix
#' @param prefix Added to the base filename, can be "" or "norm_" or something similar
#' @param use.mtx If true, will write to <prefix>matrix.mtx and <prefix>features/barcodes.tsv
#'
saveMatrix <- function(counts, dir, prefix, use.mtx) {
  # Export expression matrix
  message("Writing matrix with prefix ",prefix," to directory ",dir, "(use.mtx is ", use.mtx, ")")
  if (prefix=="###")
      prefix <- ""
  else if (prefix!="" && !endsWith(prefix, "_"))
      prefix <- paste0(prefix, "_")

  if (use.mtx) {
        # we have to write the matrix to an mtx file
        matrixPath <- file.path(dir, paste(prefix, "matrix.mtx", sep=""))
        genesPath <- file.path(dir, paste(prefix, "features.tsv", sep=""))
        barcodesPath <- file.path(dir, paste(prefix, "barcodes.tsv", sep=""))
        message("Writing expression matrix to ", matrixPath)
        if (class(counts)[1]=="matrix") {
            counts <- as(counts, "sparseMatrix")
        }
        writeMM(counts, matrixPath)
        # easier to load if the genes file has at least two columns. Even though seurat objects
        # don't have yet explicit geneIds/geneSyms data, we just duplicate whatever the matrix has now
        write.table(as.data.frame(cbind(rownames(counts), rownames(counts))), file=genesPath, sep="\t", row.names=F, col.names=F, quote=F)
        write(colnames(counts), file = barcodesPath)
        message("Gzipping expression matrix")
        gzip(matrixPath, overwrite=TRUE)
        gzip(genesPath, overwrite=TRUE)
        gzip(barcodesPath, overwrite=TRUE)
  } else {
      # we can write the matrix as a tsv file
      gzPath <- file.path(dir, paste(prefix, "exprMatrix.tsv.gz", sep=""))
      mat = as.matrix(counts)
      genes <- rownames(counts)
      df <- as.data.frame(mat, check.names=FALSE)
      df <- data.frame(gene=genes, df, check.names = FALSE)
      z <- gzfile(gzPath, "w")
      message("Writing expression matrix to ", gzPath)
      write.table(x = df, sep="\t", file=z, quote = FALSE, row.names = FALSE)
      close(con = z)
  }
}

exportImages <- function(obj, outDir, embeddings.conf) {
#' used by ExportToCellbrowser:
#' Write spatial images to outDir
#'
#' @param obj The Seurat4 object
#' @param outDir output directory
#' @param an array of strings to write into the coords object into the cellbrowser config file
#'
    if (length(obj@images)==0)
        return(embeddings.conf)

    message("Exporting spatial images")
    require(png)
    for (name in names(obj@images)) { 
        message(name); 
        img = GetImage(obj, mode="raw", image=name); 
        if (is.null(img)) {
            message("The image is not a bitmap image, cannot export yet.")
            return(embeddings.conf)
        }
        imgPath <- file.path(outDir, paste0(name, ".jpg"))
        message("Writing image ", imgPath)
        #writePNG(img, imgPath);  # JPEG seems like a better choice here, 4x smaller at default quality settings.
        writeJPEG(img, target=imgPath, quality=0.95); 
        yMax = dim(img)[1];
        xMax = dim(img)[2]; # there is a difference of 3 pixels on height when comparing "identify file.jpeg" with this. NO IDEA WHY!
        coordsPath <- file.path(outDir, paste0(name, ".coords.tsv")) 
        message("Writing coords for image to ", coordsPath)
        #coords <- GetTissueCoordinates(object = obj[[img]])

        coords <- GetTissueCoordinates(object = obj[[name]])
        coordsRev <- coords[, c("imagecol", "imagerow")]  # Grrrr... Seurat stores coordinates as (y,x) in this particular case. reverse the order now.
        colnames(coordsRev) <- c("x", "y")

        write.table(coordsRev, coordsPath, sep="\t", row.names=T, quote=F, col.names=NA)
        conf <- sprintf(
         '  {\n    "file": "%s",\n    "shortLabel": "Spatial %s",\n    "flipY":True,\n    "images" : [{"file":"%s"}],\n     "minX":0, "minY":0, "maxX":%d, "maxY":%d\n  }',
         coordsPath,
         name,
         imgPath,
         xMax,
         yMax
        )
        embeddings.conf <- c(conf, embeddings.conf)
    }
    return(embeddings.conf)
}

#' Export \code{Seurat} objects for UCSC cell browser and stop open cell browser
#' instances from R
#'
#' @param object Seurat object
#' @param dir path to directory where to save exported files. These are:
#' exprMatrix.tsv, tsne.coords.tsv, meta.tsv, markers.tsv and a default
#' cellbrowser.conf
#' @param dataset.name name of the dataset. Defaults to Seurat project name
#' @param reductions vector of reduction names to export, defaults to all reductions.
#' @param markers.file path to file with marker genes. By defaults, marker
#' are searched in the object itself as misc$markers. If none are supplied in
#' object or via this argument, they are recalculated with \code{FindAllMarkers}
#' @param markers.n if no markers were supplied, FindAllMarkers is run.
#' This parameter indicates how many markers to calculate, default is 100
#' @param matrix.slot matrix to use, default is 'counts'
#' @param use.mtx export the matrix in .mtx.gz format. Default is False,
#'        unless the matrix is bigger than R's maximum matrix size.
#' @param cluster.field name of the metadata field containing cell cluster
#' @param cb.dir path to directory where to create UCSC cellbrowser static
#' website content root, e.g. an index.html, .json files, etc. These files
#' can be copied to any webserver. If this is specified, the cellbrowser
#' package has to be accessible from R via reticulate.
#' @param meta.fields vector of meta fields to export, default is all.
#' @param meta.fields.names vector meta field names to show in UI. Must have
#'        same length as meta.fields. Default is meta.fields.
#' @param skip.markers whether to skip exporting markers
#' @param skip.expr.matrix whether to skip exporting expression matrix
#' @param skip.metadata whether to skip exporting metadata
#' @param skip.reductions whether to skip exporting reductions
#' @param port on which port to run UCSC cellbrowser webserver after export
#' @param ... specifies the metadata fields to export. To supply a field and its
#' human readable name, pass name as \code{field="name"} parameter.
#'
#' @return This function exports Seurat object as a set of tsv files
#' to \code{dir} directory, copying the \code{markers.file} if it is
#' passed. It also creates the default \code{cellbrowser.conf} in the
#' directory. This directory could be read by \code{cbBuild} to
#' create a static website viewer for the dataset. If \code{cb.dir}
#' parameter is passed, the function runs \code{cbBuild} (if it is
#' installed) to create this static website in \code{cb.dir} directory.
#' If \code{port} parameter is passed, it also runs the webserver for
#' that directory and opens a browser.
#'
#' @author Maximilian Haeussler, Nikolay Markov
#'
#' @importFrom tools file_ext
#' @importFrom utils browseURL packageVersion gzip write.table
#' @importFrom reticulate py_module_available import
#' @importFrom Seurat Project Idents GetAssayData Embeddings FetchData
#' @importFrom Matrix  writeMM
#' @importFrom jpeg writeJPEG
#'
#' @export
#'
#' @name CellBrowser
#' @rdname CellBrowser
#'
#' @importFrom methods slot
#' @importFrom utils packageVersion
#' @importFrom reticulate py_module_available import
#'
#' @examples
#' \dontrun{
#' ExportToCellbrowser(pbmc_small, dataset.name = "PBMC", dir = "out")
#' }
#'
ExportToCellbrowser <- function(
  object,
  dir,
  dataset.name = Project(object = object),
  reductions = NULL,
  markers.file = NULL,
  cluster.field = NULL,
  cb.dir = NULL,
  port = NULL,
  use.mtx = FALSE,
  meta.fields = NULL,
  meta.fields.names = NULL,
  matrix.slot = "counts",
  markers.n = 100,
  skip.markers = FALSE,
  skip.expr.matrix = FALSE,
  skip.metadata = FALSE,
  skip.reductions = FALSE
) {
  if (!requireNamespace("Seurat", quietly = TRUE)) {
    stop("This script requires that Seurat (V2 or higher) is installed")
  }

  # various seurat-version related business
  message("SeuratVersion installed = ", packageVersion("Seurat"))
  message("ObjectVersion Seurat object was created with Seurat version = ", object@version)

  objMaj <- package_version(object@version)$major
  pkgMaj <- package_version(packageVersion("Seurat"))$major

  if (objMaj != pkgMaj) {
          message("The installed major version of Seurat is different from Seurat input object. Running the UpdateSeuratObject() function now")
          object <- UpdateSeuratObject(object)
  }

  message("Seurat object summary:")
  print(object)

  # a vector with the slot names to export
  slotNames <- unlist(strsplit(matrix.slot, ","))

  # shortcuts to make the code below easier to read (originally this was also to isolate us from the Seurat2/3 issue
  idents <- Idents(object = object)
  meta <- object[[]]
  cellOrder <- colnames(x = object)
  slotMatrices <- findMatrices(object = object, slotNames = slotNames)
  dr <- object@reductions
  reducNames <- reductions

  # Use or find the default cluster field
  #if (is.null(x = cluster.field)) {
    ## find and use the default Idents() field as the cluster field
    #idents <- Idents(object)
    #for (colName in colnames(object@meta.data)) {
        #col = object@meta.data[[colName]]
        #if (identical(idents@.Data,col@.Data)) {
            #message("Default Idents() meta field:",colName) 
            #cluster.field <- colName
            #break
        #}
    #}
  if (is.null(x = cluster.field)) {
        message("No cluster field specified: Using the value of Idents()")
        # create a new meta data field named "Cluster"
        #newDf <- cbind(object@meta.data, Idents(object))
        # default name is "Idents(object)", not good, let's rename that to "Cluster"
        #names(newDf)[length(newDf)] <- "Cluster"
        #object@meta.data <- newDf
        #cluster.field <- "Cluster"
  } else {
      message("A custom cluster field was specified: ", cluster.field)
      Idents(object = object) <- cluster.field
      # another, convoluted way to set the Idents field, if the command above makes trouble again
      #Idents(object) <- as.factor([object[[cluster.field]], cluster.field])
  }

  # make sure that we have a cluster field
  #if (is.null(x = cluster.field))
      #stop("There was no cluster field provided and the auto-detection to find one based on Idents() did not work. Please provide a cluster field with cluster.field='xxx' from R or --clusterField=xxx if using cbImportSeurat. Possible meta annotation fields are: ", toString(colnames(x = meta)))

  if (is.null(x = meta.fields)) {
    meta.fields <- colnames(x = meta)
    #if (length(x = levels(x = Idents(object))) > 1) {
      #meta.fields <- c(meta.fields, ".ident")
    #}
  }

  if (!is.null(x = port) && is.null(x = cb.dir)) {
    stop("cb.dir parameter is needed when port is set")
  }
  if (!dir.exists(paths = dir)) {
    dir.create(path = dir)
  }
  if (!dir.exists(paths = dir)) {
    stop("Output directory ", dir, " cannot be created or is a file")
  }
  if (dataset.name == "SeuratProject") {
    warning("Using default project name means that you may overwrite project with the same name in the cellbrowser html output folder")
  }
  enum.fields <- c()

  if (! use.mtx) {
      # detect if we must use MTX
      mat1 <- slotMatrices[[1]]
      # R cannot load matrices bigger than 2^32 elements, sparse mode gets us beyond that,
      # so use MTX if the matrix is very big (the exact cutoff is an educated guess)
      use.mtx <- ((((ncol(mat1)/1000)*(nrow(mat1)/1000))>2000) && is(mat1, 'sparseMatrix'))
      if (use.mtx) {
          message("Matrix too big: forcing MTX mode")
      }
  }

  # save the matrices 
  if (! skip.expr.matrix) {
      for (prefix in names(slotMatrices)) {
          mat <- slotMatrices[[prefix]]
          saveMatrix(mat, dir, prefix, use.mtx)
      }
  }

  # Export cell embeddings/reductions
  if (is.null(reducNames)) {
      reducNames = names(dr)
      message("Using all embeddings contained in the Seurat object: ", reducNames)
  }

  foundEmbedNames = c()
  for (embedding in reducNames) {
    emb <- dr[[embedding]]
    if (is.null(x = emb)) {
        message("Embedding ", embedding, " does not exist in Seurat object. Skipping. ")
        next
    }
    df <-  emb@cell.embeddings
    if (ncol(x = df) > 2) {
      warning('Embedding ', embedding, ' has more than 2 coordinates, taking only the first 2')
      df <- df[, 1:2]
    }
    colnames(x = df) <- c("x", "y")
    df <- data.frame(cellId = rownames(x = df), df, check.names = FALSE)
    fname <- file.path(
      dir,
      sprintf("%s.coords.tsv", embedding)
    )
    message("Writing embeddings to ", fname)
    write.table(df[cellOrder, ], sep="\t", file=fname, quote = FALSE, row.names = FALSE)
    foundEmbedNames = append(foundEmbedNames, embedding)
  }
  # by default, the embeddings are sorted in the object by order of creation (pca, tsne, umap).
  # But that is usually the opposite of what users want, they want the last embedding to appear first
  # in the UI, so reverse the order here
  foundEmbedNames = sort(foundEmbedNames, decreasing=T)
  embeddings.conf <- c()
  for (embedName in foundEmbedNames) {
      conf <- sprintf(
        '  {"file": "%s.coords.tsv", "shortLabel": "Seurat %1$s"}',
        embedName
      )
      embeddings.conf <- c(embeddings.conf, conf)
   }
  # Export metadata
  df <- data.frame(row.names = cellOrder, check.names = FALSE)
  for (field in meta.fields) {
    if (field == ".ident") {
      df$Cluster <- Idents(object)
      enum.fields <- c(enum.fields, "Cluster")
    } else {
      name <- meta.fields.names[[field]]
      if (is.null(name)) {
        name <- field
      }
      df[[name]] <- meta[[field]]
      if (!is.numeric(df[[name]])) {
        enum.fields <- c(enum.fields, name)
      }
    }
  }
  df <- data.frame(Cell = rownames(df), df, check.names = FALSE)
  fname <- file.path(dir, "meta.tsv")
  message("Writing meta data to ", fname)
  write.table(as.matrix(df[cellOrder, ]), sep = "\t", file = fname, quote = FALSE, row.names = FALSE)
  # Export markers
  markers.string <- ''
  if (is.null(markers.file)) {
    ext <- "tsv"
  } else {
    ext <- tools::file_ext(markers.file)
  }
  file <- paste0("markers.", ext)
  fname <- file.path(dir, file)
  if (!is.null(markers.file) && !skip.markers) {
    message("Copying ", markers.file, " to ", fname)
    file.copy(markers.file, fname)
  }
  if (is.null(markers.file) && skip.markers) {
    file <- NULL
  }
  if (is.null(markers.file) && !skip.markers) {
    if (length(levels(Idents(object))) > 1) {
      #markers.helper <- function(x) {
        #partition <- markers[x,]

        # Seurat4 changed the field name! grrrr...
        #if ("avg_log2FC" %in% colnames(markers))
            #avgs <- -partition$avg_log2FC
        #else
            #avgs <- -partition$avg_logFC
        #ord <- order(partition$p_val_adj < 0.05, avgs)
        #res <- x[ord]
        #naCount <- max(0, length(x) - markers.n)
        #res <- c(res[1:markers.n], rep(NA, naCount))
        #return(res)
      #}
      hasMarkers = FALSE
      if (.hasSlot(object, "misc") && !is.null(x = object@misc["markers"][[1]]) ) {
        hasMarkers = TRUE
        message("Found precomputed markers in obj@misc['markers']")
      }

      if (skip.markers) {
        message("Not using precomputed markers, as --skipMarkers was set")
        hasMarkers = FALSE
      }
    
      if (hasMarkers) {
            message("Using precomputed markers")
            markers <- object@misc["markers"]$markers
      } else {
        message("Running FindAllMarkers(), using wilcox test, min logfc diff 0.25")
        # Only run this block if the Active assay is SCT
        if ("SCT" %in% DefaultAssay(object = object)) {
            message("Looks like an SCT object, so running PrepSCTFindMarkers()")
            PrepSCTFindMarkers(object = object)
        }
        markers <- FindAllMarkers(
          object,
          do.print = TRUE,
          only.pos = TRUE,
          logfc.threshold = 0.25,
          min.pct = 0.25
        )
      }
      message("Writing top ", markers.n, ", cluster markers to ", fname)
      #markers.order <- ave(x = rownames(x = markers), markers$cluster, FUN = markers.helper)
      #top.markers <- markers[markers.order[!is.na(x = markers.order)], ]
      require(dplyr);
      #markers  %>% group_by(cluster) %>% top_n(n = markers.n, wt = avg_logFC)
      markers %>% group_by(cluster) %>% dplyr::filter(avg_log2FC > 1) %>% slice_head(n = markers.n) %>% ungroup() -> topMarkers
      write.table(x = topMarkers, file = fname, quote = FALSE, sep = "\t", col.names = NA)
    } else {
      message("No clusters found in Seurat object and no external marker file provided, so no marker genes can be computed")
      file <- NULL
    }
  }
  if (!is.null(file)) {
    markers.string <- sprintf(
      'markers = [{"file": "%s", "shortLabel": "Seurat Cluster Markers"}]',
      file
    )
  }

  firstPrefix <- names(slotMatrices)[1]
  if (firstPrefix=="###")
      firstPrefix = ""

  if (length(slotMatrices)==1)
      matSep = ""
  else
      matSep = "_"

  # we assume that any slotname is possible. (in the wild, only 'counts' and 
  # 'scale.data' seem to occur, but we tolerate others)
  matrixNames <- names(slotMatrices)
  matrixLabels <- matrixNames
  matrixLabels[matrixLabels=="counts"] <- "read counts"
  matrixLabels[matrixLabels=="scale.data"] <- "scaled"
  matrices.conf <- sprintf(" {'label':'%s','fileName':'%s_exprMatrix.tsv.gz'}", 
                           names(slotMatrices), names(slotMatrices))

  matrices.string <- paste0("matrices=[", paste(matrices.conf, collapse = ",\n"), "]" )

  matrixOutPath <- sprintf("%s%sexprMatrix.tsv.gz", firstPrefix, matSep)
  if (use.mtx) {
    matrixOutPath <- sprintf("%s%smatrix.mtx.gz", firstPrefix, matSep)
  }

  embeddings.conf <- exportImages(object, dir, embeddings.conf)

  config <- '# This is a bare-bones cellbrowser config file auto-generated by the command-line tool cbImportSeurat 
# or directly from R with SeuratWrappers::ExportToCellbrowser().
# Look at https://github.com/maximilianh/cellBrowser/blob/master/src/cbPyLib/cellbrowser/sampleConfig/cellbrowser.conf
# for a full file that shows all possible options
name="%s"
shortLabel="%1$s"
exprMatrix="%s"
%s
#tags = ["10x", "smartseq2"]
meta="meta.tsv"
# how to find gene symbols. Possible values: "gencode-human", "gencode-mouse", "symbol" or "auto"
geneIdType="auto"
# file with gene,description (one per line) with highlighted genes, called "Dataset Genes" in the user interface
# quickGenesFile="quickGenes.csv"
clusterField="%s"
labelField="%s"
enumFields=%s
%s
coords=%s
'

  # the R code continues here. Some text editors are confused and don't realize that the multi-line string
  # has ended.
  enum.string <- paste0( "[", paste(paste0('"', enum.fields, '"'), collapse = ", "), "]" )

  coords.string <- paste0( "[", paste(embeddings.conf, collapse = ",\n"), "]" )

  config <- sprintf(
    config,
    dataset.name,
    matrixOutPath,
    matrices.string,
    cluster.field,
    cluster.field,
    enum.string,
    markers.string,
    coords.string
  )

  confPath <- file.path(dir, "cellbrowser.conf")
  message("Writing cellbrowser config to ", confPath)
  cat(config, file = confPath)
  message("Prepared cellbrowser directory ", dir)
  if (!is.null(x = cb.dir)) {
    if (!py_module_available(module = "cellbrowser")) {
      stop(
        "The Python package `cellbrowser` is required to prepare and run ",
        "Cellbrowser. Please install it ",
        "on the Unix command line with `sudo pip install cellbrowser` (if root) ",
        "or `pip install cellbrowser --user` (as a non-root user). ",
        "To adapt the Python that is used, you can either set the env. variable RETICULATE_PYTHON ",
        "or do `require(reticulate) and use one of these functions: use_python(), use_virtualenv(), use_condaenv(). ",
        "See https://rstudio.github.io/reticulate/articles/versions.html; ",
        "at the moment, R's reticulate is using this Python: ",
        import(module = 'sys')$executable,
        ". "
      )
    }
    if (!is.null(x = port)) {
      port <- as.integer(x = port)
    }
    message("Converting cellbrowser directory to html/json files")
    cb <- import(module = "cellbrowser")
    cb$cellbrowser$build(dir, cb.dir)
    message("HTML files are ready in ", cb.dir)
    if (!is.null(port)) {
      message("Starting http server")
      cb$cellbrowser$stop()
      cb$cellbrowser$serve(cb.dir, port)
      Sys.sleep(time = 0.4)
      browseURL(url = paste0("http://localhost:", port))
    }
  }
}

#' Stop Cellbrowser web server
#'
#' @export
#'
#' @importFrom reticulate py_module_available
#' @importFrom reticulate import
#'
#' @examples
#' \dontrun{
#' StopCellbrowser()
#' }
#'
StopCellbrowser <- function() {
  if (py_module_available("cellbrowser")) {
    cb <- import("cellbrowser")
    cb$cellbrowser$stop()
  } else {
    stop("The `cellbrowser` package is not available in the Python used by R's reticulate")
  }
}

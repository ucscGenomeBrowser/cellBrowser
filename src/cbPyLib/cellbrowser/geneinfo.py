# annotate a list of gene IDs with links to various external databases

import logging, sys, optparse, re, unicodedata, string, csv
from collections import defaultdict, namedtuple
from os.path import join, basename, dirname, isfile

from .cellbrowser import openStaticFile, staticFileNextRow, openFile, splitOnce, iterItems, lineFileNextRow, setDebug
from .cellbrowser import readGeneSymbols

dataDir = "geneAnnot"

# no spaces/special chars in filenames - otherwise the URL will be rejected as invalid by urllib2
HPRD = join(dataDir, "HPRD_molecular_class_081914.txt")
HGNC = join(dataDir, "hgnc_complete_set_05Dec17.txt")
SFARI = join(dataDir, "SFARI-Gene_genes_export06-12-2017.csv")
OMIM = join(dataDir, "mim2gene.txt")
COSMIC = join(dataDir, "Census_allWed_Dec__6_18_35_54_2017.tsv")
HPO = join(dataDir, "hpo_frequent_7Dec17.txt")
BRAINSPANLMD = join(dataDir, "brainspan_genes.csv")
BRAINSPANMOUSEDEV = join(dataDir, "brainspanMouse_9Dec17.txt")
MGIORTHO = join(dataDir, "mgi_HGNC_homologene_8Dec17.txt")
EUREXPRESS = join(dataDir, "eurexpress_7Dec17.txt")
DDD = join(dataDir, "DDG2P_18_10_2018.csv.gz")
ZFIN = join(dataDir, "zfin_genetic_markers.txt")


# ==== functions =====
    
def parseArgs():
    " setup logging, parse command line arguments and options. -h shows auto-generated help page "
    parser = optparse.OptionParser("""usage: %prog [options] inFname outFname - annotate a tab-sep gene list file with information from other databases
            
    A minimal input file has a header line with at one field called "gene" (=symbol or ENS/Entrez geneID) and
    one field called "cluster".
    
    In the cellbrowser, the cluster name should match the cluster name in the meta data file.""")

    parser.add_option("-d", "--debug", dest="debug", action="store_true", help="show debug messages")
    parser.add_option("", "--hprd", dest="hprd", action="store", help="location of HPRD file, default %default", default=HPRD)
    parser.add_option("", "--hgnc", dest="hgnc", action="store", help="location of HGNC file, default %default", default=HGNC)
    parser.add_option("", "--sfari", dest="sfari", action="store", help="location of SFARI file, default %default", default=SFARI)
    parser.add_option("", "--omim", dest="omim", action="store", help="location of OMIM file, default %default", default=OMIM)
    parser.add_option("", "--cosmic", dest="cosmic", action="store", help="location of COSMIC Census file, default %default", default=COSMIC)
    parser.add_option("", "--hpo", dest="hpo", action="store", help="location of HPO gene/disease/phenotype file, default %default", default=HPO)
    parser.add_option("", "--lmd", dest="lmd", action="store", help="location of BrainSpan LMD file, default %default", default=BRAINSPANLMD)
    parser.add_option("", "--mgiOrtho", dest="mgiOrtho", action="store", help="location of MGI Homologene file, default %default", default=MGIORTHO)
    parser.add_option("", "--eurexpress", dest="eurexpress", action="store", help="location of Eurexpress file, default %default", default=EUREXPRESS)
    parser.add_option("", "--brainspanMouseDev", dest="brainspanMouseDev", action="store", help="location of brainspan Mouse Development ISH file, default %default", default=BRAINSPANMOUSEDEV)
    parser.add_option("", "--zfin", dest="zfin", action="store", help="location of ZFIN genetic markers file, default %default", default=ZFIN)
    #parser.add_option("-f", "--file", dest="file", action="store", help="run on file") 
    #parser.add_option("", "--test", dest="test", action="store_true", help="do something") 
    (options, args) = parser.parse_args()

    if args==[]:
        parser.print_help()
        exit(1)

    setDebug(options.debug)
    return args, options

# ----------- main --------------
def parseBrainspanLmd(inFname):
    " return entrez -> brainspanGeneId with all entrez IDs that are in the brainspan LMD set "
    with openStaticFile(inFname, 'r') as csvfile:
        ret = {}
        cr = csv.reader(csvfile)
        headers = None
        for row in cr:
            if headers == None:
                assert(row==['row_num','gene_id','ensembl_gene_id','gene_symbol','entrez_id'])
                headers = row
                continue
            ret[row[4]] = row[1]
    return ret


def parseSfari(inFname):
    " return symbol -> class "
    classDesc = {
            "" : "Autism, No category",
            "S" : "Autism, S - Syndromic",
            "1" : "Autism, 1 - High confidence",
            "2" : "Autism, 2 - Strong candidate",
            "3" : "Autism, 3 - Suggestive evidence",
            "4" : "Autism, 4 - Minimal evidence",
            "5" : "Autism, 5 - Hypothesized but untested",
            "6" : "Autism, 6 - Evidence does not support role",
    }
    # ['status', 'gene-symbol', 'gene-name', 'chromosome', 'genetic-category', 'gene-score', 'syndromic', 'number-of-reports']
    headers = None
    ret = {}
    with openStaticFile(inFname, 'r') as csvfile:
        spamreader = csv.reader(csvfile)
        for row in spamreader:
            if headers == None:
                headers = row
                assert(headers[5]=="gene-score")
                continue
            score = row[5]
            ret[row[1]] = classDesc[score]
    return ret

def parseHprd(inFname):
    " return entrez gene ID -> mol class from HPRD "
    ret = {}
    for row in staticFileNextRow(inFname):
        ret[row.Entrez_gene_ID] = row.Molecular_class
    return ret

def parseHgnc(inFname):
    " return dict with symbol -> entrez gene ID and hgncID to entrezId"
    ret = {}
    hgncIdToEntrez = {}
    for row in staticFileNextRow(inFname):
        entrezIds = row.entrez_id.strip('"').split("|")
        for entrezId in entrezIds:
            ret[row.symbol] = entrezId
            hgncIdToEntrez[row.hgnc_id] = entrezId # there is a 1:1 coorespondance between HGNC and entrez gene Id, except two miRNAs in 2017
    return ret, hgncIdToEntrez

def parseOmim(inFname):
    " return entrezId -> OMIM ID, link is https://omim.org/entry/601542 "
    # 100660  gene    218     ALDH3A1 ENSG00000108602
    ret = {}
    for line in openStaticFile(inFname):
        if line.startswith("#"):
            continue
        row = line.rstrip("\n").split("\t")
        if row[2]=="":
            continue
        ret[row[2]] = row[0]
    return ret

def parseCosmic(inFname):
    " return entrezId -> cancer types "
    ret = {}
    for row in staticFileNextRow(inFname):
        entrez = row.Entrez_GeneId
        cancerSomDesc = row.Tumour_Types_Somatic_
        cancerGermDesc = row.Tumour_Types_Germline_
        otherSyn = row.Other_Syndrome
        dis = []
        dis.extend(cancerSomDesc.strip('"').split(","))
        dis.extend(cancerGermDesc.strip('"').split(","))
        dis.extend(otherSyn.strip('"').split(","))
        disStr = ", ".join([s.strip() for s in dis if s!=""])
        disStr = disStr.replace(";", ",") # ; is reserved
        ret[entrez] = disStr
    return ret

def parseHpo(inFname):
    " return entrezId -> human phenotypes "
    geneToNames = defaultdict(set)
    # ORPHA:349	FUCA1	2517	HP:0000943	Dysostosis multiplex
    for line in openStaticFile(inFname):
        if line.startswith("#"):
            continue
        row = line.rstrip("\n").split("\t")
        entrez = row[2]
        hpoName = row[4]
        geneToNames[entrez].add(hpoName)

    ret = {}
    for entrez, names in iterItems(geneToNames):
        names = list(names)
        names.sort()
        ret[entrez] = ", ".join(names)
    return ret

def parseMgiOrtho(hgncIdToEntrez, inFname):
    " return dict with mouse entrezId -> human entrez "
    ret = {}
    # MGI Accession ID        Marker Symbol   Marker Name     Feature Type    EntrezGene ID   NCBI Gene chromosome    NCBI Gene start NCBI Gene end   NCBI Gene strand       Ensembl Gene ID Ensembl Gene chromosome Ensembl Gene start      Ensembl Gene end        Ensembl Gene strand     VEGA Gene ID    VEGA Gene chromosome  VEGA Gene start  VEGA Gene end   VEGA Gene strand        CCDS IDs        HGNC ID HomoloGene ID
    humanToMouse = defaultdict(list)
    for row in staticFileNextRow(inFname):
        hgncIds = row.HGNC_ID
        if hgncIds=="null" or hgncIds=="":
            continue
        for hgncId in hgncIds.split("|"):
            humanEntrez = hgncIdToEntrez[hgncId]
            # saw only 5 duplicated entrezIDs on the mouse side
            mouseEntrez = row.EntrezGene_ID
            ret[mouseEntrez] = humanEntrez
            humanToMouse[humanEntrez].append(mouseEntrez)
    return ret, humanToMouse

def parseEurexpress(mouseEntrezToHumanEntrez, inFname):
    " return dict with human entrez -> (eurexpressId, annotationStr) "
    # Template ID     Gene Symbol     Assay ID        EMAP Term       Entrez ID       Theiler Stage
    entrezToTerms = defaultdict(set)
    entrezToEuroexpress = dict()
    skippedMouseIds = set()
    for row in staticFileNextRow(inFname):
        mouseEntrez = row.Entrez_ID
        humanEntrez = mouseEntrezToHumanEntrez.get(mouseEntrez)
        if humanEntrez==None:
            skippedMouseIds.add(mouseEntrez)
            continue
        if row.EMAP_Term!="":
            entrezToTerms[humanEntrez].add(row.EMAP_Term)
        entrezToEuroexpress[humanEntrez] = row.Assay_ID

    logging.info("Eurexpress mouse entrez IDs: %d mappable, %d not-mappable to human " % (len(entrezToEuroexpress),len(skippedMouseIds)))
    logging.debug("Eurexpress mouse: mouse entrez IDs not mappable to human: %s" % ",".join(skippedMouseIds))
    ret = {}
    for entrezId, terms in iterItems(entrezToTerms):
        eurexpId = entrezToEuroexpress[entrezId]
        ret[entrezId] = (eurexpId, ", ".join(sorted(list(terms))))

    return ret

def parseDDD(fname):
    " parse DDD phenotype file "
    ret = {}
    #for row in staticFileNextRow(inFname):
        #print row
    return ret
    
def parseZfin(inFname):
    " return dict of symbol -> ZFIN ID for zebrafish genes (type==GENE), or None if file not found "
    from .cellbrowser import getStaticFile
    absPath = getStaticFile(inFname)
    if absPath is None:
        logging.warning("ZFIN file not found: %s — skipping ZFIN annotation" % inFname)
        return None
    ret = {}
    for line in openStaticFile(inFname):
        row = line.rstrip("\n").split("\t")
        if len(row) < 4:
            continue
        zfinId, symbol, name, markerType = row[0], row[1], row[2], row[3]
        if markerType == "GENE":
            ret[symbol] = zfinId
    return ret

def parseSimpleMap(inFname):
    " parse simple tab-sep key-value file and return as dict "
    ret = {}
    for line in openStaticFile(inFname):
        row = line.rstrip("\n").split("\t")
        ret[row[0]] = row[1]
    return ret

def tabGeneAnnotate(inFname, symToEntrez, symToSfari, entrezToClass, entrezToOmim, entrezToCosmic, entrezToHpo, entrezToLmd, entrezToEuroexpress, humanToMouseEntrezList, mouseEntrezToBrainspanMouseDev, symToZfin=None):
    " "
    headers = None
    geneToSym = -1
    for row in lineFileNextRow(inFname):
        if headers is None:
            headers = list(row._fields)
            headers.append("_hprdClass")
            headers.append("_expr")
            headers.append("_zfin")
            headers.append("_geneCards")
            headers.append("_geneLists")

            # lineFileNextRow makes some changes to seurat headers that we need to undo
            if headers[0] == "rowName":
                headers[0] = ''
            if headers[3] == "pct_1":
                headers[3] = "pct.1"
            if headers[4] == "pct_2":
                headers[4] = "pct.2"
            yield headers
        sym = row[1]
        isSeurat = False
        try:
            float(sym)
            isSeurat = True # if column 2 is a number, it's probably a seurat file
        except ValueError:
            pass
        if isSeurat:
            sym = row[7] # gene symbol is in the 'gene' column (index 7) for Seurat format
        if "|" in sym: # marker gene lists can carry geneId|symbol, strip the symbol in this case and re-convert below
            parts = sym.split("|")
            geneIdPart = parts[0]
            # for non-human/mouse Ensembl IDs (e.g. ENSDARG), use the symbol part directly
            if geneIdPart.startswith("ENS") and not geneIdPart.startswith("ENSG") and not geneIdPart.startswith("ENSMUSG"):
                sym = parts[1] if len(parts) > 1 else geneIdPart
            else:
                sym = geneIdPart
        if "." in sym: # remove Ensembl version identifier
            sym = sym.split(".")[0]

        origSym = sym  # save symbol before Entrez conversion for GeneCards link

        # convert gene IDs to symbols
        if geneToSym == -1:
            geneToSym = readGeneSymbols(None, [sym])
        if geneToSym is not None:
            geneId = geneToSym.get(sym)
            if geneId is None:
                logging.debug("Cannot find NCBI Gene ID for symbol: %s" % sym)
                geneId = sym
            sym = geneId

        hprdClass = ""
        entrezId = symToEntrez.get(sym)

        if entrezId == None:
            logging.debug("Cannot find entrezId for symbol %s" % sym)

        # now summarize the presence/absence of this gene in various specialized gene lists:
        # OMIM, COSMIC, SFARI
        hprdClass = entrezToClass.get(entrezId, "")
        geneLists = []
        if sym!="":
            # SFARI
            sfariInfo = symToSfari.get(sym)
            if sfariInfo is not None:
                sfariInfo = "SFARI||"+sfariInfo
                geneLists.append(sfariInfo)

        if entrezId is not None:
            # OMIM
            omimId = entrezToOmim.get(entrezId)
            if omimId is not None:
                omimInfo = "OMIM|"+omimId
                geneLists.append(omimInfo)

            # COSMIC
            cosmicDesc = entrezToCosmic.get(entrezId)
            if cosmicDesc is not None:
                cosmicDesc = "COSMIC||"+cosmicDesc
                geneLists.append(cosmicDesc)

            # HPO
            hpoDesc = entrezToHpo.get(entrezId)
            if hpoDesc is not None:
                hpoDesc = "HPO|"+entrezId+"|"+hpoDesc
                geneLists.append(hpoDesc)

        # links to gene expression databases
        exprParts = []
        if entrezId is not None:
            if entrezId in entrezToLmd:
                exprParts.append("BrainSpLMD|"+entrezId)

            if entrezId in entrezToEuroexpress:
                eurExpId, annotStr = entrezToEuroexpress[entrezId]
                annotStr = annotStr.replace(";", ",")
                exprParts.append("Eurexp|"+eurExpId+"|"+annotStr)

            mouseEntrezList = humanToMouseEntrezList[entrezId]
            for mouseEntrez in mouseEntrezList:
                if mouseEntrez in mouseEntrezToBrainspanMouseDev:
                    exprParts.append("BrainSpMouseDev|"+mouseEntrezToBrainspanMouseDev[mouseEntrez])

        row = list(row)
        if isSeurat:
            row[7] = sym # for seurat files, update the gene column with the canonical symbol
        else:
            row[1] = sym # in case the original ID was a geneID, not a symbol

        zfinId = symToZfin.get(origSym) if symToZfin and origSym else None
        row.append(hprdClass)
        row.append(";".join(exprParts))
        row.append("ZFIN|" + zfinId if zfinId else "")
        row.append("GeneCards|" + origSym if entrezId is not None and origSym else "")
        row.append(";".join(geneLists))

        yield row

def cbMarkerAnnotate(
    filename: str,
    outFname: str,
    brainspanMouseDev: str,
    hgnc: str,
    mgiOrtho: str,
    eurexpress: str,
    lmd: str,
    hpo: str,
    cosmic: str,
    omim: str,
    sfari: str,
    hprd: str,
    zfin: str = None,
):
    """Core function that does marker annotation using explicit arguments."""

    entrezToBrainspanMouseDev = parseSimpleMap(brainspanMouseDev)
    symToEntrez, hgncIdToEntrez = parseHgnc(hgnc)
    mouseEntrezToHumanEntrez, humanToMouseEntrezList = parseMgiOrtho(
        hgncIdToEntrez, mgiOrtho
    )

    entrezToEuroexpress = parseEurexpress(mouseEntrezToHumanEntrez, eurexpress)
    entrezToLmd = parseBrainspanLmd(lmd)
    entrezToHpo = parseHpo(hpo)
    entrezToCosmic = parseCosmic(cosmic)
    entrezToOmim = parseOmim(omim)
    symToSfari = parseSfari(sfari)
    entrezToClass = parseHprd(hprd)
    symToZfin = parseZfin(zfin) if zfin else None

    # collect all rows so we can detect and drop annotation columns that are entirely empty
    rows = list(tabGeneAnnotate(
        filename,
        symToEntrez,
        symToSfari,
        entrezToClass,
        entrezToOmim,
        entrezToCosmic,
        entrezToHpo,
        entrezToLmd,
        entrezToEuroexpress,
        humanToMouseEntrezList,
        entrezToBrainspanMouseDev,
        symToZfin,
    ))

    if not rows:
        logging.warning("No rows produced — output file will be empty")
        open(outFname, "w").close()
        return

    # annotation columns are those appended by tabGeneAnnotate (start with _)
    header = rows[0]
    annotCols = [i for i, h in enumerate(header) if h.startswith("_")]

    # find which annotation columns have at least one non-empty value
    nonEmptyCols = set()
    for row in rows[1:]:
        for i in annotCols:
            if i < len(row) and row[i]:
                nonEmptyCols.add(i)

    # build set of columns to drop (annotation columns that are entirely empty)
    dropCols = set(annotCols) - nonEmptyCols
    if dropCols:
        dropNames = [header[i] for i in sorted(dropCols)]
        logging.info("Dropping empty annotation columns: %s", ", ".join(dropNames))

    keepCols = [i for i in range(len(header)) if i not in dropCols]

    rowCount = 0
    with open(outFname, "w") as ofh:
        for row in rows:
            ofh.write("\t".join(row[i] if i < len(row) else "" for i in keepCols) + "\n")
            rowCount += 1

    logging.info(
        "Annotated %d marker gene rows, output written to %s",
        rowCount - 1,  # exclude header
        outFname,
    )

def cbMarkerAnnotateFromArgs(args, options):
    filename = args[0]
    outFname = args[1]

    return cbMarkerAnnotate(
        filename=filename,
        outFname=outFname,
        brainspanMouseDev=options.brainspanMouseDev,
        hgnc=options.hgnc,
        mgiOrtho=options.mgiOrtho,
        eurexpress=options.eurexpress,
        lmd=options.lmd,
        hpo=options.hpo,
        cosmic=options.cosmic,
        omim=options.omim,
        sfari=options.sfari,
        hprd=options.hprd,
        zfin=options.zfin,
    )

def cbMarkerAnnotateCli():
    args, options = parseArgs()
    cbMarkerAnnotateFromArgs(args, options)

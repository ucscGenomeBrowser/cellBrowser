// and expression data (string -> float, one mapping per circle)

/* jshint -W097 */
/* jshint -W117 */  // don't complain about unknown classes, like Set()
/* jshint -W104 */  // allow 'const'
/* jshint -W069 */  // object access with ["xx"]

/* TODO:
 * - status bug - reset last expression array when coloring by meta */

"use strict";

var cellbrowser = function() {
    var db = null; // the cbData object from cbData.js. Loads coords,
                   // annotations and gene expression vectors

    var gVersion = "$VERSION$"; // cellbrowser.py:copyStatic will replace this with the pip version or git release
    var gCurrentCoordName = null; // currently shown coordinates

    // object with all information needed to map to the legend colors:
    // all info about the current legend. gLegend.rows is an object with keys:
    // color, defColor, label, count, intKey, strKey
    // intKey can be int or str, depending on current coloring mode.
    // E.g. in meta coloring, it's the metadata string value.
    // When doing expression coloring, it's the expression bin index.
    // strKey is used to save manually defined colors to localStorage, a string
    var gLegend = null;

    // object with info about the current meta left side bar
    // keys are:
    // .rows = array of objects with .field and .value
    var gMeta = {rows : [], mode:null};

    // optional second legend, for split screen mode
    var gOtherLegend = null;

    var renderer = null;

    var background = null;

    // last 10 genes
    var gRecentGenes = [];

    // -- CONSTANTS
    var gTitle = "UCSC Cell Browser";
    var COL_PREFIX = "col_";

    var gOpenDataset = null; // while navigating the open dataset dialog, this contains the current name
        // it's a global variable as the dialog is not a class (yet?) and it's the only piece of data
        // it is a subset of dataset.json , e.g. name, description, cell count, etc.

    // depending on the type of data, single cell or bulk RNA-seq, we call a circle a
    // "sample" or a "cell". This will adapt help menus, menus, etc.
    var gSampleDesc = "cell";

    // width of left meta bar in pixels
    var metaBarWidth = 250;
    // margin between left meta bar and drawing canvas
    var metaBarMargin = 0;
    // width of legend, pixels
    var legendBarWidth = 200;
    var legendBarMargin = 0;
    // width of the metaBar tooltip (histogram)
    var metaTipWidth = 400;
    // height of pull-down menu bar at the top, in pixels
    var menuBarHeight = null; // defined at runtime by div.height
    // height of the toolbar, in pixels
    var toolBarHeight = 28;
    // position of first combobox in toolbar from left, in pixels
    var toolBarComboLeft = metaBarWidth;
    var toolBarComboTop   = 2;
    // width of the collection combobox
    var collectionComboWidth = 200;
    var layoutComboWidth = 200;
    // width of a single gene cell in the meta gene bar tables
    //var gGeneCellWidth = 66;

    // height of the trace viewer at the bottom of the screen
    var traceHeight = 100;

    // height of bottom gene bar
    var geneBarHeight = 100;
    var geneBarMargin = 5;
    // color for missing value when coloring by expression value
    //var cNullColor = "CCCCCC";
    //const cNullColor = "DDDDDD";
    //const cNullColor = "95DFFF"; //= light blue, also tried e1f6ff
    //const cNullColor = "e1f6ff"; //= light blue
    const cNullColor = "AFEFFF"; //= light blue

    const cDefGradPalette = "magma";  // default legend gradient palette for gene expression
    // this is a special palette, tol-sq with the first entry being a light blue, so 0 stands out a bit more
    const cDefGradPaletteHeat = "magma";  // default legend gradient palette for the heatmap
    const cDefQualPalette  = "rainbow"; // default legend palette for categorical values

    var datasetGradPalette = cDefGradPalette;
    var datasetQualPalette = cDefQualPalette;


    const exprBinCount = 10; //number of expression bins for genes
    // has to match cbData.js.exprBinCount - TODO - share the constant between these two files

    var HIDELABELSNAME = "Hide labels";
    var SHOWLABELSNAME = "Show labels";
    var METABOXTITLE   = "By Annotation";

    // maximum number of distinct values that one can color on
    const MAXCOLORCOUNT = 500;

    // histograms show only the top X values and summarize the rest into "other"
    var HISTOCOUNT = 12;
    // the sparkline is a bit shorter
    var SPARKHISTOCOUNT = 12;

    // links to various external databases
    var dbLinks = {
        "HPO" : "https://hpo.jax.org/app/browse/gene/", // entrez ID
        "OMIM" : "https://omim.org/entry/", // OMIM ID
        "COSMIC" : "http://cancer.sanger.ac.uk/cosmic/gene/analysis?ln=", // gene symbol
        "SFARI" : "https://gene.sfari.org/database/human-gene/", // gene symbol
        "BrainSpLMD" : "http://www.brainspan.org/lcm/search?exact_match=true&search_type=gene&search_term=", // entrez
        "BrainSpMouseDev" : "http://developingmouse.brain-map.org/gene/show/", // internal Brainspan ID
        "Eurexp" : "http://www.eurexpress.org/ee/databases/assay.jsp?assayID=", // internal ID
        "LMD" : "http://www.brainspan.org/lcm/search?exact_match=true&search_type=gene&search_term=" // entrez
    };

    var DEBUG = true;

    function _dump(o) {
    /* for debugging */
        console.log(JSON.stringify(o));
    }

    function formatString (str) {
        /* Stackoverflow code https://stackoverflow.com/a/18234317/233871 */
        /* "a{0}bcd{1}ef".formatUnicorn("foo", "bar"); // yields "aFOObcdBARef" */
            if (arguments.length) {
                var t = typeof arguments[0];
                var key;
                var args = ("string" === t || "number" === t) ?
                    Array.prototype.slice.call(arguments)
                    : arguments[0];

                for (key in args) {
                    str = str.replace(new RegExp("\\{" + key + "\\}", "gi"), args[key]);
                }
            }
            return str;
        }

    // Median of medians: https://en.wikipedia.org/wiki/Median_of_medians
    // find median in an unsorted array, worst-case complexity O(n).
    // from https://gist.github.com/wlchn/ee15de1da59b8d6981a400eee4376ea4
    const selectMedian = (arr, compare) => {
        return _selectK(arr, Math.floor(arr.length / 2), compare);
    };

    const _selectK = (arr, k, compare) => {
        if (!Array.isArray(arr) || arr.length === 0 || arr.length - 1 < k) {
            return;
        }
        if (arr.length === 1) {
            return arr[0];
        }
        let idx = _selectIdx(arr, 0, arr.length - 1, k, compare || _defaultCompare);
        return arr[idx];
    };

    const _partition = (arr, left, right, pivot, compare) => {
        let temp = arr[pivot];
        arr[pivot] = arr[right];
        arr[right] = temp;
        let track = left;
        for (let i = left; i < right; i++) {
            // if (arr[i] < arr[right]) {
            if (compare(arr[i], arr[right]) === -1) {
                let t = arr[i];
                arr[i] = arr[track];
                arr[track] = t;
                track++;
            }
        }
        temp = arr[track];
        arr[track] = arr[right];
        arr[right] = temp;
        return track;
    };

    const _selectIdx = (arr, left, right, k, compare) => {
        if (left === right) {
            return left;
        }
        let dest = left + k;
        while (true) {
            let pivotIndex =
                right - left + 1 <= 5
                ? Math.floor(Math.random() * (right - left + 1)) + left
                : _medianOfMedians(arr, left, right, compare);
            pivotIndex = _partition(arr, left, right, pivotIndex, compare);
            if (pivotIndex === dest) {
                return pivotIndex;
            } else if (pivotIndex < dest) {
                left = pivotIndex + 1;
            } else {
                right = pivotIndex - 1;
            }
        }
    };

    const _medianOfMedians = (arr, left, right, compare) => {
        let numMedians = Math.ceil((right - left) / 5);
        for (let i = 0; i < numMedians; i++) {
        let subLeft = left + i * 5;
        let subRight = subLeft + 4;
        if (subRight > right) {
            subRight = right;
        }
        let medianIdx = _selectIdx(arr, subLeft, subRight, Math.floor((subRight - subLeft) / 2), compare);
        let temp = arr[medianIdx];
        arr[medianIdx] = arr[left + i];
        arr[left + i] = temp;
        }
        return _selectIdx(arr, left, left + numMedians - 1, Math.floor(numMedians / 2), compare);
    };

    const _defaultCompare = (a, b) => {
        return a < b ? -1 : a > b ? 1 : 0;
    };
    // End median of medians

    function debug(msg, args) {
        if (DEBUG) {
            console.log(formatString(msg, args));
        }
    }

    const getRandomIndexes = (length, size) =>
    /* get 'size' random indexes from an array of length 'length' */
    {
        const indexes = [];
        const created = {};
      
        while (indexes.length < size) {
          const random = Math.floor(Math.random() * length);
          if (!created[random]) {
            indexes.push(random);
            created[random] = true;
          }
        }
        return indexes;
    };

    function arrSample(arr, size) {
        var arrLen = arr.length; 
        let rndIndexes = getRandomIndexes(arrLen, size);
        let sampleArr = [];
        for (let i = 0; i < rndIndexes.length; i++) {
            let rndIdx = rndIndexes[i];
            sampleArr.push(arr[rndIdx]);
        }
        return sampleArr;
    }

    function warn(msg) {
        alert(msg);
    }

    function getById(query) {
        return document.getElementById(query);
    }

    function cloneObj(d) {
    /* returns a copy of an object, wasteful */
        // see http://stackoverflow.com/questions/122102/what-is-the-most-efficient-way-to-deep-clone-an-object-in-javascript
        return JSON.parse(JSON.stringify(d));
    }

    function cloneArray(a) {
    /* returns a copy of an array */
        return a.slice();
    }

    function copyNonNull(srcArr, trgArr) {
    /* copy non-null values to trgArr */
        if (srcArr.length!==trgArr.length)
            alert("warning - copyNonNull - target and source array have different sizes.");

        for (var i = 0; i < srcArr.length; i++) {
            if (srcArr[i]!==null)
                trgArr[i] = srcArr[i];
        }
        return trgArr;
    }

    function isEmpty(obj) {
        for(var key in obj) {
            if(obj.hasOwnProperty(key))
                return false;
        }
        return true;
    }

    function allEmpty(arr) {
        /* return true if all members of array are white space only strings */
        var newArr = arr.filter(function(str) { return /\S/.test(str); });
        return (newArr.length===0);
    }

    function copyNonEmpty(srcArr, trgArr) {
    /* copy from src to target array if value is not "". Just return trgArr is srcArr is null or lengths don't match.  */
        if (!srcArr || (srcArr.length!==trgArr.length))
            return trgArr;

        for (var i = 0; i < srcArr.length; i++) {
            if (srcArr[i]!=="")
                trgArr[i] = srcArr[i];
        }
        return trgArr;
    }

    function keys(o) {
    /* return all keys of object as an array */
        var allKeys = [];
        for(var k in o) allKeys.push(k);
        return allKeys;
    }

    function trackEvent(eventName, eventLabel) {
    /* send an event to google analytics */
        if (typeof gtag !== 'function')
            return;
        gtag('event', eventName, eventLabel);
    }

    function trackEventObj(eventName, obj) {
    /* send an event obj to google analytics */
        if (typeof gtag !== 'function')
            return;
        gtag('event', obj);
    }

    function classAddListener(className, type, listener) {
        /* add an event listener for all elements of a class */
        var els = document.getElementsByClassName(className);
        for (let el of els) {
            el.addEventListener(type, listener);
        }
    }

    function capitalize(s) {
        return s[0].toUpperCase() + s.slice(1);
    }

    function cleanString(s) {
        /* make sure that string only contains normal characters. Good when printing something that may contain
         * dangerous ones */
        if (s===undefined)
            return undefined;
        return s.replace(/[^0-9a-zA-Z _-]/g, '');
    }

    function cleanStrings(inArr) {
        /* cleanString on arrays */
        var outArr = [];
        for (var i = 0; i < inArr.length; i++) {
            var s = inArr[i];
            outArr.push(cleanString(s));
        }
        return outArr;
    }

    function findMetaValIndex(metaInfo, value) {
        /* return the index of the value of an enum meta field */
        var valCounts = metaInfo.valCounts;
        for (var valIdx = 0; valIdx < valCounts.length; valIdx++) {
            if (valCounts[valIdx][0]===value)
                return valIdx;
        }
    }

    function intersectArrays(arrList) {
        /* return the intersection of all arrays as an array. Non-IE11? */
        var smallSet = new Set(arrList[0]);
        for (var i=1; i < arrList.length; i++) {
            var otherSet = new Set(arrList[i]);
            smallSet = new Set([...smallSet].filter(x => otherSet.has(x)));
        }
        var newArr = Array.from(smallSet);
        // alternative without spread:
        //function intersection(setA, setB) {
          //  var _intersection = new Set();
          //  for (var elem of setB) {
          //      if (setA.has(elem)) {
          //          _intersection.add(elem);
          //      }
          //  }
          //  return _intersection;
        //}
        return newArr;
    }

    function saveToUrl(key, value, defaultValue) {
    /* save a value in both localStorage and the URL. If the value is defaultValue or null, remove it */
        if (value===defaultValue || value===null) {
            localStorage.removeItem(key);
            delState(key);
        }
        else {
            localStorage.setItem(key, value);
            addStateVar(key, value);
        }
    }

    function getFromUrl(key, defaultValue) {
    /* get a value from localStorage or the current URL or return the default if not defined in either place.
     * The URL overrides localStorage. */
        var val = getVar(key);
        if (val!==undefined)
            return val;

        val = localStorage.getItem(key);
        if (val===null)
            return defaultValue
        else
            return val;
    }

    function getBaseUrl() {
       /* return URL of current page, without args or query part */
       var myUrl = window.location.href;
       myUrl = myUrl.replace("#", "");
       var urlParts = myUrl.split("?");
       var baseUrl = urlParts[0];
       return baseUrl;
    }

    function copyToClipboard(element) {
    /* https://stackoverflow.com/questions/22581345/click-button-copy-to-clipboard-using-jquery */
        var $temp = $("<input>");
        $("body").append($temp);
        $temp.val($(element).text()).select();
        document.execCommand("copy");
        $temp.remove();
    }

    function iWantHue(n) {
        /* a palette as downloaded from iwanthue.com - not sure if this is better. Ellen likes it */
        if (n>30)
            return null;

        var colList = ["7e4401", "244acd", "afc300", "a144cb", "00a13e",
            "f064e5", "478700", "727eff", "9ed671", "b6006c", "5fdd90", "f8384b",
            "00b199", "bb000f", "0052a3", "fcba56", "005989", "c57000", "7a3a78",
            "ccca76", "ff6591", "265e1c", "ff726c", "7b8550", "923223", "9a7e00",
            "ffa9ad", "5f5300", "ff9d76", "b3885f"];
        var colList2 = ["cd6a00", "843dc3", "c9cd31", "eda3ff", "854350"];
        if (n<=5)
            colList = colList2;
        return colList.slice(0, n);
    }

    function activateTooltip(selector) {
        // see noconflict line in html source code, I had to rename BS's tooltip to avoid overwrite by jquery, argh: both are called .tooltip() !
        var ttOpt = {
            "html": true,
            "animation": false,
            "delay": {"show":350, "hide":100},
            "trigger" : "hover",
            container:"body"
        };
        $(selector).bsTooltip(ttOpt);
    }

    function menuBarHide(idStr) {
    /* hide a menu bar selector */
         $(idStr).parent().addClass("disabled").css("pointer-events", "none");
    }

    function menuBarShow(idStr) {
    /* show a menu bar entry given its selector */
         $(idStr).parent().removeClass("disabled").css("pointer-events", '');
    }

    function updateMenu() {
    /* deactivate menu options based on current variables */
     // the "hide selected" etc menu options are only shown if some cells are selected
     if (renderer.selCells.length===0) {
         menuBarHide("#tpOnlySelectedButton");
         menuBarHide("#tpFilterButton");
     }
     else {
         menuBarShow("#tpOnlySelectedButton");
         menuBarShow("#tpFilterButton");
     }

     // the "show all" menu entry is only shown if some dots are actually hidden
     //if ((pixelCoords!==null && shownCoords!==null) && pixelCoords.length===shownCoords.length)
         //menuBarHide("#tpShowAllButton");
     //else
         //menuBarShow("#tpShowAllButton");

     //$("#tpTrans"+(transparency*100)).addClass("active");
     //$("#tpSize"+circleSize).addClass("active");

     // the "hide labels" menu entry is only shown if there are labels
     //if (gCurrentDataset.labelField === null)
         //menuBarHide("#tpHideLabels");
     //if (gCurrentDataset.showLabels===true)
         //$("#tpHideLabels").text(HIDELABELSNAME);
     //else
         //$("#tpHideLabels").text(SHOWLABELSNAME);
    }

    function prettySeqDist(count, addSign) {
        /* create human-readable string from chrom distance */
        var f = count;
        if (f==="0")
            return "+0bp";

        var sign = "";
        if (addSign && count > 0)
            sign = "+";

        if (Math.abs(count)>=1000000) {
            f = (count / 1000000);
            return sign+f.toFixed(3)+"Mbp";
        }
        if (Math.abs(count)>=10000) {
            f = (count / 1000);
            return sign+f.toFixed(2)+"kbp";
        }
        if (Math.abs(count)>=1000) {
            f = (count / 1000);
            return sign+f.toFixed(2)+"kbp";
        }
        return sign+f+"bp";
    }

    function prettyNumber(count, isBp) /*str*/ {
        /* convert a number to a shorter string, e.g. 1200 -> 1.2k, 1200000 -> 1.2M, etc */
        var f = count;
        if (count>1000000) {
            f = (count / 1000000);
            return f.toFixed(1)+"M";
        }
        if (count>10000) {
            f = (count / 1000);
            return f.toFixed(0)+"k";
        }
        if (count>1000) {
            f = (count / 1000);
            return f.toFixed(1)+"k";
        }
        return f;
    }

    function addMd5(url, md5s, key) {
        /* lookup key in md5s and add value to url separate by ? */
        if (md5s && md5s[key])
            url += "?"+md5s[key];
        return url;
    }

    function preloadImage(url) {
        let img= new Image();
        img.src = url;
    }

    function openDatasetLoadPane(datasetInfo, openTab) {
        /* open dataset dialog: load html into the three panes  */
        //var datasetName = datasetInfo.name;
        //var md5 = datasetInfo.md5;
        // the UCSC apache serves latin1, so we force it back to utf8
        gOpenDataset = datasetInfo; // for click handlers in the right panel

        $.ajaxSetup({
            'beforeSend' : function(xhr) {
                if (xhr && xhr.overrideMimeType)
                    xhr.overrideMimeType('text/html; charset=utf8');
            },
        });

        let datasetName = datasetInfo.name;
        let md5 = datasetInfo.md5;
        if (datasetInfo.hasFiles && datasetInfo.hasFiles.indexOf("datasetDesc")!==-1) {
            // description is not through html files but a json file
            var jsonUrl = cbUtil.joinPaths([datasetName, "desc.json"]) +"?"+md5;
            fetch(jsonUrl)
              .then(function(response) {
                if(!response.ok) {
                    throw new Error('Could not find desc.json file');
                }
                return response.json();
              })
              .catch(function(err) {
                  var msg = "File "+jsonUrl+" was not found but datasetDesc.json has 'datasetDesc' in hasFiles. Internal error. Please contact the site admin or cells@ucsc.edu";
                  $( "#pane1" ).html(msg);
                  $( "#pane2" ).html(msg);
                  $( "#pane3" ).html(msg);
                  $( "#pane3" ).show();
              })
              .then(function(desc) {
                  datasetDescToHtml(datasetInfo, desc);
                  if (openTab==="images")
                      $("#tabLinkImg").click();
              });
        }
        else {
          var message = "This dataset does not seem to have a desc.conf file. Please "+
              "read https://cellbrowser.readthedocs.io/en/master/dataDesc.html or run 'cbBuild --init' to create one";
          if (datasetInfo.abstract)
              // the top-level non-hierarchy dataset.conf has a message in it. Use it here, as a fallback.
              message = datasetInfo.abstract;

          $( "#pane1" ).html(message);
          $( "#pane2" ).hide();
          $( "#tabLink2" ).hide();
          $( "#pane3" ).hide();
          $( "#tabLink3" ).hide();
        }
        var tabIdx = 0;
        if (openTab==="images")
            tabIdx=3;
        $("#tpOpenDialogTabs").tabs("refresh").tabs("option", "active", tabIdx);
        if (openTab==="images")
            $("#tabLinkImg").click();
    }

    let descLabels = {
        "paper_url":"Publication",
        "other_url" : "Website",
        "geo_series" : "NCBI GEO Series", // = CIRM tagsV5
        "sra" : "NCBI Short Read Archive",
        "pmid" : "PubMed Abstract",
        "pmcid" : "PubMed Fulltext",
        "sra_study" : "NCBI Short-Read Archive",
        "ega_study" : "European Genotype-Phenot. Archive Study",
	    "ega_dataset" : "European Genotype-Phenot. Archive Dataset",
        "bioproject" : "NCBI Bioproject",
        "dbgap" : "NCBI DbGaP",
        "biorxiv_url" : "BioRxiv preprint",
        "doi" : "Publication Fulltext",
        "cbDoi" : "Data Citation DOI",
        "arrayexpress" : "ArrayExpress",
        "ena_project" : "European Nucleotide Archive",
        "hca_dcp" : "Human Cell Atlas Data Portal",
        "cirm_dataset" : "California Institute of Regenerative Medicine Dataset",
    };

    let descUrls = {
        "geo_series" : "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=",
        "sra_study" : "https://trace.ncbi.nlm.nih.gov/Traces/sra/?study=",
        "bioproject" : "https://www.ncbi.nlm.nih.gov/bioproject/",
        "ega_study" : "https://ega-archive.org/studies/",
        "ega_dataset" : "https://ega-archive.org/datasets/",
        "pmid" : "https://www.ncbi.nlm.nih.gov/pubmed/",
        "pmcid" : "https://www.ncbi.nlm.nih.gov/pmc/articles/",
        "dbgap" : "https://www.ncbi.nlm.nih.gov/projects/gap/cgi-bin/study.cgi?study_id=",
        "doi" : "http://dx.doi.org/",
        "cbDoi" : "http://dx.doi.org/",
        "ena_project" : "https://www.ebi.ac.uk/ena/data/view/",
        "cirm_dataset" : "https://cirm.ucsc.edu/d/",
        "arrayexpress" : "https://www.ebi.ac.uk/arrayexpress/experiments/",
        "hca_dcp" : "https://data.humancellatlas.org/explore/projects/",
    }

    function htmlAddLink(htmls, desc, key, linkLabel) {
        /* add a link to html on a new line. if desc[key] includes a space, the part after it is the link label. */
        if (!desc[key])
            return;

        let label = "Link";
        if (linkLabel)
            label = linkLabel;
        else
            label = descLabels[key];

        htmls.push("<b>");
        htmls.push(label);
        htmls.push(": </b>");

        // for cases where more than one ID is needed, this function also accepts a list in the object
        // for 99% of the cases, it'll be a string though
        let urls = desc[key];
        if (!(urls instanceof Array))
            urls = [urls];

        let frags = []; // html fragments, one per identifier
        for (let url of urls) {
            url = url.toString(); // in case it's an integer or float
            let urlLabel = url;
            let spcPos = url.indexOf(" ");
            if (spcPos!==-1) {
                urlLabel = url.slice(spcPos+1);
                url = url.slice(0,spcPos);
            }

            if (!url.startsWith("http"))
                url = descUrls[key]+url;

            let parts = []
            parts.push("<a target=_blank href='");
            parts.push(url);
            parts.push("'>");
            parts.push(urlLabel);
            parts.push("</a>");
            let htmlLine = parts.join("");
            frags.push(htmlLine);
        }
        htmls.push(frags.join(", "));
        htmls.push("<br>");
    }

    function buildLinkToMatrix(htmls, dsName, matFname, label) {
        /* link to a matrix file for download, handles mtx.gz */
        if (label)
            htmls.push("<b> Matrix for "+label+":</b> ");

        htmls.push("<a href='"+dsName+"/"+matFname+"'>"+matFname+"</a>");
        if (matFname.endsWith(".mtx.gz")) {
            var prefix = "";
            if (matFname.indexOf("_")!==-1)
                prefix = matFname.split("_")[0]+"_";
            var ftName = prefix+"features.tsv.gz";
            htmls.push(", <a href='"+dsName+"/"+ftName+"'>"+ftName+"</a>");
            var barName = prefix+"barcodes.tsv.gz";
            htmls.push(", <a href='"+dsName+"/"+barName+"'>"+barName+"</a>");
        }
        htmls.push("<br>");
    }

    function buildSupplFiles(desc, dsName, htmls) {
        /* create html with links to supplementary files */
        if (desc.supplFiles) {
            let supplFiles = desc.supplFiles;
            for (let suppFile of supplFiles) {
                let label = suppFile.label;
                let fname = suppFile.file;
                htmls.push("<b>"+label+":</b> <a href='"+dsName);
                htmls.push("/"+fname+"'>"+fname+"</a>");
                htmls.push("<br>");
            }
        }
    }

    function buildDownloadsPane(datasetInfo, desc) {
        var htmls = [];
        if (datasetInfo.name==="") { // the top-level desc page has no methods/downloads, it has only informative text
            $( "#pane3" ).hide();
            $( "#tabLink3" ).hide();
        } else {
            if (desc.coordFiles===undefined) {
                htmls.push("To download the data for datasets in this collection: open the collection, ");
                htmls.push("select a dataset in the list to the left, and navigate to the 'Data Download' tab. ");
                htmls.push("This information can also be accessed while viewing a dataset by clicking the 'Info &amp; Downloads' button.");
            } else if (desc.hideDownload===true || desc.hideDownload=="True" || desc.hideDownload=="true") {
                htmls.push("The downloads section has been deactivated by the authors.");
                htmls.push("Please contact the dataset authors to get access.");
            } else {
                if (desc.matrices) {
                    htmls.push("<p>");
                    for (var key in desc.matrices) {
                        var mat = desc.matrices[key];
                        buildLinkToMatrix(htmls, datasetInfo.name, mat.fileName, mat.label);
                    }
                    htmls.push("</p>");
                } else if (desc.matrixFile!==undefined && desc.matrixFile.endsWith(".mtx.gz")) {
                    htmls.push("<p>");
                    var matBaseName = desc.matrixFile.split("/").pop();
                    buildLinkToMatrix(htmls, datasetInfo.name, matBaseName, "dataset");
                    htmls.push("</p>");
                } else {
                    htmls.push("<p><b>Matrix:</b> <a href='"+datasetInfo.name);
                    htmls.push("/exprMatrix.tsv.gz'>exprMatrix.tsv.gz</a>");
                }
                if (desc.unitDesc)
                    htmls.push("<br>Values in matrix are: "+desc.unitDesc);
                htmls.push("</p>");

                if (desc.rawMatrixFile) {
                    htmls.push("<p><b>Raw count matrix:</b> <a href='"+datasetInfo.name);
                    htmls.push("/"+desc.rawMatrixFile+"'>"+desc.rawMatrixFile+"</a>");
                    if (desc.rawMatrixNote)
                        htmls.push("<br>"+desc.rawMatrixNote);
                    htmls.push("</p>");
                }

                htmls.push("<p><i><a style='float:right; padding-left: 100px'; target=_blank href='https://cellbrowser.readthedocs.io/en/master/load.html'>Help: Load matrix/meta into Seurat or Scanpy</a></i></p>");

                htmls.push("<p><b>Cell meta annotations:</b> <a target=_blank href='"+datasetInfo.name);
                htmls.push("/meta.tsv'>meta.tsv</a>");
                if (desc.metaNote)
                    htmls.push("<br>"+desc.metaNote);
                htmls.push("</p>");

                htmls.push("<p><b>Dimensionality reduction coordinates:</b><br>");
                for (let fname of desc.coordFiles)
                    htmls.push("<a target=_blank href='"+datasetInfo.name+"/"+fname+"'>"+fname+"</a><br>");
                htmls.push("</p>");

                buildSupplFiles(desc, datasetInfo.name, htmls);

                htmls.push("<p><b>Dataset description</b>: ");
                htmls.push("<a target=_blank href='"+datasetInfo.name+"/desc.json'>desc.json</a></p>");

                htmls.push("<p><b>Cell Browser configuration</b>: ");
                htmls.push("<a target=_blank href='"+datasetInfo.name+"/dataset.json'>dataset.json</a></p>");

                $( "#pane3" ).html(htmls.join(""));
                $( "#pane3" ).show();
                $( "#tabLink3" ).show();
            }

        }
    }

    function buildImagesPane(datasetInfo, desc) {
        if (!desc.imageSets) {
            $( "#tabLinkImg" ).hide();
            $( "#paneImg" ).hide();
            return;
        }

        let htmls = [];
        htmls.push("<h4>Supplemental high-resolution images</h4>");
        // TOC
        let catIdx = 0;
        htmls.push("<div style='padding-bottom:8px'>Jump to: ");
        for (let catInfo of desc.imageSets) {
            htmls.push("<a style='padding-left:12px' href='#imgCat"+catIdx+"'>"+catInfo.categoryLabel+"</a>");
            catIdx++;
        }
        htmls.push("</div>");

        if (desc.imageSetNote)
            htmls.push("<p>"+desc.imageSetNote+"<p>");

        // actual HTML
        catIdx = 0;
        for (let catInfo of desc.imageSets) {
            htmls.push("<div style='padding-top:6px; padding-bottom:4px' class='tpImgCategory'>");
            htmls.push("<a name='imgCat"+catIdx+"'></a>");
            catIdx++;
            htmls.push("<b>"+catInfo.categoryLabel+":</b><br>");
            let imgDir = datasetInfo.name+"/images/";
            htmls.push("<div style='padding-left:1em; padding-top:4px' class='tpImgSets'>");

            for (let imgSet of catInfo.categoryImageSets) {
                if (imgSet.setLabel)
                    htmls.push("<b>"+imgSet.setLabel+"</b><br>");
                htmls.push("<div style='padding-left:1em;' class='tpImgSetLinks'>");

                if (imgSet.images) {
                    let imgLinks = [];
                    for (let img of imgSet.images) {
                        // the "Show: label only makes sense if there are any downloads at all
                        let imgPrefix = "";
                        if (imgSet.downloads!==undefined)
                            imgPrefix = "Show: ";
                        imgLinks.push(imgPrefix+"<a target=_blank href='"+imgDir+img.file+"'>"+img.label+"</a> ");
                    }
                    htmls.push(imgLinks.join(", "));
                }

                if (imgSet.downloads) {
                    let dlLinks = [];
                    for (let dl of imgSet.downloads) {
                        dlLinks.push("<a href='"+imgDir+dl.file+"' download>"+dl.label+"</a>");
                    }
                    htmls.push("<br><div>Download: ");
                    htmls.push(dlLinks.join(", "));
                    htmls.push("</div>");
                }
                htmls.push("</div>"); //  tpImgSetLinks
            }
            htmls.push("</div>"); //  tpImgSets
            htmls.push("</div>"); //  tpImgCategory
        }
        //htmls.push("</ul>");
        $( "#paneImg" ).html(htmls.join(""));
        $( "#paneImg" ).show();
        $( "#tabLinkImg" ).show();
    }

    function buildMethodsPane(datasetInfo, desc) {
        // methods panel
        //
        var htmls = [];
        if (desc.methods) {
            htmls.push("<p>");
            htmls.push(desc.methods);
            htmls.push("</p>");
        }
        if (desc.algParams) {
            htmls.push("<p><b>Algorithm parameters: </b>");
            let algParams = desc.algParams;
            if (algParams instanceof Object)
                algParams = Object.entries(algParams);

            for (let i=0; i<algParams.length; i++) {
                let key = algParams[i][0];
                let val = algParams[i][1];
                htmls.push(key+"="+val+", ");
            }
            htmls.push("</p>");
        }
        if (htmls.length!==0) {
            $( "#pane2" ).html(htmls.join(""));
            $( "#pane2" ).show();
            $( "#tabLink2" ).show();
        } else {
            $( "#pane2" ).hide();
            $( "#tabLink2" ).hide();
        }
    }

    function pageAtUcsc() {
        // return true if current page is at ucsc.edu
        return (window.location.hostname.endsWith("ucsc.edu"));
    }

    function buildClassification(htmls, datasetInfo, attrName, label, addSep) {
        if (datasetInfo[attrName]===undefined && (datasetInfo.facets===undefined || datasetInfo.facets[attrName]===undefined))
            return;

        var values;
        // in Nov 2022, the facets moved into their own object, old dataasets have them in the dataset itself as attributes
        if (datasetInfo.facets)
            values = datasetInfo.facets[attrName];
        else
            values = datasetInfo[attrName];

        if (values===undefined)
            values = [];

        htmls.push(label+"=" + values.join(","));
        if (addSep)
            htmls.push("; ");
    }

    function datasetDescToHtml(datasetInfo, desc) {
        /* given an object with keys title, abstract, pmid, etc, fill the dataset description tabs with html */
        if (!desc) // http errors call this with undefined
            return;

        let htmls = [];

        if (datasetInfo.name==="") // the root dataset
            $('#tabLink1').text("Overview");
        else
            $('#tabLink1').text("Abstract");

        if (desc.title) {
            htmls.push("<h4>");
            htmls.push(desc.title);
            htmls.push("</h4>");
        }
        if (desc.image) {
            htmls.push("<img style='float:right; padding-left:5px' src='");
            htmls.push(datasetInfo.name+"/"+desc.image[0]+"'");
            if (desc.imageMap)
                htmls.push(" usemap='#clickmap'");
            htmls.push(" width='"+desc.image[1]+"' height='"+desc.image[2]+"'>");
        }
        if (desc.imageMap) {
            htmls.push('<map name="clickmap">');
            htmls.push(desc.imageMap);
            htmls.push('</map>');
        }

        if (desc.abstract) {
            htmls.push("<p>");
            htmls.push(desc.abstract);
            htmls.push("</p>");
        }
        else {
            // the top-level hardcoded dataset for non-hierarchy mode has the abstract in the
            // dataset config. It's a lot easier this way, so just pull it in here.
            htmls.push("<p>");
            htmls.push(datasetInfo.abstract);
            htmls.push("</p>");
        }

        if (desc.author) {
            htmls.push("<b>Author: </b> "+desc.author);
            htmls.push("<br>");
        }

        if (desc.authors) {
            htmls.push("<b>Authors: </b> "+desc.authors);
            htmls.push("<br>");
        }

        if (desc.lab) {
            htmls.push("<b>Lab: </b> "+desc.lab);
            htmls.push("<br>");
        }
        if (desc.institution) {
            htmls.push("<b>Institution: </b> "+desc.institution);
            htmls.push("<br>");
        }


        htmlAddLink(htmls, desc, "cbDoi");
        htmlAddLink(htmls, desc, "biorxiv_url");
        htmlAddLink(htmls, desc, "paper_url");
        htmlAddLink(htmls, desc, "other_url");
        htmlAddLink(htmls, desc, "geo_series");
        htmlAddLink(htmls, desc, "pmid");
        htmlAddLink(htmls, desc, "dbgap");
        htmlAddLink(htmls, desc, "sra_study");
        htmlAddLink(htmls, desc, "bioproject");
        htmlAddLink(htmls, desc, "sra");
        htmlAddLink(htmls, desc, "doi");
        htmlAddLink(htmls, desc, "arrayexpress");
        htmlAddLink(htmls, desc, "cirm_dataset");
        htmlAddLink(htmls, desc, "ega_study");
        htmlAddLink(htmls, desc, "ega_dataset");
        htmlAddLink(htmls, desc, "ena_project");
        htmlAddLink(htmls, desc, "hca_dcp");

        if (desc.urls) {
            for (let key in desc.urls)
                htmlAddLink(htmls, desc.urls, key, key);
        }

        if (desc.custom) {
            for (let key in desc.custom) {
                htmls.push("<b>"+key+": </b> "+desc.custom[key]);
                htmls.push("<br>");
            }
        }

        if (desc.submitter) {
            htmls.push("<b>Submitted by: </b> "+desc.submitter);
            if (desc.submission_date) {
                htmls.push(" ("+desc.submission_date);
                htmls.push(")");
            }
            if (desc.version)
                htmls.push(", Version "+desc.version);
            htmls.push("<br>");
        }

        if (desc.shepherd) {
            htmls.push("<b>UCSC Data Shepherd: </b> "+desc.shepherd);
            htmls.push("<br>");
        }
        if (desc.wrangler) {
            htmls.push("<b>UCSC Data Wrangler: </b> "+desc.wrangler);
            htmls.push("<br>");
        }

        // collections have no downloads tab, but multiomic-gbm wants supplementary files there, so make them appear
        buildSupplFiles(desc, datasetInfo.name, htmls);

        let topName = datasetInfo.name.split("/")[0];
        if (pageAtUcsc()) {
            if (datasetInfo.name!=="") {
                // Only do this if this is not the root dataset
                if ((datasetInfo.parents) && (datasetInfo.parents.length > 1)) {
                    // if the dataset is a collection
                    htmls.push("<b>Direct link to this collection for manuscripts: </b> https://"+topName+".cells.ucsc.edu");
                    htmls.push("<br>");
                }
                else {
                    htmls.push("<b>Direct link to this plot for manuscripts: </b> https://"+topName+".cells.ucsc.edu");
                    htmls.push("<br>");
                }

            console.log(datasetInfo);

            if ( datasetInfo.atacSearch) {
                    htmls.push("<b>ATAC-seq search gene models: </b>" + datasetInfo.atacSearch);
                    htmls.push("<br>");
            }

            htmls.push("<b>Dataset classification: </b>");

            buildClassification(htmls, datasetInfo, "body_parts", "Organs", true);
            buildClassification(htmls, datasetInfo, "diseases", "Diseases", true);
            buildClassification(htmls, datasetInfo, "organisms", "Organism", true);
            buildClassification(htmls, datasetInfo, "life_stages", "Life Stage", true);
            buildClassification(htmls, datasetInfo, "domains", "Scientific Domain", true);
            buildClassification(htmls, datasetInfo, "sources", "Source Database", false);

            htmls.push("<p style='padding-top: 8px'>If you use the Cell Browser of this dataset, please cite the " +
                    "original publication and " +
                    "<a href='https://academic.oup.com/bioinformatics/article/37/23/4578/6318386' target=_blank>" +
                    "Speir et al. 2021</a>. Feedback? Email us at <a href='cells@ucsc.edu' " +
                    "target='_blank'>cells@ucsc.edu</a>."+
                    "</p>");

            htmls.push("<p style='padding-top: 8px'><small>Cell Browser dataset ID: "+datasetInfo.name+
                    "</small></p>");

            }
        }

        $( "#pane1" ).html(htmls.join(""));

        buildMethodsPane(datasetInfo, desc);
        buildDownloadsPane(datasetInfo, desc);
        buildImagesPane(datasetInfo, desc);

        $("#tpOpenDialogTabs").tabs("refresh");
        //.tabs("option", "active", 0) does not do the color change of the tab so doing this instead
        $("#tabLink1").click();
        $("area").click( function(ev) {
            var dsName = ev.target.href.split("/").pop();
            loadDataset(gOpenDataset.name+"/"+dsName, true);
            $(".ui-dialog-content").dialog("close");
            ev.preventDefault();
        });

    }

    function getFacetString(ds, facetName) {
        /* search for an attribute under ds.facets or directly under ds, for backwards compatibility, and return as a |-sep string */
        let facets = [];
        if (ds.facets!==undefined && ds.facets[facetName]!==undefined)
            facets =  ds.facets[facetName];
        if (ds[facetName]!==undefined)
            facets =  ds[facetName];
        facets = cleanStrings(facets);
        let facetStr = facets.join("|");
        return facetStr;
    }
    function buildListPanel(datasetList, listGroupHeight, leftPaneWidth, htmls, selName) {
        /* make a dataset list and append its html lines to htmls */
        htmls.push("<div id='tpDatasetList' class='list-group' style='float: left; margin-top: 1em; height:"+listGroupHeight+"px; overflow-y:scroll; width:"+leftPaneWidth+"px'>");
        if (!datasetList || datasetList.length===0) {
            alert("No datasets are available. Please make sure that at least one dataset does not set visibility=hide "+
                " or that at least one collection is defined. Problems? -> cells@ucsc.edu");
            return;
        }

        var selIdx = 0;
        for (var i = 0; i < datasetList.length; i++) {
            var dataset = datasetList[i];

            var clickClass = "tpDatasetButton";
            if (dataset.isCollection)
                clickClass = "tpCollectionButton";
            if (dataset.name===selName || (selName===undefined && i===0)) {
                clickClass += " active";
                selIdx = i;
            }

            let bodyPartStr = getFacetString(dataset, "body_parts");
            let disStr = getFacetString(dataset, "diseases");
            let orgStr = getFacetString(dataset, "organisms");
            let projStr = getFacetString(dataset, "projects");
            let domStr = getFacetString(dataset, "domains");
            let lifeStr = getFacetString(dataset, "life_stages");
            let sourceStr = getFacetString(dataset, "sources");

            var line = "<a id='tpDatasetButton_"+i+"' "+
                "data-body='"+bodyPartStr+"' "+
                "data-dis='"+disStr+"' "+
                "data-org='"+orgStr+"' "+
                "data-proj='"+projStr+"' "+
                "data-dom='"+domStr+"' "+
                "data-source='"+sourceStr+"' "+
                "data-stage='"+lifeStr+"' "+
                "role='button' class='tpListItem list-group-item "+clickClass+"' data-datasetid='"+i+"'>"; // bootstrap seems to remove the id
            htmls.push(line);

            if (!dataset.isSummary)
                htmls.push('<button type="button" class="btn btn-primary btn-xs load-dataset" data-placement="bottom">Open</button>');

            if (dataset.sampleCount!==undefined) {
                var countDesc = prettyNumber(dataset.sampleCount);
                htmls.push("<span class='badge' style='background-color: #888'>"+countDesc+"</span>");
            }

            if (dataset.datasetCount!==undefined) {
                htmls.push("<span class='badge' style='background-color: #28a745'>"+dataset.datasetCount+" datasets</span>");
            }

            if (dataset.collectionCount!==undefined) {
                htmls.push("<span class='badge' style='background-color: #188725'>"+dataset.collectionCount+" collections</span>");
            }

            //if (dataset.tags!==undefined) {
                //for (var tagI = 0; tagI < dataset.tags.length; tagI++) {
                    //var tag = dataset.tags[tagI];
                    //if (tag==="smartseq2" || tag==="ATAC" || tag==="10x")
                        //continue
                    //htmls.push("<span class='badge'>"+tag+"</span>");
                //}
            //}
            htmls.push(dataset.shortLabel+"</a>");
        }
        htmls.push("</div>"); // list-group
        return selIdx;
    }

    function getDatasetAttrs(datasets, attrName) {
        /* return an array of (attrName, "attrName (count)") of all attrNames (e.g. body_parts) in a dataset array */
        var valCounts = {};
        for (let i=0; i < datasets.length; i++) {
            let facetObj = datasets[i];
            if (facetObj.facets) // facets can be stored on the objects (old) or on a separate ds.facets object (new)
                facetObj = facetObj.facets;

            if (facetObj[attrName]===undefined)
                continue
            for (let bp of facetObj[attrName])
                if (bp in valCounts)
                    valCounts[bp]++;
                else
                    valCounts[bp] = 1;
        }

        let allValues = keys(valCounts);
        allValues.sort();

        var valLabels = {};
        for (let i=0; i < allValues.length; i++) {
            var key = allValues[i];
            var count = valCounts[key];
            var labelKey = key;
            if (labelKey==="")
                labelKey = "-empty-"
            var label = labelKey+" ("+count+")"
            valLabels[key] = label;
        }
        return Object.entries(valLabels);
    }

    function filterDatasetsDom() {
        /* keep only datasets that fulfill the filters */

        // read the current filter values of the dropboxes
        var categories = ["Body", "Dis", "Org", "Proj", "Stage", "Dom", "Source"];
        var filtVals = {};
        for (var category of categories) {
            var vals = $("#tp"+category+"Combo").val();
            if (vals===undefined)
                vals = [];

            // strip special chars
            var cleanVals = [];
            for (var val of vals)
                cleanVals.push(cleanString(val));

            filtVals[category] = cleanVals;
        }

        let elList = $(".tpListItem");
        var shownCount = 0;
        var hideCount = 0;
        for (let el of elList) {
            // never touch the first/summary element
            if (el.getAttribute("data-body")==="summary")
                continue
            // read the values of the current DOM element
            var domVals = {};
            for (var category of categories)
                domVals[category] = el.getAttribute("data-"+category.toLowerCase());

            var isShown = true;
            // now compare filtVals and domVals
            for (var category of categories) {
                var filtList = filtVals[category];
                var domList = domVals[category];

                let found = false;
                if (filtList.length===0)
                    found = true;
                for (var filtVal of filtList)
                    if (domList.indexOf(filtVal)!=-1)
                        found = true;

                if (!found) {
                    isShown = false;
                    break;
                }
            }
            
            if (isShown) {
                el.style.display="";
                shownCount++;
            }
            else {
                el.style.display="none";
                hideCount++;
            }
        }
        if (hideCount!==0)
            $('#tpDatasetCount').text("(filters active, "+shownCount+" datasets shown)");
        else
            $('#tpDatasetCount').text("("+shownCount+" dataset collections)");
    }

    function openDatasetDialog(openDsInfo, selName, openTab) {
    /* build dataset open dialog,
     * - openDsInfo is the currently open object or a collection.
     * - selName is the currently selected dataset in this list
     * - openTab is optional, "images" opens the image tab
     */

        var datasetList = [];
        var listGroupHeight = 0;
        var leftPaneWidth = 400;
        var title = "Choose Cell Browser Dataset";

        // inline functions
        function openCollOrDataset(selDatasetIdx) {
            /* click handler, opens either a collection or a dataset */
            history.pushState({}, "Cell Browser Main Page", window.location.href);
            var dsInfo = datasetList[selDatasetIdx];
            var datasetName = dsInfo.name;
            if (dsInfo.isCollection)
                showCollectionDialog(datasetName);
            else
                loadDataset(datasetName, true, dsInfo.md5);
            $(".ui-dialog-content").dialog("close");
            //changeUrl({"bp":null});
        }

        function buildFilter(html, filterVals, filterLabel, urlVar, comboId, comboLabel) {
            /* build html for a faceting filter */
            if (filterVals.length==0)
                return false;
            html.push("<span style='margin-right:5px'>"+filterLabel+":</span>");
            let selPar = getVarSafe(urlVar);
            if (selPar && selPar!=="")
                filtList = selPar.split("|");
            buildComboBox(html, comboId, filterVals, filtList, comboLabel, 200, {multi:true});
            html.push("&nbsp;&nbsp;");
            return true;
        }

        function connectOpenPane(selDatasetIdx, datasetList) {
            /* set all the click handlers for the left open dataset pane */
            $("button.list-group-item").eq(selDatasetIdx).css("z-index", "1000"); // fix up first overlap
            $("button.list-group-item").keypress(function(e) {
                // load the current dataset when the user presses Return
                if (e.which === '13') {
                    openCollOrDataset(selDatasetIdx);
                }
            });
            $(".list-group-item").click( function (ev) {
                selDatasetIdx = parseInt($(ev.target).data('datasetid')); // index of clicked dataset
                $(".list-group-item").removeClass("active");
                $('#tpDatasetButton_'+selDatasetIdx).bsButton("toggle"); // had to rename .button() in index.html
                var datasetInfo = datasetList[selDatasetIdx];
                openDatasetLoadPane(datasetInfo);
            });
            $(".list-group-item").dblclick( function(ev) {
                selDatasetIdx = parseInt($(this).data('datasetid'));
                openCollOrDataset(selDatasetIdx);
            });
            $(".load-dataset").click( function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                selDatasetIdx = parseInt($(this).parents('.list-group-item').data('datasetid'));
                openCollOrDataset(selDatasetIdx);
                return false;
            });
            $(".list-group-item").focus( function (event) {
                selDatasetIdx = parseInt($(event.target).data('datasetid')); // index of clicked dataset
                // bootstrap has a bug where the blue selection frame is hidden by neighboring buttons
                // Working around this here by bumping up the current z-index.
                $("button.list-group-item").css("z-index", "0");
                $("button.list-group-item").eq(selDatasetIdx).css("z-index", "1000");
            });
        }

        function onFilterChange(ev) {
            /* called when user changes a filter: updates list of datasets shown */
            var filtNames = $(this).val();

            var param = null;
            if (this.id==="tpBodyCombo")
                param = "bp";
            else if (this.id=="tpDisCombo")
                param = "dis";
            else if (this.id=="tpOrgCombo")
                param = "org";
            else if (this.id=="tpProjCombo")
                param = "proj";
            else if (this.id=="tpDomCombo")
                param = "dom";
            else if (this.id=="tpStageCombo")
                param = "stage";

            // change the URL
            var filtArg = filtNames.join("~");
            var urlArgs = {}
            urlArgs[param] = filtArg;
            changeUrl(urlArgs);
            filterDatasetsDom();
        }

        // -- end inline functions

        gOpenDataset = openDsInfo;
        var activeIdx = 0;
        var onlyInfo = false;

        datasetList = openDsInfo.datasets;

        if (datasetList===undefined)
            onlyInfo = true;

        var noteLines = [];

        // if this is a collection, not a dataset, change descriptive text in dialog
        if (datasetList && gOpenDataset.name!=="") {
            let dsCount = datasetList.length;
            title = 'Select one dataset from the collection "'+openDsInfo.shortLabel+'"';
            title = title.replace(/'/g, "&apos;");
            noteLines.push( "<p>The collection '"+openDsInfo.shortLabel+"' contains "+dsCount+" datasets. " +
                "Double-click or click 'Open' below.<br>To move between datasets later in the cell browser, " +
                "use the 'Collection' dropdown. </p>");

            changeUrl({"ds":openDsInfo.name.replace(/\//g, " ")}); // + is easier to type
        }

        let doFilters = false;
        let filtList = [];
        let bodyParts = null;
        let diseases = null;
        let organisms = null;
        let projects = null;
        let lifeStages = null;
        let domains = null;
        let sources = null;

        if (openDsInfo.parents === undefined && openDsInfo.datasets !== undefined) {
            bodyParts = getDatasetAttrs(openDsInfo.datasets, "body_parts");
            diseases = getDatasetAttrs(openDsInfo.datasets, "diseases");
            organisms = getDatasetAttrs(openDsInfo.datasets, "organisms");
            projects = getDatasetAttrs(openDsInfo.datasets, "projects");
            lifeStages = getDatasetAttrs(openDsInfo.datasets, "life_stages");
            domains = getDatasetAttrs(openDsInfo.datasets, "domains");
            sources = getDatasetAttrs(openDsInfo.datasets, "sources");

            // mirror websites are not using the filters at all. So switch off the entire filter UI if they're not used
            if (bodyParts.length!==0 || diseases.length!==0 || organisms.length!==0 || projects.length!==0 || domains.length!==0 || lifeStages.length!==0 || sources.length!==0)
                doFilters = true;

            if (doFilters) {
                noteLines.push("<div style='margin-right: 10px; font-weight: bold'>Filters: <span id='tpDatasetCount'></span></div>");

                buildFilter(noteLines, bodyParts, "Organ", "body", "tpBodyCombo", "select organs...");
                buildFilter(noteLines, diseases, "Disease", "dis", "tpDisCombo", "select diseases...");
                buildFilter(noteLines, organisms, "Species", "org", "tpOrgCombo", "select species...");
                buildFilter(noteLines, projects, "Project", "proj", "tpProjCombo", "select project...");
                noteLines.push("<div style='height:4px'></div>");
                buildFilter(noteLines, lifeStages, "Life Stages", "stage", "tpStageCombo", "select stage...");
                buildFilter(noteLines, domains, "Scient. Domain", "dom", "tpDomCombo", "select domain...");
                buildFilter(noteLines, sources, "Source DB", "source", "tpSourceCombo", "select db...");
            }
        }

        // create links to the parents of the dataset
        if (openDsInfo && openDsInfo.parents && !onlyInfo) {

            noteLines.push("Go back to: " );
            // make the back links
            let backLinks = [];
            let allParents = [];
            let parents = openDsInfo.parents;
            for (let i=0; i<parents.length; i++) {
                let parentInfo = parents[i];
                let parName = parentInfo[0];

                let parLabel = parentInfo[1];
                let childName = null;
                if (i === parents.length-1)
                    childName = openDsInfo.name;
                else
                    childName = parents[i+1][0];

                allParents.push(parName);
                backLinks.push("<span class='tpBackLink link' data-open-dataset='"+allParents.join("/")+"' data-sel-dataset='"+childName+"'>"+parLabel+"</span>");
            }
            noteLines.push(backLinks.join("&nbsp;&gt;&nbsp;"));
        }

        if (onlyInfo)
            title = "Dataset Information";
        else {
            datasetList.unshift( {
                shortLabel:"Overview",
                name:openDsInfo.name,
                hasFiles:openDsInfo.hasFiles,
                body_parts:["summary"],
                isSummary:true,
                abstract:openDsInfo.abstract
            });
        }

        var winWidth = window.innerWidth - 0.05*window.innerWidth;
        var winHeight = window.innerHeight - 0.05*window.innerHeight;
        var tabsWidth = winWidth - leftPaneWidth - 50;
        listGroupHeight = winHeight - 100;

        var htmls = ["<div style='line-height: 1.1em'>"];
        htmls.push(noteLines.join(""));
        htmls.push("</div>");

        htmls.push("<div id='tpDatasetBrowser'>");

        if (onlyInfo) {
            leftPaneWidth = 0;
            htmls.push("<div></div>"); // keep structure of the page the same, skip the left pane
        } else {
            activeIdx = buildListPanel(datasetList, listGroupHeight, leftPaneWidth, htmls, selName);
            htmls.push("<div id='tpOpenDialogDatasetDesc' style='width:"+tabsWidth+"px; float:right; left: " + (leftPaneWidth + 10) + "px; margin-top: 1em; border: 0'>");
        }

        htmls.push("<div id='tpOpenDialogTabs' style='border: 0'>");
        htmls.push("<ul class='nav nav-tabs'>");
        htmls.push("<li class='active'><a class='tpDatasetTab' id='tabLink1' data-toggle='tab' href='#pane1'>Abstract</a></li>");
        htmls.push("<li><a class='tpDatasetTab' id='tabLink2' data-toggle='tab' href='#pane2'>Methods</a></li>");
        htmls.push("<li><a class='tpDatasetTab' id='tabLink3' data-toggle='tab' style='display:none' href='#pane3'>Data Download</a></li>");
        htmls.push("<li><a class='tpDatasetTab' id='tabLinkImg' data-toggle='tab' href='#paneImg'>Images</a></li>");
        htmls.push("</ul>");

        htmls.push("<div id='pane1' class='tpDatasetPane tab-pane'>");
        htmls.push("<p>Loading abstract...</p>");
        htmls.push("</div>");

        htmls.push("<div id='pane2' class='tpDatasetPane tab-pane'>");
        htmls.push("<p>Loading methods...</p>");
        htmls.push("</div>");

        htmls.push("<div id='pane3' class='tpDatasetPane tab-pane'>");
        htmls.push("<p>Loading download instructions...</p>");
        htmls.push("</div>");

        htmls.push("<div id='paneImg' class='tpDatasetPane tab-pane'>");
        htmls.push("<p>Loading image data...</p>");
        htmls.push("</div>");

        htmls.push("</div>"); // tpOpenDialogTabs

        htmls.push("</div>"); // tpOpenDialogDatasetDesc

        //htmls.push("<div id='tpSelectedId' data-selectedid='0'>"); // store the currently selected datasetId in the DOM
        htmls.push("</div>"); // tpDatasetBrowser

        var selDatasetIdx = 0;

        var buttons = [];
        if (db!==null) {
            var cancelLabel = "Cancel";
            if (onlyInfo)
                cancelLabel = "Close";
            buttons.push( {
                text: cancelLabel,
                click: function() {
                    $( this ).dialog( "close" );
                    if (openDsInfo.isCollection)
                        openDatasetDialog(openDsInfo, null); // show top-level dialog
                }
            });
        }

        $(".ui-dialog-content").dialog("close"); // close the last dialog box

        showDialogBox(htmls, title, {width: winWidth, height:winHeight, buttons: buttons});

        $("#tpOpenDialogTabs").tabs();

        // little helper function
        function activateFilterCombo(valList, comboId) {
            if (valList) {
                activateCombobox(comboId, 200);
                $("#"+comboId).change( onFilterChange );
            }
        }

        if (doFilters) {
            activateFilterCombo(bodyParts, "tpBodyCombo");
            activateFilterCombo(diseases, "tpDisCombo");
            activateFilterCombo(organisms, "tpOrgCombo");
            activateFilterCombo(projects, "tpProjCombo");
            activateFilterCombo(lifeStages, "tpStageCombo");
            activateFilterCombo(domains, "tpDomCombo");
            activateFilterCombo(sources, "tpSourceCombo");
        }

        $('.tpBackLink').click( function(ev) {
            let openDatasetName = $(ev.target).attr('data-open-dataset');
            let selDatasetName = $(ev.target).attr('data-sel-dataset');
            loadCollectionInfo(openDatasetName, function(newCollInfo) {
                openDatasetDialog(newCollInfo, selDatasetName);
            });
            changeUrl({"ds":openDatasetName.replace(/\//g, " ")});
        });

        var focused = document.activeElement;
        var scroller = $("#tpDatasetList").overlayScrollbars({ });
        $(focused).focus();


        $("#tabLink1").tab("show");

        if (activeIdx!==null && !onlyInfo) {
            if (activeIdx!==0)
                scroller.scroll($("#tpDatasetButton_"+activeIdx)); // scroll left pane to current button
            $("tpDatasetButton_"+activeIdx).addClass("active");
        }

        if (getVarSafe("ds")===undefined) // only filter on the top level
            filterDatasetsDom();
        connectOpenPane(selDatasetIdx, datasetList);
        // finally, activate the default pane and load its html
        openDatasetLoadPane(openDsInfo, openTab);
    }

    function onHideSelClick(ev) {
        /* hide all selected cells */
        renderer.selectHide();
        renderer.drawDots();
        updateSelectionButtons();
    }

    function onOnlySelClick(ev) {
        /* show only selected, hide all unselected cells */
        renderer.selectOnlyShow();
        renderer.drawDots();
        updateSelectionButtons();
    }

    function onShowAllClick(ev) {
        /* show all cells, hidden or not. Do not touch the selection. */
        renderer.unhideAll();
        renderer.drawDots();
        $("#tpShowAll").hide()
    }

    function updateSelectionButtons() {
        /* remove the selection buttons if that's possible */
        let visCount = renderer.getVisibleCount();
        let totalCount = renderer.getCount();
        let hiddenCount = totalCount - visCount;

        if (hiddenCount===0)
            $("#tpShowAll").hide();
        else
            $("#tpShowAll").show();

        if (renderer.hasSelected()) {
            $(".tpSelectButton").show();
        } else {
            $(".tpSelectButton").hide();
        }
    }

    function buildSelectActions() {
        /* add buttons for hide selected / unselected to ribbon bar */
        if (getById("tpHideSel")!==null)
            return;

        let htmls = [];
        htmls.push('<button style="display:none" title="Hide selected cells" id="tpHideSel" type="button" class="tpRibbonButton tpSelectButton" data-placement="bottom">Hide selected</button>');
        htmls.push('<button style="display:none" title="Hide all unselected cells" id="tpOnlySel" type="button" class="tpRibbonButton tpSelectButton" data-placement="bottom">Only show selected</button>');
        htmls.push('<button style="display:none" title="Show all cells that were hidden before" id="tpShowAll" type="button" class="tpRibbonButton" data-placement="bottom">Show all</button>&nbsp;&nbsp;&nbsp;');
        //htmls.push('');
        getById('tpToolBar').insertAdjacentHTML('afterbegin', htmls.join(""));
        getById('tpHideSel').addEventListener('click', onHideSelClick);
        getById('tpOnlySel').addEventListener('click', onOnlySelClick);
        getById('tpShowAll').addEventListener('click', onShowAllClick);
    }

    function onSelChange(selection) {
    /* called each time when the selection has been changed */
        var cellIds = [];
        selection.forEach(function(x) {cellIds.push(x)});
        $("#tpSetBackground").parent("li").removeClass("disabled");

        updateSelectionButtons();
        if (cellIds.length===0 || cellIds===null) {
            clearMetaAndGene();
            clearSelectionState();
            $("#tpSetBackground").parent("li").addClass("disabled");
            //clearSelectActions();
        } else if (cellIds.length===1) {
            $("#tpHoverHint").hide();
            $("#tpSelectHint").show();
            var cellId = cellIds[0];
            var cellCountBelow = cellIds.length-1;
            updateMetaBarCustomFields(cellId);
            db.loadMetaForCell(cellId, function(ci) {
                updateMetaBarOneCell(ci, cellCountBelow);
            }, onProgress);
        } else {
            $("#tpHoverHint").hide();
            $("#tpSelectHint").show();
            updateMetaBarManyCells(cellIds);
        }

        updateGeneTableColors(cellIds);
        if ("geneSym" in gLegend)
            buildViolinPlot();

        //var cols = renderer.col.arr;
        //var selectedLegends = {};
        //for (var i = 0; i < gLegend.rows.length; i++) {
            //selectedLegends[i] = 0;
        //}
        //selection.forEach(function(cellId) {
            //selectedLegends[cols[cellId]]++;
        //});
        //for (var i = 0; i < gLegend.rows.length; i++) {
            //if (selectedLegends[i] == gLegend.rows[i].count) {
                //$("#tpLegendCheckbox_" + i).prop("checked", true);
            //} else {
                ////$("#tpLegendCheckbox_" + i).prop("checked", false);
            //}
        //}
        //updateLegendGrandCheckbox();
    }

    function onRadiusAlphaChange(radius, alpha) {
        /* user changed alpha or radius value */
        getById("tpSizeInput").value = radius;
        getById("tpAlphaInput").value = alpha;
    }
    function onSaveAsClick() {
    /* File - Save Image as ... */
        var canvas = $("canvas")[0];
        canvas.toBlob(function(blob) { saveAs( blob , "cellBrowser.png"); } , "image/png");
    }

    function onSaveAsSvgClick() {
    /* File - Save Image as vector ... */
        renderer.drawDots("svg")
        renderer.svgLabelWidth = 300;
        renderer.drawLegendSvg(gLegend)
        var lines = renderer.getSvgText()
        var blob = new Blob(lines, {type:"image/svg+xml"});
        window.saveAs( blob , "cellBrowser.svg");
        renderer.drawDots()
    }

    function onSelectAllClick() {
    /* Edit - select all visible*/
        clearSelectionState();
        renderer.selectClear();
        renderer.selectVisible();
        renderer.drawDots();
    }

    function clearSelectionAndDraw() {
        /* do everything needed to clear the selection */
        // clear checkboxes and colored highlight
        clearSelectionState();
        renderer.selectClear();
        renderer.drawDots();
    }

    function onSelectNoneClick() {
    /* Edit - Select None */
        clearSelectionAndDraw();
    }

    function onSelectInvertClick() {
    /* Edit - Invert selection */
        clearSelectionState();
        renderer.selectInvert();
        renderer.drawDots();
    }

    function buildOneComboboxRow(htmls, comboWidth, rowIdx, queryExpr) {
        /* create one row of combobox elements in the select dialog */
        htmls.push('<div class="tpSelectRow" id="tpSelectRow_'+rowIdx+'">');
        // or &#x274e; ?
        htmls.push('<span style="cursor: default; font-size:1.2em" id="tpSelectRemove_'+rowIdx+'">&#xd7;</span>&nbsp;'); // unicode: mult sign
        htmls.push('<select name="type" id="tpSelectType_'+rowIdx+'">');
        htmls.push('<option value="meta">Cell annotation field</option><option value="expr">Expression of gene </option>');
        htmls.push('</select>');

        buildMetaFieldCombo(htmls, "tpSelectMetaComboBox_"+rowIdx, "tpSelectMetaCombo_"+rowIdx, 0);

        var id = "tpSelectGeneCombo_"+rowIdx;
        htmls.push('<select style="width:'+comboWidth+'px" id="'+id+'" placeholder="gene search..." class="tpCombo">');
        htmls.push('</select>');

        htmls.push('<select name="operator" id="tpSelectOperator_'+rowIdx+'">');
        htmls.push('<option value="eq" selected>is equal to</option>');
        htmls.push('<option value="neq" selected>is not equal to</option>');
        htmls.push('<option value="gt">is greater than</option>');
        htmls.push('<option value="lt">is less than</option>');
        htmls.push('</select>');

        htmls.push('<input id="tpSelectValue_'+rowIdx+'" type="text" name="exprValue">');
        htmls.push('</input>');

        htmls.push('<select style="max-width: 300px" id="tpSelectMetaValueEnum_'+rowIdx+'" name="metaValue">');
        htmls.push('</select>');
        htmls.push('</div>'); // tpSelectRow_<rowIdx>

        htmls.push('<p>');
    }

    function chosenSetValue(elId, value) {
        //var el = getById(elId);
        //el.value = ("tpMetaVal_"+fieldIdx);
        //el.trigger('chosen:updated'); // update the meta dropdown
        // looks like this needs jquery
        $('#'+elId).val(value).trigger('chosen:updated'); // somehow chosen needs this?
    }

    function findCellsUpdateMetaCombo(rowIdx, fieldIdx) {
        /* given the row and the ID name of the field, setup the combo box row */
        var metaInfo = db.getMetaFields()[fieldIdx];
        var valCounts = metaInfo.valCounts;
        var shortLabels = metaInfo.ui.shortLabels;
        //$('#tpSelectMetaCombo_'+rowIdx).val("tpMetaVal_"+fieldIdx).trigger('chosen:updated'); // update the meta dropdown
        chosenSetValue('tpSelectMetaCombo_'+rowIdx, "tpMetaVal_"+fieldIdx);

        if (valCounts===undefined) {
            // this is a numeric field
            $('#tpSelectValue_'+rowIdx).val("");
            $('#tpSelectValue_'+rowIdx).show();
            $('#tpSelectMetaValueEnum_'+rowIdx).hide();
        } else {
            // it's an enum field
            $('#tpSelectValue_'+rowIdx).hide();
            $('#tpSelectMetaValueEnum_'+rowIdx).empty();
            for (var i = 0; i < valCounts.length; i++) {
                //var valName = valCounts[i][0];
                var valLabel = shortLabels[i];
                $('#tpSelectMetaValueEnum_'+rowIdx).append("<option value='"+i+"'>"+valLabel+"</option>");
            }
            $('#tpSelectMetaValueEnum_'+rowIdx).show();
        }
    }

    function findCellsUpdateRowType(rowIdx, rowType) {
        if (rowType === "meta") {
            $("#tpSelectType_"+rowIdx).val("meta");
            $("#tpSelectGeneCombo_"+rowIdx).next().hide();
            $("#tpSelectValue_"+rowIdx).hide();
            $("#tpSelectMetaComboBox_"+rowIdx).show();
            $("#tpSelectMetaValueEnum_"+rowIdx).show();
        } else {
            $("#tpSelectType_"+rowIdx).val("expr");
            $("#tpSelectGeneCombo_"+rowIdx).next().show();
            $("#tpSelectValue_"+rowIdx).show();
            $("#tpSelectMetaComboBox_"+rowIdx).hide();
            $("#tpSelectMetaValueEnum_"+rowIdx).hide();
        }
    }

    function connectOneComboboxRow(comboWidth, rowIdx, query) {
        /* Filter dialog. Call the jquery inits and setup the change listeners for a combobox row */
        /* Yes, a UI framework, like react or angular, would be very helpful here */

        // first of all: check if the meta name actually exists in this dataset still
        let metaInfo = null;
        var metaName = query["m"];
        if (metaName!==undefined) {
            metaInfo = db.findMetaInfo(metaName);
            if (metaInfo===null)
                return;
        }

        // auto-suggest for gene searches
        $('#tpSelectGeneCombo_'+rowIdx).selectize({
                "labelField" : 'text',
                "valueField" : 'id',
                "searchField" : 'text',
                "load" : comboLoadGene,
       });
        activateCombobox("tpSelectMetaCombo_"+rowIdx, comboWidth);

        $('#tpSelectRemove_'+rowIdx).click( function(ev) {
            //console.log(ev);
            var rowToDel = (this.id).split("_")[1];
            $("#tpSelectRow_"+rowToDel).remove();
        });

        //$("#tpSelectGeneCombo_"+rowIdx).next().hide();
        //$("#tpSelectValue_"+rowIdx).hide();


        var rowType = "gene";
        var op = getQueryOp(query);
        if (metaName===undefined) {
            // this is a gene query
            findCellsUpdateRowType(rowIdx, rowType);
            selectizeSetValue("tpSelectGeneCombo_"+rowIdx, query["g"]);
            $("#tpSelectValue_"+rowIdx).val(query[op]);
        } else {
            // it's a meta query
            rowType = "meta";
            findCellsUpdateRowType(rowIdx, rowType);
            findCellsUpdateMetaCombo(rowIdx, metaInfo.index);
            var enumIdx = findMetaValIndex(metaInfo, query[op]);
            $("#tpSelectMetaValueEnum_"+rowIdx).val(enumIdx);
        }
        $("#tpSelectOperator_"+rowIdx).val(op);

        $('#tpSelectMetaCombo_'+rowIdx).change(function(ev) {
            // when the user changes the meta field, update the list of meta field values in the dropdown
            var selVal = this.value;
            var fieldIdx = parseInt(selVal.split("_")[1]);
            findCellsUpdateMetaCombo(rowIdx, fieldIdx);
        });

        $('#tpSelectType_'+rowIdx).change(function(ev) {
            // when the user changes the gene expression / meta dropdown, hide/show the
            // respective other dropdowns
            var rowType = this.value;
            findCellsUpdateRowType(rowIdx, rowType);
        });
    }

    function readSelectForm() {
        /* convert the current state of the dialog box to a short string and return it */
        // example: [{"g":"PITX2", "gt":0.05}, {"m":"Cluster", "eq":"cluster 2"}]
        // XX TODO: non-enum meta data fields ???
        var queries = [];

        var rowCount = $(".tpSelectRow").length;
        for (var rowIdx=0;  rowIdx<rowCount; rowIdx++) {
            var query = {};
            var op = $('#tpSelectOperator_'+rowIdx).val();

            var queryType = $('#tpSelectType_'+rowIdx).val();
            if (queryType==="expr") {
                var gene = $('#tpSelectGeneCombo_'+rowIdx).val();
                var val = $('#tpSelectValue_'+rowIdx).val();
                query["g"] = gene;
                query[op] = val;
            }
            else {
                var metaValTag = $('#tpSelectMetaCombo_'+rowIdx).val();
                if (metaValTag===undefined)
                    continue; // if the user deleted a row
                var metaIdx = parseInt(metaValTag.split("_")[1]);
                var metaInfo = db.conf.metaFields[metaIdx];
                var metaName = metaInfo.name;
                query["m"] = metaName;

                var opVal = null;
                var selOp = null;
                if (metaInfo.type==="enum") {
                    let selVal = $('#tpSelectMetaValueEnum_'+rowIdx).val();
                    var valIdx = parseInt(selVal);
                    opVal = db.conf.metaFields[metaIdx].valCounts[valIdx][0];
                } else {
                    let selVal = $('#tpSelectValue_'+rowIdx).val();
                    opVal = parseFloat(selVal);
                }

                query[op] = opVal;
            }
            queries.push(query);
        }
        return queries;
    }

    function greaterThan(x, y) { return (x>y); }
    function lessThan(x, y) { return (x<y); }
    function equals(x, y) { return (x===y); }
    function notequals(x, y) { return (x!==y); }

    function getQueryOp(query) {
        if ("eq" in query) return "eq";
        if ("neq" in query) return "neq";
        if ("gt" in query) return "gt";
        if ("lt" in query) return "lt";
    }

    function makeFuncAndVal(query) {
        /* return a comparator function and the value given a query object */
        var compFunc = equals;
        var val = query["eq"];

        if ("lt" in query) {
            compFunc = lessThan;
            val = query["lt"];
        }
        if ("gt" in query) {
            compFunc = greaterThan;
            val = query["gt"];
        }
        if ("neq" in query) {
            compFunc = notequals;
            val = query["neq"];
        }

        return [compFunc, val];
    }

    function searchArrayForFuncAndVal(arr, funcAndVal) {
        /* given an array and function and a value, return an array with the indices the matching array elements */
        var compFunc = funcAndVal[0];
        var compVal  = funcAndVal[1];
        var selCells = [];
        for (var i=0; i<arr.length; i++) {
            if (compFunc(arr[i], compVal))
                selCells.push(i);
        }
        return selCells;
    }

    function findCellsMatchingQueryList(queries, onDone) {
        /* given a list of dicts, return the identifiers of the matching cells */
        /* example: [{"g":"PITX2", "gt":0.05}, {"m":"Cluster", "eq":"cluster 2"}] */

        var doneQueries = 0;
        var queryResults = [];

        function allQueriesDone() {
            // XX this could use a promise framework
            if (queryResults.length===1)
                onDone(queryResults[0]);
            else
                onDone(intersectArrays(queryResults));
        }

        function gotGeneVec(exprArr, sym, desc, funcVal) {
            funcVal[1] = Number(funcVal[1]); // for gene queries, must be a number, not string
            var selCells = searchArrayForFuncAndVal(exprArr, funcVal);
            queryResults.push(selCells);
            doneQueries++;
            if (doneQueries===queries.length)
                allQueriesDone();
        }

        function gotMetaArr(metaArr, metaInfo, funcVal) {
            /* filter meta data array with funcVal = function + value  */
            if (metaInfo.origVals)
                metaArr = metaInfo.origVals; // numerical meta fields have the original numbers stored
            var selCells = searchArrayForFuncAndVal(metaArr, funcVal);
            queryResults.push(selCells);
            doneQueries++;
            if (doneQueries===queries.length)
                allQueriesDone();
        }

        var selCells = [];
        for (var i=0; i < queries.length; i++) {
            var query = queries[i];
            var funcVal = makeFuncAndVal(query); // [0] = function to compare, [1] = value for comparison
            if ("g" in query) {
                db.loadExprVec(query.g, gotGeneVec, null, funcVal);
            }
            else {
                var fieldName = query.m;
                var fieldIdx = cbUtil.findIdxWhereEq(db.conf.metaFields, "name", fieldName);
                var findVal = funcVal[1];

                var metaInfo = db.getMetaFields()[fieldIdx];
                if (metaInfo.type==="enum")
                    findVal = findMetaValIndex(metaInfo, findVal);

                let searchDesc = [funcVal[0], findVal];

                if (metaInfo.origVals)
                    // for numeric fields, the raw data is already in memory
                    gotMetaArr(metaInfo.origVals, metaInfo, searchDesc)
                else
                    // other fields may not be loaded yet
                    db.loadMetaVec(metaInfo, gotMetaArr, null, searchDesc, db.conf.binStrategy);
            }
        }
    }

    function makeSampleQuery() {
        /* find first enum meta field and return a query for its name and its first value */
        var metaFieldInfo = db.conf.metaFields;
        for (var i = 0; i < metaFieldInfo.length; i++) {
            var field = metaFieldInfo[i];
            if (field.type!=="enum")
                continue;
            var fieldName = field.name;
            var val1 = field.valCounts[0][0];
            return {"m":fieldName, "eq":val1};
        }
    }

    function addNewAnnotation(fieldLabel, newMetaValue, cellIds) {
        var metaInfo;
        let cellCount = db.conf.sampleCount;
        if (!db.getMetaFields()[0].isCustom) {
            // add a new enum meta field
            metaInfo = {
                name:"custom",
                label: fieldLabel,
                type: "enum",
                arr : Array.from(new Uint8Array(cellCount)), // cannot JSON-serialize Typed Arrays
                ui : {
                    shortLabels : ["No annotation"]
                },
                valCounts : [ ["No annotation", cellCount]]
            }
            db.addCustomMetaField(metaInfo);
            rebuildMetaPanel();
            activateTab("meta");
        } else
            metaInfo = db.getMetaFields()[0];

        metaInfo.ui.shortLabels.push( newMetaValue );
        let newValIdx = metaInfo.valCounts.length;
        metaInfo.valCounts.push( [newMetaValue, cellIds.length]);
        // update the "No annotation" count
        let noAnnotCount = metaInfo.valCounts[0][1];
        metaInfo.valCounts[0][1] = noAnnotCount - cellIds.length;

        let arr = metaInfo.arr;
        for (let i=0; i<cellIds.length; i++)
            arr[cellIds[i]] = newValIdx;
        // need to update the value histogram
        db.metaHist[metaInfo.name] = makeFieldHistogram(metaInfo, cellIds, arr);
        updateMetaBarManyCells(cellIds); // redo, as we rebuilt the meta panel

        var jsonStr = JSON.stringify(metaInfo);
        var comprStr = LZString.compress(jsonStr);
        localStorage.setItem(db.name+"|custom", comprStr);
        }

    function onSelectNameClick() {
        /* Edit > Name selection */

        let title = "Annotate selected "+gSampleDesc+"s";

        let htmls = [];
        htmls.push('<p>There are '+renderer.getSelection().length+' '+gSampleDesc+' in the current selection.</p>');

        htmls.push('<p><b>Name of annotation field</b>:<br>');
        htmls.push('<input class="tpDialogInput" id="tpFieldLabel" type="text" value="My custom annotations"></p>');
        htmls.push('<p><b>Annotate selected cells as:</b><br>');
        htmls.push('<input class="tpDialogInput" id="tpMetaVal" type="text"></p>');
        htmls.push('<p>Remove annotations later by clicking <b>Tools > Remove all annotations</b>.</p>');

        var dlgHeight = 400;
        var dlgWidth = 800;
        var buttons = [
            //"Close and remove all annotations" : function() {
                //db.getMetaFields().shift();
                //rebuildMetaPanel();
                //localStorage.removeItem(db.name+"|custom");
                //resetCustomAnnotations();
            //},
        {text:"OK", click: function() {
                let fieldLabel = $('#tpFieldLabel').val();
                if (fieldLabel==="")
                    fieldLabel = "My custom annotations";
                let newMetaValue = $("#tpMetaVal").val();
                if (newMetaValue==="")
                    return;

                addNewAnnotation(fieldLabel, newMetaValue, renderer.getSelection());
                $( this ).dialog( "close" );
                colorByMetaField("custom");
            }
        }];
        showDialogBox(htmls, title, {showClose:true, height:dlgHeight, width:dlgWidth, buttons:buttons});
        $("#tpMetaVal").focus();
        return true;
    }

    function onBackgroudSetClick() {
// Tools -> Set cells as background
        if ($("#tpSetBackground").parent("li").hasClass("disabled")) {
            return;
        }

        background = renderer.getSelection();
        $("#tpResetBackground").parent("li").removeClass("disabled");
        if ("geneSym" in gLegend)
            buildViolinPlot();
    }

    function onBackgroudResetClick() {
// Tools -> Reset background cells
        background = null;
        $("#tpResetBackground").parent("li").addClass("disabled");
        if ("geneSym" in gLegend)
            buildViolinPlot();
    }

    function saveQueryList(queryList) {
        var queryStr = JSURL.stringify(queryList);
        changeUrl({'select':queryStr});
        localStorage.setItem(db.name+"|select", queryStr);
    }

    function selectByQueryList(queryList) {
        /* select cells defined by query list, save to local storage and URL and redraw */
            findCellsMatchingQueryList(queryList, function(cellIds) {
                if (cellIds.length===0) {
                    alert("No matching "+gSampleDesc+"s.");
                } else {
                    renderer.selectSet(cellIds);
                    saveQueryList(queryList);
                }
            });
    }

    function onFindCellsClick() {
    /* Edit - Find cells */

        var dlgHeight = 400;
        var dlgWidth = 800;
        var buttons =
        [
            //{
                //text:"Cancel",
                //click:function() {
                    //// save state even if user presses cancel  - good idea?
                    //var queryStr = JSURL.stringify(queryList);
                    //var queryList = readSelectForm();
                    //localStorage.setItem(db.name+"|select", queryStr);
                    //$(this).dialog("close");
                //}
            //},
            {
                text:"OK",
                click: function() {
                    var queryList = readSelectForm();
                    selectByQueryList(queryList);
                    $("#tpDialog").dialog("close");
                    renderer.drawDots();
                }
            }
        ];

        var htmls = [];

        // build from current query or create a sample query
        var queries = [];
        var queryStr = getVar("select");

        if (queryStr===undefined)
            queryStr = localStorage.getItem(db.name+"|select");

        if (queryStr===undefined || queryStr===null)
            queries = [makeSampleQuery()];
        else {
            queries = JSURL.parse(queryStr);
        }

        var comboWidth = 250;

        var query;
        for (var i=0; i < queries.length; i++) {
            query = queries[i];
            buildOneComboboxRow(htmls, comboWidth, i, query);
        }

        htmls.push("<div id='tpSelectAddRowLink' class='link'>Add another search criterion - cells must match both conditions</div>");

        showDialogBox(htmls, "Find cells based on annotation or gene expression", {showClose:true, height:dlgHeight, width:dlgWidth, buttons:buttons});


        for (i=0; i < queries.length; i++) {
            query = queries[i];
            connectOneComboboxRow(comboWidth, i, query);
        }

        var rowIdx = queries.length+1;
        $('#tpSelectAddRowLink').click( function(ev) {
            var htmls = [];
            var rowIdx = $(".tpSelectRow").length;
            var newRowQuery = makeSampleQuery();
            buildOneComboboxRow(htmls, comboWidth, rowIdx, newRowQuery);
            $(htmls.join("")).insertBefore("#tpSelectAddRowLink");
            connectOneComboboxRow(comboWidth, rowIdx, newRowQuery);
        });
    }

    function onMarkClick() {
        /* Edit - mark selection (with arrows) */
        if (gCurrentDataset.markedCellIds===undefined)
            gCurrentDataset.markedCellIds = {};

        var markedIds = gCurrentDataset.markedCellIds;

        var selIds = keys(gSelCellIds);
        if (selIds.length>100) {
            warn("You cannot mark more than 100 "+gSampleDesc+"s");
            return;
        }

        for (var i = 0; i < selIds.length; i++) {
            var selId = selIds[i];
            markedIds[selId] = true;
        }

        plotDots();
        renderer.render(stage);
    }

    function onMarkClearClick() {
        gCurrentDataset.markedCellIds = {};
        plotDots();
        renderer.render(stage);
    }

    function cartSave(db) {
        /* save db.cart dataset long-term changes that may be shared with others, like colors, labels, annotations, etc
         * For now, save to localStorage and also to the URL. */

        var datasetName = db.name;
        var data = db.cart;
        var key = "cart";

        var fullKey = datasetName+"###"+key;
        var jsonStr = JSON.stringify(data);
        var comprStr = LZString.compress(jsonStr);
        var uriStr = LZString.compressToEncodedURIComponent(jsonStr);
        localStorage.setItem(fullKey, comprStr);
        var urlData = {};
        if (isEmpty(data))
            uriStr = null;
        urlData[key] = uriStr;
        changeUrl(urlData);
        console.log("Saving state: ", data);
    }

    function createMetaUiFields(db) {
        /* This function changes db.metaFields[fieldName],
         * it adds: .ui.shortLabels, .ui.longLabels, ui.palette and .ui.colors;
         * ui info fields hold the final data as shown in the ui, they're calculated when the cart is loaded.
         * apply changes like labels/color/etc stored the userMeta object to db.conf.metaFields.
         * Potentially clean up the changes and recreate the cart object.
         * Currently, this only does something for enum fields.
         * */

        if (db.cart===undefined)
            db.cart = {};
        var userMeta = db.cart;
        if (userMeta===null)
            alert("the 'cart' argument in the URL is invalid. Please remove cart=xxxx from the URL and reload");
        var metaFields = db.conf.metaFields;

        for (var metaIdx = 0; metaIdx < metaFields.length; metaIdx++) {
            var metaInfo = metaFields[metaIdx];
            var fieldChanges = userMeta[metaInfo.name] || {};

            if (metaInfo.type!=="enum") {
                metaInfo.ui = {};
                continue;
            }

            // create shortLabels
            var shortLabels = null;
            var oldCounts = metaInfo.valCounts;
            if (oldCounts) {
                shortLabels = [];
                for (var i = 0; i < oldCounts.length; i++)
                    shortLabels.push(oldCounts[i][0]);
                var newLabels = fieldChanges.shortLabels;
                shortLabels = copyNonEmpty(newLabels, shortLabels);
            }

            // create the long labels
            var longLabels = [];
            if ("longLabels" in metaInfo)
                longLabels = cloneArray(metaInfo.longLabels);
            else
                longLabels = cloneArray(shortLabels);
            longLabels = copyNonEmpty(fieldChanges.longLabels, longLabels);

            // create the colors: configured colors override default colors and cart overrides those
            var colors = makeColorPalette(cDefQualPalette, metaInfo.valCounts.length);
            if ("colors" in metaInfo)
                copyNonNull(metaInfo.colors, colors);
            var newColors = fieldChanges.colors;
            colors = copyNonEmpty(newColors, colors);

            var ui = {};
            ui.colors = newColors;
            ui.longLabels = longLabels;
            ui.shortLabels = shortLabels;
            metaInfo.ui = ui;
        }

        //var delFields = [];
        //var delAttrs = [];
        //if (metaInfo===null) { // field does not exist anymore
            //delFields.push(fieldName);
            //continue;
        //}

        // remove all fields and attributes that were found to be invalid in the current state
        // so we don't accumulate crap
        //var cleanedFields = [];
        //for (var i = 0; i < delAttrs.length; i++) {
            //var fieldName = delAttrs[i][0];
            //var attrName = delAttrs[i][1];
            //delete userMeta[fieldName][attrName];
            //cleanedFields.push(fieldName);
        //}

        //for (var i = 0; i < delFields.length; i++) {
            //var fieldName = delFields[i];
            //delete userMeta[fieldName];
            //cleanedFields.push(fieldName);
        //}
        //if (delAttrs.length!==0)
            //warn("You had previously changed labels or colors or annotations but the dataset has been updated since then. "+
                //"As a result, your annotations had to be removed. This concerned the following annotation fields: "+
                //cleanedFields.join(", "));
    }

    function cartFieldArrayUpdate(db, metaInfo, key, pos, val) {
        /* write val into db.cart[fieldName][key][pos], save the dataset cart and apply it.
         * db.cart[fieldName][key] is an array of arrLen
         * */
        var cart = db.cart;
        var fieldName = metaInfo.name;
        var arrLen = metaInfo.valCounts.length;

        if (!(fieldName in cart))
            cart[fieldName] = {};

        // init array
        if (!(key in cart[fieldName])) {
            var emptyArr = [];
            for (var i=0; i<arrLen; i++)
                emptyArr.push("");
            cart[fieldName][key] = emptyArr;
        }

        cart[fieldName][key][pos] = val;
        cartSave(db);
        createMetaUiFields(db);
    }

    function cartOverwrite(db, key, val) {
        /* write val into db.cart[key][attr], save the dataset cart and apply it.
         * attrName can be null in which case db.cart[key] will be replaced with val  */
        var cart = db.cart;
        if (!(key in db.cart))
            cart[key] = {};

        cart[key] = val;

        cartSave(db);
        createMetaUiFields(db);
    }

    function cartLoad(db) {
        /* load the entire dataset cart from the URL or - if there is no cart on the URL - from localStorage */
        var datasetName = db.name;
        var cart = {};
        var key = "cart";
        var uriStr = getVar(key, null);
        var jsonStr;
        if (uriStr!==null) {
            jsonStr = LZString.decompressFromEncodedURIComponent(uriStr);
            cart = JSON.parse(jsonStr);
            console.log("Loading cart from URL: ", cart);
        }
        else {
            var fullKey = datasetName+"###"+key;
            var comprStr = localStorage.getItem(fullKey);
            if (comprStr) {
                jsonStr = LZString.decompress(comprStr);
                cart = JSON.parse(jsonStr);
                console.log("Loading cart from local storage: ", cart);
            }
        }
        db.cart = cart;
        createMetaUiFields(db);

    }

    function onRunClusteringClick() {
        /* not used yet */
        var myArray = new ArrayBuffer(512);
        var longInt8View = new Uint8Array(myArray);

        // generate some data
        for (var i=0; i< longInt8View.length; i++) {
        longInt8View[i] = i % 256;
        }

        //let url = "http://localhost:5050/upload";
        let url = "http://localhost:5050/bin";
        var xhr = new XMLHttpRequest();
        //xhr.open("POST", url, false);
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = function() { var buf = xhr.response; console.log(buf)};
        xhr.send(null);
        //xhr.send(myArray);
    }

    function resetCustomAnnotations() {
        db.removeAllCustomAnnots();
        rebuildMetaPanel();
        changeUrl({"meta":null});
        colorByDefaultField();
        localStorage.removeItem(db.name+"|custom");
    }

    function onCustomAnnotationsClick() {
        /* */
        if (!db.getMetaFields()[0].isCustom) {
            alert("You have currently no custom annotations. Select a few cells and use Edit > Name selection "+
                    "to create a custom annotation field.");
        } else {
            resetCustomAnnotations();
        }
    }

    function onRenameClustersClick() {
    /* Tools - Rename Clusters */
        var htmls = [];
        htmls.push("<p>Change labels below. To keep the old name, leave the 'New Name' cell empty. You cannot modify the 'Orig. Name' column.</p>");
        //htmls.push('<p>To rename a single cluster without this dialog: click onto it in the legend, then click its label.</p>');
        htmls.push('<div id="tpGrid" style="width:100%;height:500px;"></div>');
        var title = "Rename Clusters";
        var dlgHeight = window.innerHeight - 100;
        var dlgWidth = 650;

        var clusterField = db.conf.labelField;

	var data = [];

        var buttons = [

        { text: "Empty All",
          click : function() {
                for (var i = 0; i < data.length; i++) {
                    var row = data[i];
                    row["newName"] = "";
                    row["mouseOver"] = "";
                    row["color"] = "";
                }
                grid.invalidate();
            }
        } ,
        {
            text: "OK",
            click: function() {
                Slick.GlobalEditorLock.commitCurrentEdit(); // save currently edited cell to data

                var shortLabels = [];
                var longLabels = [];
                var colors = [];

                for (var i = 0; i < data.length; i++) {
                    var row = data[i];
                    if (row["newName"]===row["origName"])
                        shortLabels.push("");
                    else
                        shortLabels.push(row["newName"]);

                    longLabels.push(row["mouseOver"]);
                    colors.push(row["color"]);
                }

                var fieldMeta = {};

                if (!allEmpty(shortLabels))
                    fieldMeta["shortLabels"] = shortLabels;
                if (!allEmpty(longLabels))
                    fieldMeta["longLabels"] = longLabels;
                if (!allEmpty(colors))
                    fieldMeta["colors"] = colors;

                cartOverwrite(db, clusterField, fieldMeta);
                var metaInfo = db.findMetaInfo(clusterField);

                renderer.setLabels(metaInfo.ui.shortLabels);

                // only need to update the legend if the current field is shown
                if (gLegend.type==="meta" && gLegend.metaInfo.name===clusterField) {
                    //var shortLabels = findMetaInfo(clusterField).ui.shortLabels;
                    legendUpdateLabels(clusterField);
                    buildLegendBar();
                }

                $( this ).dialog( "close" );
                renderer.drawDots();
            }
        },

        ];

        showDialogBox(htmls, title, {showClose:true, height:dlgHeight, width:dlgWidth, buttons:buttons});

        var columns = [
        	{id: "origName", width:100, maxWidth: 200, name: "Orig. Name", field: "origName"},
        	{id: "newName", width:150, maxWidth: 200, name: "New Name", field: "newName", editor: Slick.Editors.Text},
        	{id: "mouseOver", width:200, maxWidth: 300, name: "Mouseover Label", field: "mouseOver", editor: Slick.Editors.Text},
        	//{id: "color", width: 80, maxWidth: 120, name: "Color Code", field: "color", editor: Slick.Editors.Text}
        ];

	var options = {
            editable: true,
	    enableCellNavigation: true,
	    enableColumnReorder: false,
            enableAddRow: true,
            //asyncEditorLoading: false,
            autoEdit: true
	};

        var metaInfo = db.findMetaInfo(clusterField);

        var fieldChanges = db.cart[clusterField] || {};

        var shortLabels = fieldChanges["shortLabels"];
        var longLabels = fieldChanges["longLabels"];
        var colors = fieldChanges["colors"];

        for (var i = 0; i < metaInfo.valCounts.length; i++) {
            var shortLabel = "";
            if (shortLabels)
                shortLabel = shortLabels[i];

            var longLabel = "";
            if (longLabels)
                longLabel = longLabels[i];

            var color = "";
            if (colors)
                color = colors[i];

            var valCount = metaInfo.valCounts[i];
            var valRow = {
                "origName":valCount[0],
                "newName": shortLabel,
                "mouseOver": longLabel,
                "color": color
                };
            data.push(valRow);
        }

	var grid = new Slick.Grid("#tpGrid", data, columns, options);
        grid.setSelectionModel(new Slick.CellSelectionModel());
        grid.onAddNewRow.subscribe(function (e, args) {
          var item = args.item;
          grid.invalidateRow(data.length);
          data.push(item);
          grid.updateRowCount();
          grid.render();
        });
    }

    function selectCellsById(cellIds, hasWildcards, onDone) {
        /* create a new selection from the cells given the cell IDs, call onDone when ready with missing IDs. */
        function onSearchDone(searchRes) {
            // little helper function
            var idxArr = searchRes[0];
            var notFoundIds = searchRes[1];

            renderer.selectSet(idxArr);
            renderer.drawDots();

            if (cellIds.length===1) {
                let cellId = cellIds[0];
                db.loadMetaForCell(cellId, function(ci) {
                    updateMetaBarOneCell(ci, cellCountBelow);
                }, onProgress);
            }

            if (onDone)
                onDone(notFoundIds);
        }

        db.loadFindCellIds(cellIds, onSearchDone, onProgressConsole, hasWildcards);
    }

    function onSelectByIdClick() {
        /* Edit - Find cells by ID */


        function onDone(notFoundIds) {
            if (notFoundIds.length!==0) {
                $('#tpNotFoundIds').text("Could not find these IDs: "+notFoundIds.join(", "));
                $('#tpNotFoundHint').text("Please fix them and click the OK button to try again.");
            } else
                $( "#tpDialog" ).dialog( "close" );
        }

        var dlgHeight = 500;
        var dlgWidth = 500;
        var htmls = [];
        var buttons =
        [
            {
            text:"OK",
            click : function() {
                var idListStr = $("#tpIdList").val();
                idListStr = idListStr.trim().replace(/\r\n/g,"\n");
                var idList = idListStr.split("\n");
                var re = new RegExp("\\*");

                var hasWildcards = $("#tpHasWildcard")[0].checked;
                selectCellsById(idList, hasWildcards, onDone);
                }
            }
        ];

        htmls.push("<textarea id='tpIdList' style='height:320px;width:400px;display:block'>");
        htmls.push("</textarea><div id='tpNotFoundIds'></div><div id='tpNotFoundHint'></div>");
        htmls.push("<input id='tpHasWildcard' type='checkbox' style='margin-right: 10px' /> Allow RegEx search, e.g. enter '^TH' to find all IDs that <br>start with 'TH' or '-1$' to find all IDs that end with '-1'");
        var title = "Paste a list of IDs (one per line) to select "+gSampleDesc+"s";
        showDialogBox(htmls, title, {showClose:true, height:dlgHeight, width:dlgWidth, buttons:buttons});
    }

    function onExportIdsClick() {
        /* Edit - Export cell IDs */
        var selCells = renderer.getSelection();

        function buildExportDialog(idList) {
            /* callback when cellIds have arrived */
            var dlgHeight = 500;

            var htmls = [];
            if (selCells.length===0)
                htmls.push("Shown below are the identifiers of all "+idList.length+" cells in the dataset.<p><p>");

            var idListEnc = encodeURIComponent(idList.join("\n"));
            htmls.push("<textarea style='height:320px;width:350px;display:block'>");
            htmls.push(idList.join("\n"));
            htmls.push("</textarea>");

            var buttons =
            [
                {
                    text:"Download as file",
                    click : function() {
                        var blob = new Blob([idList.join("\n")], {type: "text/plain;charset=utf-8"});
                        saveAs(blob, "identifiers.txt");
                    },
                },
                {
                    text:"Copy to clipboard",
                    click :function() {
                        $("textarea").select();
                        document.execCommand('copy');
                        $( this ).dialog( "close" );
                    }
                }
            ];

            let title = "List of "+idList.length+" selected IDs";
            if (selCells.length===0)
                title = "No cells selected";

            showDialogBox(htmls, title,
                {showClose:true, height:dlgHeight, width:500, buttons:buttons}
                );
        }

        db.loadCellIds(selCells, buildExportDialog);
    }


    function onAboutClick() {
        /* user clicked on help > about */
        var dlgHeight = 500;

        var htmls = [];
        var title = "UCSC Cell Browser";

        htmls.push("<p><b>Version:</b> "+gVersion+"</p>");
        htmls.push("<p><b>Written by:</b> Maximilian Haeussler, Nikolay Markov (U Northwestern), Brian Raney, Lucas Seninge</p>");
        htmls.push("<p><b>Testing / User interface / Documentation / Data import / User support:</b> Matt Speir, Brittney Wick</p>");
        htmls.push("<p><b>Code contributions by:</b> Pablo Moreno (EBI, UK)</p>");
        htmls.push("<p><b>Documentation:</b> <a class='link' target=_blank href='https://cellbrowser.readthedocs.io/'>Readthedocs</a></p>");
        htmls.push("<p><b>Github Repo: </b><a class='link' target=_blank href='https://github.com/maximilianh/cellBrowser/'>cellBrowser</a></p>");
        htmls.push("<p><b>Paper: </b><a class='link' target=_blank href='https://academic.oup.com/bioinformatics/advance-article/doi/10.1093/bioinformatics/btab503/6318386'>Speir et al, Bioinformatics 2021, DOI:10.1093/bioinformatics/btab503/6318386</a></p>");

        showDialogBox(htmls, title, {showClose:true, height:dlgHeight, width:500});
    }

    function buildMenuBar() {
        /* draw the menubar at the top */
       var htmls = [];
       htmls.push("<div style='width:"+menuBarHeight+"px' id='tpMenuBar'>");
       htmls.push('<nav class="navbar navbar-default navbar-xs">');

       htmls.push('<div class="container-fluid">');

         htmls.push('<div class="navbar-header">');
           htmls.push('<a class="navbar-brand" href="#">'+gTitle+'</a>');
         htmls.push('</div>');

         htmls.push('<ul class="nav navbar-nav">');

         htmls.push('<li class="dropdown">');
           htmls.push('<a href="#" class="dropdown-toggle" data-toggle="dropdown" data-submenu role="button" aria-haspopup="true" aria-expanded="false">File</a>');
           htmls.push('<ul class="dropdown-menu">');
             htmls.push('<li><a href="#" id="tpOpenDatasetLink"><span class="dropmenu-item-label">Open dataset...</span><span class="dropmenu-item-content">o</span></a></li>');
             //htmls.push('<li class="dropdown-submenu"><a tabindex="0" href="#">Download Data</a>');
               //htmls.push('<ul class="dropdown-menu" id="tpDownloadMenu">');
                 //htmls.push('<li><a href="#" id="tpDownload_matrix">Gene Expression Matrix</a></li>');
                 //htmls.push('<li><a href="#" id="tpDownload_meta">Cell Metadata</a></li>');
                 //htmls.push('<li><a href="#" id="tpDownload_coords">Visible coordinates</a></li>');
               //htmls.push('</ul>'); // Download sub-menu
             htmls.push('<li><a href="#" id="tpSaveImage">Download bitmap image (PNG)</a></li>');
             htmls.push('<li><a href="#" id="tpSaveImageSvg">Download vector image (SVG)</a></li>');
             htmls.push('</li>');   // sub-menu container

           htmls.push('</ul>'); // File menu
         htmls.push('</li>'); // File dropdown

         htmls.push('<li class="dropdown">');
         htmls.push('<a href="#" class="dropdown-toggle" data-toggle="dropdown" data-submenu role="button" aria-haspopup="true" aria-expanded="false">Edit</a>');
         htmls.push('<ul class="dropdown-menu">');
         htmls.push('<li><a id="tpSelectAll" href="#"><span class="dropmenu-item-label">Select all visible</span><span class="dropmenu-item-content">s a</span></a></li>');
         htmls.push('<li><a id="tpSelectNone" href="#"><span class="dropmenu-item-label">Select none</span><span class="dropmenu-item-content">s n</span></a></li>');
         htmls.push('<li><a id="tpSelectInvert" href="#"><span class="dropmenu-item-label">Invert selection</span><span class="dropmenu-item-content">s i</span></a></li>');
         htmls.push('<li><a id="tpSelectName" href="#"><span class="dropmenu-item-label">Name selection...</span><span class="dropmenu-item-content">s s</span></a></li>');
         htmls.push('<li><a id="tpExportIds" href="#">Export selected...</a></li>');
         htmls.push('<li><a id="tpSelectComplex" href="#"><span class="dropmenu-item-label">Find cells...</span><span class="dropmenu-item-content">f c</span></a></li>');
         //htmls.push('<li><a id="tpMark" href="#"><span class="dropmenu-item-label">Mark selected</span><span class="dropmenu-item-content">h m</span></a></li>');
         //htmls.push('<li><a id="tpMarkClear" href="#"><span class="dropmenu-item-label">Clear marks</span><span class="dropmenu-item-content">c m</span></a></li>');
         htmls.push('<li><a id="tpSelectById" href="#">Find by ID...<span class="dropmenu-item-content">f i</span></a></li>');
         htmls.push('</ul>'); // View dropdown
         htmls.push('</li>'); // View dropdown

         htmls.push('<li class="dropdown">');
         htmls.push('<a href="#" class="dropdown-toggle" data-toggle="dropdown" data-submenu role="button" aria-haspopup="true" aria-expanded="false">View</a>');
         htmls.push('<ul class="dropdown-menu">');

         htmls.push('<li><a href="#" id="tpZoomPlus"><span class="dropmenu-item-label">Zoom in</span><span class="dropmenu-item-content">+</span></a></li>');
         htmls.push('<li><a href="#" id="tpZoomMinus"><span class="dropmenu-item-label">Zoom out</span><span class="dropmenu-item-content">-</span></a></li>');
         htmls.push('<li><a href="#" id="tpZoom100Menu"><span class="dropmenu-item-label">Zoom 100%</span><span class="dropmenu-item-content">space</span></a></li>');
         htmls.push('<li><a href="#" id="tpSplitMenu"><span id="tpSplitMenuEntry" class="dropmenu-item-label">Split screen</span><span class="dropmenu-item-content">t</span></a></li>');
         htmls.push('<li><a href="#" id="tpHeatMenu"><span id="tpHeatMenuEntry" class="dropmenu-item-label">Toggle Heatmap</span><span class="dropmenu-item-content">h</span></a></li>');

         htmls.push('<li><hr class="half-rule"></li>');

         //htmls.push('<li><a href="#" id="tpOnlySelectedButton">Show only selected</a></li>');
         //htmls.push('<li><a href="#" id="tpFilterButton">Hide selected '+gSampleDesc+'s</a></li>');
         //htmls.push('<li><a href="#" id="tpShowAllButton">Show all '+gSampleDesc+'</a></li>');
         htmls.push('<li><a href="#" id="tpHideShowLabels"><span id="tpHideMenuEntry">Hide labels</span><span class="dropmenu-item-content">c l</span></a></li>');

         htmls.push('</ul>'); // View dropdown-menu
         htmls.push('</li>'); // View dropdown container

         htmls.push('<li class="dropdown">');
         htmls.push('<a href="#" class="dropdown-toggle" data-toggle="dropdown" data-submenu role="button" aria-haspopup="true" aria-expanded="false">Tools</a>');
         htmls.push('<ul class="dropdown-menu">');
         //htmls.push('<li><a href="#" id="tpRenameClusters">Rename clusters...<span class="dropmenu-item-content"></span></a></li>');
         htmls.push('<li><a href="#" id="tpCustomAnnots">Remove all custom annotations<span class="dropmenu-item-content"></span></a></li>');
         //htmls.push('<li><a href="#" id="tpCluster">Run clustering...<span class="dropmenu-item-content"></span></a></li>');
         htmls.push('<li class="disabled"><a href="#" id="tpSetBackground">Set as background cells<span class="dropmenu-item-content">b s</span></a></li>');
         htmls.push('<li class="disabled"><a href="#" id="tpResetBackground">Reset background cells<span class="dropmenu-item-content">b r</span></a></li>');
         htmls.push('</ul>'); // Tools dropdown-menu
         htmls.push('</li>'); // Tools dropdown container


         htmls.push('<li class="dropdown">');
         htmls.push('<a href="#" class="dropdown-toggle" data-toggle="dropdown" data-submenu role="button" aria-haspopup="true" aria-expanded="false">Help</a>');
         htmls.push('<ul class="dropdown-menu">');
         htmls.push('<li><a href="#" id="tpAboutButton">About</a></li>');
         htmls.push('<li><a href="https://cellbrowser.readthedocs.io/en/master/interface.html" target=_blank id="tpQuickstartButton">How to use this website</a></li>');
         htmls.push('<li><a href="#" id="tpTutorialButton">Interactive Tutorial</a></li>');
         htmls.push('<li><a target=_blank href="https://github.com/maximilianh/cellBrowser#readme" id="tpGithubButton">Setup your own cell browser</a></li>');
         htmls.push('</ul>'); // Help dropdown-menu
         htmls.push('</li>'); // Help dropdown container

       htmls.push('</ul>'); // navbar-nav

       htmls.push('</div>'); // container
       htmls.push('</nav>'); // navbar
       htmls.push('</div>'); // tpMenuBar

       $(document.body).append(htmls.join(""));

       $('#tpTransMenu li a').click( onTransClick );
       $('#tpSizeMenu li a').click( onSizeClick );
       //$('#tpFilterButton').click( onHideSelectedClick );
       //$('#tpOnlySelectedButton').click( onShowOnlySelectedClick );
       $('#tpZoom100Menu').click( onZoom100Click );
       $('#tpSplitMenu').click( onSplitClick );
       $('#tpHeatMenu').click( onHeatClick );
       $('#tpZoomPlus').click( onZoomInClick );
       $('#tpZoomMinus').click( onZoomOutClick );
       //$('#tpShowAllButton').click( onShowAllClick );
       $('#tpHideShowLabels').click( onHideShowLabelsClick );
       $('#tpExportIds').click( onExportIdsClick );
       $('#tpSelectById').click( onSelectByIdClick );
       $('#tpMark').click( onMarkClick );
       $('#tpMarkClear').click( onMarkClearClick );
       $('#tpTutorialButton').click( function()  { showIntro(false); } );
       $('#tpAboutButton').click( onAboutClick );
       $('#tpOpenDatasetLink').click( openCurrentDataset );
       $('#tpSaveImage').click( onSaveAsClick );
       $('#tpSaveImageSvg').click( onSaveAsSvgClick );
       $('#tpSelectAll').click( onSelectAllClick );
       $('#tpSelectNone').click( onSelectNoneClick );
       $('#tpSelectInvert').click( onSelectInvertClick );
       $('#tpSelectName').click( onSelectNameClick );
       $('#tpSelectComplex').click( onFindCellsClick );


       $('#tpRenameClusters').click( onRenameClustersClick );
       $('#tpCustomAnnots').click( onCustomAnnotationsClick );
       $('#tpSetBackground').click( onBackgroudSetClick );
       $('#tpResetBackground').click( onBackgroudResetClick );
       //$('#tpCluster').click( onRunClusteringClick );

       // This version is more like OSX/Windows:
       // - menus only open when you click on them
       // - once you have clicked, they start to open on hover
       // - a click anywhere else will stop the hovering
       var doHover = false;
       $(".nav > .dropdown").click( function(){ doHover = !doHover; return true;} );
       $(".nav > .dropdown").hover(
           function(event) {
               if (doHover) {
                   $(".dropdown-submenu").removeClass("open"); $(".dropdown").removeClass("open"); $(this).addClass('open');
               }
           });

       $(document).click ( function() { doHover= false; });

       // when user releases the mouse outside the canvas, remove the zooming marquee
       $(document).mouseup ( function(ev) { if (ev.target.nodeName!=="canvas") { renderer.resetMarquee(); }} );

       $('[data-submenu]').submenupicker();

    }

    function resizeDivs(skipRenderer) {
       /* resize all divs and the renderer to current window size */
       var rendererLeft = metaBarWidth+metaBarMargin;
       var rendererHeight  = window.innerHeight - menuBarHeight - toolBarHeight;

       var rendererWidth = window.innerWidth - legendBarWidth - rendererLeft;
       var legendBarLeft = rendererWidth+metaBarMargin+metaBarWidth;

       var heatWidth, heatHeight;
       if (db && db.heatmap) {
            heatWidth = rendererWidth;
            heatHeight = db.heatmap.height;
            rendererHeight = rendererHeight - heatHeight;
            db.heatmap.setSize(heatWidth, heatHeight);
            let heatTop = window.innerHeight - heatHeight;
            db.heatmap.div.style.top = heatTop+"px";
            db.heatmap.draw();
       }

       $("#tpToolBar").css("width", rendererWidth+"px");

       $("#tpToolBar").css("height", toolBarHeight+"px");
       $("#tpLeftSidebar").css("height", (window.innerHeight - menuBarHeight)+"px");

       // when this is run the first time, these elements don't exist yet.
       // Note that the whole concept of forcing these DIVs to go up to the screen size is strange, but
       // I have not found a way in CSS to make them go to the end of the screen. They need to have a fixed size,
       // as otherwise the scroll bars of tpLegendBar and tpMetaPanel won't appear
       if ($('#tpMetaPanel').length!==0)
           $("#tpMetaPanel").css("height", (window.innerHeight - $('#tpMetaPanel').offset().top)+"px");
       if ($('#tpLegendRows').length!==0)
           $("#tpLegendBar").css("height", (window.innerHeight - $('#tpLegendBar').offset().top)+"px");
       $('#tpLegendBar').css('left', legendBarLeft+"px");

       if (skipRenderer!==true)
           renderer.setSize(rendererWidth, rendererHeight, true);

    }

    var progressUrls = {};

    function onProgressConsole(ev) {
        //console.log(ev);
    }

    function onProgress(ev) {
        /* update progress bars. The DOM elements of these were added in maxPlot (not optimal?)  */
        console.log(ev);
        if (ev.text!==undefined) {
            // image loaders just show a little watermark
            renderer.setWatermark(ev.text);
            return;
        }

        var url = null;
        var domEl = ev.currentTarget;
        if (domEl)
            url = domEl.responseURL;
        else
            url = ev.src; // when loading an image, we're getting the <img> domEl, not sure why no event

        url = url.split("?")[0]; // strip off the md5 checksum

        if (url.search("exprMatrix.bin")!==-1) // never show progress bar for single gene vector requests
            return;

        var progressRowIdx = progressUrls[url]; // there can be multiple progress bars
        if (progressRowIdx===undefined) {
            // if there is none yet, find the first free index
            progressRowIdx = 0;
            for (var oldUrl in progressUrls) {
                progressRowIdx = Math.max(progressRowIdx, progressUrls[oldUrl]);

            }
            progressRowIdx++;
            progressUrls[url] = progressRowIdx;
        }

        var label = url;
        if (url.endsWith("coords.bin"))
            label = "Loading Coordinates";
        else if (url.endsWith(".bin"))
            label = "Loading cell annotations";

        var labelId = "#mpProgressLabel"+progressRowIdx;
        $(labelId).html(label);

        var percent = Math.round(100 * (ev.loaded / ev.total));

        if (percent>=99) {
            $("#mpProgress"+progressRowIdx).css("width", percent+"%");
            $("#mpProgress"+progressRowIdx).show(0);
            //progressUrls.splice(index, 1);
            delete progressUrls[url];
            $("#mpProgressDiv"+progressRowIdx).css("display", "none");
        }
        else {
            $("#mpProgress"+progressRowIdx).css("width", percent+"%");
            $("#mpProgressDiv"+progressRowIdx).css("display", "inherit");
        }
    }


    function getActiveColorField() {
        /* return the current field that is used for coloring the UMAP */
        let fieldName = getVar("meta");
        if (fieldName===undefined)
            fieldName = db.getDefaultColorField();
        return fieldName;
    }
    
    function colorByMetaField(fieldName, doneLoad) {
        /* load the meta data for a field, setup the colors, send it all to the renderer and call doneLoad. if doneLoad is undefined, redraw everything  */

        function onMetaArrLoaded(metaArr, metaInfo) {
            gLegend = buildLegendForMeta(metaInfo);
            buildLegendBar();
            var renderColors = legendGetColors(gLegend.rows);
            renderer.setColors(renderColors);
            renderer.setColorArr(metaArr);
            metaInfo.arr = metaArr;
            doneLoad();
        }

       if (doneLoad===undefined)
           doneLoad = function() { renderer.drawDots(); };

       if (fieldName===null || fieldName===undefined) {
           // obscure hacky option: you can set the default color field to "None"
           // so there is no coloring at all on startup
           colorByNothing();
           doneLoad();
           return;
       }

       var metaInfo  = db.findMetaInfo(fieldName);
       console.log("Color by meta field "+fieldName);

       // cbData always keeps the most recent expression array. Reset it now.
       if (db.lastExprArr)
           delete db.lastExprArr;

       var defaultMetaField = db.getDefaultColorField();

       // internal field names cannot contain non-alpha chars, so tolerate user errors here
       // otherwise throw an error
       if (metaInfo === null && fieldName!==undefined) {
           metaInfo = db.findMetaInfo(fieldName.replace(/[^0-9a-z]/gi, ''));
           if (metaInfo === null) {
               alert("The field "+fieldName+" does not exist in the sample/cell annotations. Cannot color on it.");
               metaInfo = db.findMetaInfo(defaultMetaField);
           }
       }

       if (metaInfo.type==="uniqueString") {
           warn("This field contains a unique identifier. You cannot color on such a field. However, you can search for values in this field using 'Edit > Find by ID'.");
           return null;
       }

       if (metaInfo.diffValCount > MAXCOLORCOUNT && metaInfo.type==="enum") {
           warn("This field has "+metaInfo.diffValCount+" different values. Coloring on a field that has more than "+MAXCOLORCOUNT+" different values is not supported.");
           return null;
       }


        if (fieldName===defaultMetaField)
           changeUrl({"meta":null, "gene":null});
        else
           changeUrl({"meta":fieldName, "gene":null});

        if (metaInfo.arr) // eg custom fields
            onMetaArrLoaded(metaInfo.arr, metaInfo);
        else
            db.loadMetaVec(metaInfo, onMetaArrLoaded, onProgress, {}, db.conf.binStrategy);


       changeUrl({"pal":null});
       // clear the gene search box
       var select = $('#tpGeneCombo')[0].selectize.clear();
       //buildWatermark();
    }

    function activateTab(name) {
        /* activate a tab on the left side */
        var idx = 0;
        if (name==="gene")
            idx = 1;

        $( "#tpLeftTabs" ).tabs( "option", "active", idx );
    }

    function doLog2(arr) {
        /* take log2(x+1) for all values in array and return the result */
        var arr2 = new Float64Array(arr.length);
        for (var i = 0; i < arr.length; i++) {
            arr2.push(Math.log2(arr[i]+1));
        }
        return arr2;
    }

    function splitExprByMeta(metaArr, metaCountSize, exprArr) {
        /* split expression values by meta annotation, return array metaIdx -> array of expression values  */
        var metaValToExprArr = [];
        // initialize result array
        for (var i=0; i < metaCountSize; i++) {
            metaValToExprArr.push([]);
        }

        let exprMax = exprArr[0];
        let exprMin = exprArr[0];

        for (var i=0; i < exprArr.length; i++) {
            var exprVal = exprArr[i];
            var metaVal = metaArr[i];
            metaValToExprArr[metaVal].push(exprVal);
            exprMax = Math.max(exprMax, exprVal);
            //if (exprMax > 50)
                //exprMax = Math.round(exprMax);
            exprMin = Math.min(exprMin, exprVal);

        }
        return [metaValToExprArr, exprMin, exprMax];
    }

    function splitExprByMetaSelected(exprVec, splitArr, selCells) {
        /* split the expression vector into two vectors. splitArr is an array with 0/1, indicates where values go.
         * if selCells is not null, restrict the splitting to just indices in selCells.
         * Returns array of the two arrays.
         * */
        console.time("findCellsWithMeta");
        if (exprVec.length!==splitArr.length) {
            warn("internal error - splitExprByMetaSelected: exprVec has diff length from splitArr");
        }

        var arr1 = [];
        var arr2 = [];

        // code duplication, not very elegant, but avoids creating an array just for the indices
        if (selCells.length===0)
            // the version if no cells are selected
            for (var cellIdx = 0; cellIdx < exprVec.length; cellIdx++) {
                var val = exprVec[cellIdx];
                if (splitArr[cellIdx]===0)
                    arr1.push(val);
                else
                    arr2.push(val);
            }
        else
            // the version with a cell selection
            for (var i = 0; i < selCells.length; i++) {
                let cellIdx = selCells[i];
                let val = exprVec[cellIdx];
                if (splitArr[cellIdx]===0)
                    arr1.push(val);
                else
                    arr2.push(val);
            }

        if (db.conf.violinDoLog2) {
            console.time("log2");
            arr1 = doLog2(arr1);
            arr2 = doLog2(arr2);
            console.timeEnd("log2");
        }

        console.timeEnd("findCellsWithMeta");
        return [arr1, arr2];
    }

    function splitExpr(exprVec, selCells) {
        /* split the expression vector into two vectors, one for selected and one for unselected cells */
        console.time("splitExpr");
        var selMap = {};
        for (var i = 0; i < selCells.length; i++) {
            selMap[selCells[i]] = null;
        }

        var sel = [];
        var unsel = [];
        for (i = 0; i < exprVec.length; i++) {
            if (i in selMap)
                sel.push(exprVec[i]);
            else
                unsel.push(exprVec[i]);
        }

        console.timeEnd("splitExpr");
        return [sel, unsel];
    }

    function buildViolinFromValues(labelList, dataList) {
        /* make a violin plot given the labels and the values for them */
        if ("violinChart" in window)
            window.violinChart.destroy();

        var labelLines = [];
        labelLines[0] = labelList[0].split("\n");
        labelLines[0].push(dataList[0].length);
        if (dataList.length > 1) {
            labelLines[1] = labelList[1].split("\n");
            labelLines[1].push(dataList[1].length);
        }

        const ctx = getById("tpViolinCanvas").getContext("2d");

 	var violinData = {
          labels : labelLines,
	  datasets: [{
            data : dataList,
	    label: 'Mean',
	    backgroundColor: 'rgba(255,0,0,0.5)',
	    borderColor: 'red',
	    borderWidth: 1,
	    outlierColor: '#999999',
	    padding: 7,
	    itemRadius: 0
	}]
	};

        var optDict = {
            maintainAspectRatio: false,
            legend: { display: false },
	    title: { display: false }
        };

        var yLabel = null;
        if (db.conf.unit===undefined && db.conf.matrixArrType==="Uint32")
            yLabel = "read/UMI count";
        if (db.conf.unit!==undefined)
            yLabel = db.conf.unit;

        if (yLabel!==null)
            optDict.scales = {
                yAxes: [{
                    scaleLabel: {
                        display: true,
                        labelString: yLabel
                    }
                    }]
            };

        window.setTimeout(function() {
            console.time("violinDraw");
            window.violinChart = new Chart(ctx, {
                type: 'violin',
                data: violinData,
                options: optDict
            });
            console.timeEnd("violinDraw");
        }, 10);
    }


    function buildViolinFromMeta(exprVec, metaName, selCells) {
        /* load a binary meta vector, split the exprVector by it and make two violin plots, one meta value vs the other.  */
        var metaInfo = db.findMetaInfo(metaName);
        if (metaInfo.valCounts.length!==2) {
            alert("Config error: meta field in 'violinField', '"+db.conf.violinField+"' does not have two distinct values.");
            return;
        }

        var labelList = [metaInfo.valCounts[0][0], metaInfo.valCounts[1][0]];
        db.loadMetaVec( metaInfo,
                function(metaArr) {
                    var dataList = splitExprByMetaSelected(exprVec, metaArr, selCells);
                    buildViolinFromValues(labelList, dataList);
                },
                null, {}, db.conf.binStrategy);
    }

    //function removeViolinPlot() {
        /* destroy the violin plot */
        //if ("violinChart" in window)
            //window.violinChart.destroy();
        //$('#tpViolinCanvas').remove();
    //}

    function buildViolinPlot() {
        /* create the violin plot, depending on the current selection and the violinField config */
        var exprVec = gLegend.exprVec;
        if (exprVec===undefined)
            return;

        var dataList = [];
        var labelList = [];
        var selCells = renderer.getSelection();

        // filter exprVec by background
        if (background !== null) {
            var ourSelCells = {};
            for (var i = 0; i < selCells.length; i++) {
                ourSelCells[selCells[i]] = true;
            }
            var ourCells = {};
            for (i = 0; i < background.length; i++) {
                ourCells[background[i]] = true;
            }

            var result = [];
            var renamedSelCells = [];
            for (i = 0; i < exprVec.length; i++) {
                if (i in ourSelCells) {
                    renamedSelCells.push(result.length);
                    result.push(exprVec[i]);
                } else if (i in ourCells) {
                    result.push(exprVec[i]);
                }
            }
            exprVec = result;
            selCells = renamedSelCells;
        }
        // if we have a violin meta field to split on, make two violin plots, metavalue vs rest
        // restrict the plot to the selected cells, if any
        if (db.conf.violinField!==undefined) {
            buildViolinFromMeta(exprVec, db.conf.violinField, selCells);
        } else {
            // there is no violin field
            if (selCells.length===0) {
                // no selection, no violinField: default to a single violin plot
                dataList = [Array.prototype.slice.call(exprVec)];
                if (background === null) {
                    labelList = ['All cells'];
                } else {
                    labelList = ['Background\ncells'];
                }
                buildViolinFromValues(labelList, dataList);
            } else {
                // cells are selected and no violin field: make two violin plots, selected against other cells
                dataList = splitExpr(exprVec, selCells);
                if (background === null) {
                    labelList = ['Selected', 'Others'];
                } else {
                    labelList = ['Selected', 'Background'];
                }
                if (dataList[1].length===0) {
                    dataList = [dataList[0]];
                    labelList = ['All Selected'];
                }
                buildViolinFromValues(labelList, dataList);
            }
        }
    }

    function selectizeSetValue(elId, name) {
        /* little convenience method to set a selective dropdown to a given
         * value. does not trigger the change event. */
        if (name===undefined)
            return;
        var sel = getById(elId).selectize;
        sel.addOption({id: name, text: name});
        sel.setValue(name, 1); // 1 = do not fire change
    }

    function colorByNothing() {
        /* color by nothing, rarely needed */
        renderer.setColors([cNullColor]);
        var cellCount = db.conf.sampleCount;
        renderer.setColorArr(new Uint8Array(cellCount));
        gLegend.rows = [];
        gLegend.title = "Nothing selected";
        gLegend.subTitle = "";
        gLegend.rows.push( {
                color:cNullColor, defColor:null, label:"No Value",
                count:cellCount, intKey:0, strKey:null
        } );
        buildLegendBar();
    }

    function buildWatermark(myRend) {
        /* update the watermark behind ghe image */
        if (myRend===undefined)
            myRend = renderer;

        if (!myRend.isSplit()) {
            myRend.setWatermark("");
            return;
        }

        let labelStr;
        if (gLegend.type==="expr")
            labelStr = gLegend.geneSym;
        else
            labelStr = gLegend.metaInfo.label;

        let waterLabel;
        if (db.isAtacMode())
            //waterLabel = shortenRange(locusStr);
            waterLabel= labelStr.split("|").length + " peak(s)";
        else
            waterLabel = labelStr;
        //else
            //waterLabel = geneDesc
        myRend.setWatermark(waterLabel);
    }

    function colorByLocus(locusStr, onDone, locusLabel) {
        /* color by a gene or peak, load the array into the renderer and call onDone or just redraw 
         * peak can be in format: +chr1:1-1000
         * gene can be in format: geneSym or geneSym=geneId
         * */
        if (onDone===undefined || onDone===null)
            onDone = function() { renderer.drawDots(); };

        function gotGeneVec(exprArr, decArr, locusStr, geneDesc, binInfo) {
            /* called when the expression vector has been loaded and binning is done */
            if (decArr===null)
                return;
            console.log("Received expression vector, for "+locusStr+", desc: "+geneDesc);
            // update the URL and possibly the gene combo box
            if (locusStr.indexOf("|") > -1) {
                if (locusStr.length < 600)
                    // this is rare, so just completely skip this URL change now
                    changeUrl({"locus":locusStr, "meta":null});
            } else
                changeUrl({"gene":locusStr, "meta":null});

            makeLegendExpr(locusStr, geneDesc, binInfo, exprArr, decArr);
            renderer.setColors(legendGetColors(gLegend.rows));
            renderer.setColorArr(decArr);

            buildWatermark();
            buildLegendBar();
            onDone();

            // update the "recent genes" div
            for (var i = 0; i < gRecentGenes.length; i++) {
                // remove previous gene entry with the same symbol
                if (gRecentGenes[i][0]===locusStr || gRecentGenes[i][1]===locusStr) { // match symbol or ID
                    gRecentGenes.splice(i, 1);
                    break;
                }
            }

            // make sure that recent genes table has symbol and Id
            var locusWithSym = locusStr;
            if (db.isAtacMode()) {
                locusWithSym = shortenRange(locusStr);
            } else {
                if (locusStr.indexOf("+")===-1) {
                    let geneInfo = db.getGeneInfo(locusStr);
                    if ((geneInfo.sym!==geneInfo.geneId))
                        locusWithSym = geneInfo.id+"|"+geneInfo.sym;
                } else { 
                    let geneCount = locusStr.split("+").length;
                    locusWithSym = locusStr+"|Sum of "+geneCount+" genes";
                }
            }

            gRecentGenes.unshift([locusWithSym, geneDesc]); // insert at position 0
            gRecentGenes = gRecentGenes.slice(0, 9); // keep only nine last
            buildGeneTable(null, "tpRecentGenes", null, null, gRecentGenes);
            $('#tpRecentGenes .tpGeneBarCell').click( onGeneClick );
            resizeGeneTableDivs("tpRecentGenes");
        }

        // clear the meta combo
        $('#tpMetaCombo').val(0).trigger('chosen:updated');

        console.log("Loading gene expression vector for "+locusStr);

        db.loadExprAndDiscretize(locusStr, gotGeneVec, onProgress, db.conf.binStrategy);

    }

    function colorByMultiGenes(geneIds, syms) {
        var locusLabel = syms.join("+");
        colorByLocus(geneIds.join("+"), null, locusLabel)
    }


    function gotCoords(coords, info, clusterInfo, newRadius) {
        /* called when the coordinates have been loaded */
        if (coords.length===0)
            alert("cellBrowser.js/gotCoords: coords.bin seems to be empty");
        var opts = {};
        if (newRadius)
            opts["radius"] = newRadius;

        // label text can be overriden by the user cart
        var labelField = db.conf.labelField;

        if (! db.gLabelCoordCache )
            db.gLabelCoordCache = {};

        if (clusterInfo) {
            var origLabels = [];
            var clusterMids = clusterInfo.labels;
            // old-style files contain just coordinates, no order
            if (clusterMids === undefined) {
                clusterMids = clusterInfo;
            }

            db.gLabelCoordCache[labelField] = clusterMids;
            for (var i = 0; i < clusterMids.length; i++) {
                origLabels.push(clusterMids[i][2]);
            }
            renderer.origLabels = origLabels;
         }

        if (clusterInfo && clusterInfo.lines) {
            opts["lines"] = clusterInfo.lines;
            opts["lineWidth"] = db.conf.lineWidth;
            opts["lineColor"] = db.conf.lineColor;
            opts["lineAlpha"] = db.conf.lineAlpha;
        }

        renderer.setCoords(coords, clusterMids, info, opts);
    }

    function computeAndSetLabels(values, metaInfo) {
        /* recompute the label positions and redraw everything. Uses a cache for the label positions */
        var labelCoords;
        if (db.gLabelCoordCache[metaInfo.label] !== undefined) {
            labelCoords = db.gLabelCoordCache[metaInfo.label];
        } else {
            var coords = renderer.coords.orig;
            var names = null;
            if (metaInfo.type !== "float" && metaInfo.type !== "int") {
                var names = metaInfo.ui.shortLabels;
            }

            // console.log(metaInfo);

            console.time("cluster centers");
            var calc = renderer.calcMedian(coords, values, names, metaInfo.origVals);

            labelCoords = [];
            for (var label in calc) {
                var labelInfo = calc[label];
                var midX = selectMedian(labelInfo[0]);
                var midY = selectMedian(labelInfo[1]);
                labelCoords.push([midX, midY, label]);
            }
            console.timeEnd("cluster centers");
            db.gLabelCoordCache[metaInfo.label] = labelCoords;
        }
        renderer.setLabelCoords(labelCoords);
        setLabelDropdown(metaInfo.name);
    }

    function setLabelField(labelField) {
        /* change the field that is used for drawing the labels. 'null' means hide labels. Do not redraw. */
        if (labelField===null) {
            db.conf.activeLabelField = null;
            renderer.setShowLabels(false);
        }
        else {
            renderer.setShowLabels(true);
            var metaInfo = db.findMetaInfo(labelField);
            db.conf.activeLabelField = metaInfo.name;

            if (metaInfo.arr) // preloaded
                computeAndSetLabels(metaInfo.arr, metaInfo);
            else
                db.loadMetaVec(metaInfo, computeAndSetLabels);
        }
    }

   function setColorByDropdown(fieldName) {
       /* set the meta 'color by' dropdown to a given value. The value is the meta field name, or its label, or its index */
       var fieldIdx  = db.fieldNameToIndex(fieldName);
       chosenSetValue("tpMetaCombo", "tpMetaVal_"+fieldIdx);
       //$('#tpMetaCombo').val("tpMetaVal_"+fieldIdx).trigger('chosen:updated');
   }

   function setLabelDropdown(fieldName) {
       /* set the meta 'label by' dropdown to a given value. The value is the meta field name, or its short label, or its index */
       var fieldIdx  = db.fieldNameToIndex(fieldName);
       //$('#tpLabelCombo').val("tpMetaVal_"+fieldIdx).trigger('chosen:updated');
       chosenSetValue("tpLabelCombo", "tpMetaVal_"+fieldIdx);
   }

   function colorByDefaultField(onDone, ignoreUrl) {
       /* get the default color field from the config or the URL and start coloring by it.
        * Call onDone() when done. */
       var colorType = "meta";
       var colorBy = db.getDefaultColorField();

       if (ignoreUrl!==true) {
           // allow to override coloring by URL args
           if (getVar("gene")!==undefined) {
               colorType = "gene";
               colorBy = getVar("gene");
               activateTab("gene");
           }
           else if (getVar("meta")!==undefined) {
               colorType = "meta";
               colorBy = getVar("meta");
               activateTab("meta");
           } else if (getVar("locus")!==undefined) {
               colorType = "locus";
               colorBy = getVar("locus");
               activateTab("gene");
               if (getVar("locusGene")!==undefined) {
                   let geneId = getVar("locusGene");
                   updatePeakListWithGene(geneId);
               }
           }
        }

       gLegend = {};
       if (colorType==="meta") {
           colorByMetaField(colorBy, onDone);
           // update the meta field combo box
           var fieldIdx  = db.fieldNameToIndex(colorBy);
           if (fieldIdx===null) {
               alert("Default coloring is configured to be on field "+colorBy+
                    " but cannot find a field with this name, using field 1 instead.");
               fieldIdx = 1;
           }

           setColorByDropdown(colorBy);
           $('#tpMetaBox_'+fieldIdx).addClass('tpMetaSelect');
       }
       else {
           if (colorType==="locus") {
               colorByLocus(colorBy, onDone);
               peakListSetStatus(colorBy);
           } else {
               // must be gene then
               var geneId = db.mustFindOneGeneExact(colorBy);
               colorByLocus(geneId, onDone);
           }
        }
   }

   function makeFullLabel(db) {
       /* return full name of current dataset, including parent names */
       var nameParts = [];
       var parents = db.conf.parents;
       if (parents)
           for (var i=0; i < parents.length; i++)
               if (parents[i][0]!="") // "" is the root dataset = no need to add
                   nameParts.push( parents[i][1] );

       nameParts.push( db.conf.shortLabel );
       var datasetLabel = nameParts.join(" - ");
       return datasetLabel;
   }

   function gotSpatial(img) {
       /* called when the spatial image has been loaded */
       renderer.setBackground(img);
       if (renderer.readyToDraw())
           renderer.drawDots();
       else
           console.log("got spatial, but cannot draw yet");
   }

   function plotTrace(cellId) {
       /* plot a trace of a cell */
       let lineEl = document.createElement('line'); 
       //<line x1="0" y1="80" x2="100" y2="20" stroke="black" />
       lineEl.setAttribute("x1", 5);
       lineEl.setAttribute("y1", 5);
       lineEl.setAttribute("x2", 10);
       lineEl.setAttribute("y2", 5);
       lineEl.setAttribute("stroke", "black");
       lineEl.setAttribute("stroke-width", "2");

       let svgEl = getById("tpTraceSvg");
       svgEl.textContent = "";      // remove all children
       svgEl.appendChild(lineEl);

       let trace = db.traces[cellId];

       if (trace===undefined) {
           svgEl.innerHTML = '<text x="50" y="30" class="heavy">No trace available. Most likely removed due to quality filters.</text>';
           return;
       }

       let traceWidth = parseInt(getById("tpTraceSvg").getAttribute("width"));
       let traceHeight = 100.0;

       let traceMin = 999999;
       let traceMax = -99999;
       console.log(trace);

       // TODO: inverting the trace is that the right thing here?
       var newTrace = [];
       for (let i=0; i < trace.length; i++) {
           newTrace.push(-trace[i]);
       }
       trace = newTrace;

       for (let i=0; i < trace.length; i++) {
           let val = trace[i];
           traceMin = Math.min(traceMin, val);
           traceMax = Math.max(traceMax, val);
       }
       console.log("Min", traceMin, "Max", traceMax);

       let dataSpan = (traceMax-traceMin);
       let scaleFact = traceHeight / (dataSpan);
       let stepX = traceWidth / trace.length ; // number of pixels per point
       console.log("dataSpan", dataSpan, "scaleFact", scaleFact, "stepX", stepX);

       let pixYs = [];
       for (let i=0; i < trace.length; i++) {
           let val = trace[i];
           let pixY = (val-traceMin)*scaleFact;
           pixYs.push(pixY);
           console.log(val, pixY);
       }

       let htmls = [];
       for (let i=0; i < trace.length-1; i++) { 
           let x1 = Math.round(i*stepX);
           let x2 = Math.round((i+1)*stepX);
           let y1 = Math.round(pixYs[i]);
           let y2 = Math.round(pixYs[i+1]);
           htmls.push("<line x1='"+x1+"' x2='"+x2+"' y1='"+y1+"' y2='"+y2+"' stroke='black' stroke-width='2'/>");
        }

       svgEl.innerHTML = htmls.join("");
   }

   function buildTraceWindow() {
       /* called when the traces have been loaded */
       renderer.setSize(renderer.getWidth(), renderer.height-traceHeight, true);
       let divEl = document.createElement('div'); 
       divEl.style.position = "absolute";
       divEl.style.left = metaBarWidth+"px";
       // from plotHeatmap
       var canvLeft = metaBarWidth+metaBarMargin;
       var traceWidth = window.innerWidth - canvLeft - legendBarWidth;
       divEl.style.width = traceWidth+"px";
       divEl.style.height = traceHeight+"px";
       divEl.style.left = metaBarWidth+"px";
       divEl.style.top = (menuBarHeight+toolBarHeight+renderer.height)+"px";
       divEl.id = "tpTraceBar";
       document.body.appendChild(divEl);
       divEl.innerHTML = "<div id='tpTraceTitle'>Calcium Trace</div>"+
           '<svg id="tpTraceSvg" width="'+traceWidth+'" height="'+traceHeight+'" xmlns="http://www.w3.org/2000/svg">';

       let cellId = getVar("cell");
       if (cellId)
           plotTrace(cellId);
   }

   function gotTraces(traces) {
       /* called when the traces have been loaded */
       buildTraceWindow();
   }

   function loadAndRenderData() {
    /* init the basic UI parts, the main renderer in the center, start loading and draw data when ready
     */
       var forcePalName = getVar("pal", null);

       var loadsDone = 0;

       var selList = null; // search expression to select, in format accepted by findCellsMatchingQueryList()

       function doneOnePart() {
       /* make sure renderer only draws when both coords and other data have loaded */
           loadsDone +=1;
           if (loadsDone===2) {
               buildLegendBar();

               if (db.conf.labelField)
                   setLabelField(db.conf.labelField);

               if (forcePalName!==null) {
                   legendChangePaletteAndRebuild(forcePalName);
               }
               else
                   renderer.setColors(legendGetColors(gLegend.rows));


               renderer.setTitle("Dataset: "+makeFullLabel(db));

               if (selList)
                   findCellsMatchingQueryList(selList, function (cellIds) {
                        renderer.selectSet(cellIds);
                        renderer.drawDots();
                   });
               else
                   renderer.drawDots();

               // this requires coordinates to be loaded
               if (getVar("cell")!==undefined) {
                   selectCellsById([getVar("cell")], false, null)
               }

               //if (db.conf.multiModal && db.conf.multiModal.splitPrefix)
                   //renderer.split();
               if (db.conf.split) {
                   activateSplit();
                   let coordIdx = db.findCoordIdx(db.conf.split);
                   changeLayout(coordIdx);
               }
           }
       }

       function guessRadiusAlpha(dotCount) {
           /* return reasonable radius and alpha values for a number of dots */
           if (dotCount<3000)
               return [4, 0.7];
           if (dotCount<6000)
               return [4, 0.6];
           if (dotCount<10000)
               return [3, 0.5];
           if (dotCount<35000)
               return [2, 0.3];
           if (dotCount<80000)
               return [1, 0.5];
           // everything else
           return [0, 0.3];
       }

       function makeRendConf(dbConf, dotCount) {
           /* return the 'args' object for the renderer, based on dbConf and count of dots */
           var rendConf = {};

           var radius = dbConf.radius;
           var alpha = dbConf.alpha;

           if (radius===undefined || alpha===undefined) {
               var radiusAlpha = guessRadiusAlpha(dotCount);

               if (radius===undefined)
                   radius = radiusAlpha[0];
               if (alpha===undefined)
                   alpha = radiusAlpha[1];
            }

           rendConf["radius"] = radius;
           rendConf["alpha"] = alpha;

           rendConf["mode"] = "move"; // default mode, one of "move", "select" or "zoom"

           return rendConf;
        }

       var coordIdx = parseInt(getVar("layout", "0"))

       function gotFirstCoords(coords, info, clusterMids) {
           /* XX very ugly way to implement promises. Need to rewrite with promise() one day . */
           gotCoords(coords, info, clusterMids);
           chosenSetValue("tpLayoutCombo", coordIdx);
           doneOnePart();
       }

       var rendConf = makeRendConf(db.conf, db.conf.sampleCount);
       renderer.initPlot(rendConf);

       if (db.conf.showLabels===false || db.conf.labelField===undefined || db.conf.labelField===null)
           renderer.setShowLabels(false);

       buildLeftSidebar();
       buildToolBar(db.conf.coords, db.conf, metaBarWidth+metaBarMargin, menuBarHeight);
       buildSelectActions();

       db.loadCoords(coordIdx, gotFirstCoords, gotSpatial, onProgress);

       if ("traces" in db.conf.fileVersions)
           db.loadTraces(gotTraces);

       // -- this should probably go into a new function handleVars() or something like that ---
       if (getVar("select")!==undefined) {
           selList = JSURL.parse(getVar("select"));
       }

       // -- end of handleVars()?

       if (db.conf.atacSearch) {
           // peak loading needs the gene -> peak assignment, as otherwise can't show any peaks on the left
           // so defer the coloring until all the peaks are loaded
           let onLocsDone = function() { colorByDefaultField(doneOnePart); };
           db.loadGeneLocs(db.conf.atacSearch, db.conf.fileVersions.geneLocs, onLocsDone);
       } else
           // in gene mode, we can start coloring right away
           colorByDefaultField(doneOnePart);

       // pre-load the dataset description file, as the users will often go directly to the info dialog
       // and the following pre-loads risk blocking this load.
       var jsonUrl = cbUtil.joinPaths([db.conf.name, "desc.json"]) +"?"+db.conf.md5;
       fetch(jsonUrl);

       //if (db.conf.sampleCount < 50000) {
           if (db.conf.quickGenes)
               db.preloadGenes(db.conf.quickGenes, function() {
                   updateGeneTableColors(null);
                   if (getVar("heat")==="1")
                       onHeatClick();
                }, onProgressConsole, db.conf.binStrategy);
           db.preloadAllMeta();
        //}
    }

    function onTransClick(ev) {
    /* user has clicked transparency menu entry */
        var transText = ev.target.innerText;
        var transStr = transText.slice(0, -1); // remove last char
        var transFloat = 1.0 - (parseFloat(transStr)/100.0);
        transparency = transFloat;
        plotDots();
        $("#tpTransMenu").children().removeClass("active");
        $("#tpTrans"+transStr).addClass("active");
        renderer.render(stage);
    }

    function legendSort(sortBy) {
        /* sort the legend by "name" or "count" */
        var rows = gLegend.rows;

        if (sortBy==="name") {
            // index 2 is the label
            rows.sort(function(a, b) { return naturalSort(a.label, b.label); });
        }
        else {
            // sort this list by count = index 3
            rows.sort(function(a, b) { return b.count - a.count; }); // reverse-sort by count
        }
        buildLegendBar();
    }

    //function filterCoordsAndUpdate(cellIds, mode) {
    /* hide/show currently selected cell IDs or "show all". Rebuild the legend and the coloring. */
        //if (mode=="hide")
            //shownCoords = removeCellIds(shownCoords, cellIds);
        //else if (mode=="showOnly")
            //shownCoords = showOnlyCellIds(shownCoords, cellIds);
        //else
            //shownCoords = allCoords.slice();

        //pixelCoords = scaleData(shownCoords);

        //makeLegendObject();
        //buildLegendBar();
        //gSelCellIds = {};
        //plotDots();
        //renderer.render(stage);
        //menuBarShow("#tpShowAllButton");
    //}

    /* function onHideSelectedClick(ev) {
     user clicked the hide selected button
        filterCoordsAndUpdate(gSelCellIds, "hide");
        menuBarHide("#tpFilterButton");
        menuBarHide("#tpOnlySelectedButton");
        menuBarShow("#tpShowAllButton");
        ev.preventDefault();
    }


    function onShowOnlySelectedClick(ev) {
     // user clicked the only selected button
        filterCoordsAndUpdate(gSelCellIds, "showOnly");
        menuBarHide("#tpFilterButton");
        menuBarHide("#tpOnlySelectedButton");
        menuBarShow("#tpShowAllButton");
        ev.preventDefault();
    }

    function onShowAllClick(ev) {
    // user clicked the show all menu entry
        //gSelCellIds = {};
        filterCoordsAndUpdate(gSelCellIds, "showAll");
        shownCoords = allCoords.slice(); // complete copy of list, fastest in Blink
        pixelCoords = scaleData(shownCoords);
        makeLegendObject();
        buildLegendBar();
        gClasses = assignCellClasses();
        plotDots();
        menuBarHide("#tpFilterButton");
        menuBarHide("#tpOnlySelectedButton");
        menuBarHide("#tpShowAllButton");
        gLegend.lastClicked = null;
        renderer.render(stage);
    } */

    function onHideShowLabelsClick(ev) {
    /* user clicked the hide labels / show labels menu entry */
        if ($("#tpHideMenuEntry").text()===SHOWLABELSNAME) {
            renderer.setShowLabels(true);
            $("#tpHideMenuEntry").text(HIDELABELSNAME);
        }
        else {
            renderer.setShowLabels(false);
            $("#tpHideMenuEntry").text(SHOWLABELSNAME);
        }

        renderer.drawDots();
    }

    function onSizeClick(ev) {
    /* user clicked circle size menu entry */
        var sizeText = ev.target.innerText;
        var sizeStr = sizeText.slice(0, 1); // keep only first char
        circleSize = parseInt(sizeStr);
        $("#tpSizeMenu").children().removeClass("active");
        $("#tpSize"+circleSize).addClass("active");
        plotDots();
        renderer.render(stage);
    }

    function onZoom100Click(ev) {
    /* in addition to zooming (done by maxPlot already), reset the URL */
        changeUrl({'zoom':null});
        renderer.zoom100();
        renderer.drawDots();
        $("#tpZoom100Button").blur(); // remove focus
        ev.preventDefault();
        return false;
    }

    function activateMode(modeName) {
        renderer.activateMode(modeName);
    }

    function onZoomOutClick(ev) {
        var zoomRange = renderer.zoomBy(0.8);
        pushZoomState(zoomRange);
        renderer.drawDots();
        ev.preventDefault();
    }

    function onZoomInClick(ev) {
        var zoomRange = renderer.zoomBy(1.2);
        pushZoomState(zoomRange);
        renderer.drawDots();
        ev.preventDefault();
    }

    function onWindowResize(ev) {
        /* called when window is resized by user */
        if (ev.target.id==="tpHeat") // hack: do not do anything if jquery resizable() started this.
            return;
        resizeDivs();
    }

    function onColorPaletteClick(ev) {
        /* called when users clicks a color palette */
        var palName = ev.target.getAttribute("data-palette");
        if (palName==="default")
            legendSetColors(gLegend, null) // reset the colors
        legendChangePaletteAndRebuild(palName);
        renderer.drawDots();
    }

    function buildEmptyLegendBar(fromLeft, fromTop) {
        // create an empty right side legend bar
        var htmls = [];
        htmls.push("<div id='tpLegendBar' style='position:absolute;top:"+fromTop+"px;left:"+fromLeft+"px; width:"+legendBarWidth+"px'>");
        htmls.push("<div class='tpSidebarHeader'><div style='float:left'>Legend</div>");

        //htmls.push("<div id='tpToolbarButtons' style='padding-bottom: 2px'>");
        htmls.push("<div style='float:right' class='btn-group btn-group-xs'>");
            htmls.push("<button type='button' class='btn btn-default dropdown-toggle' data-toggle='dropdown' aria-haspopup='true' aria-expanded='false' id='tpChangeColorScheme'>Colors&nbsp;<span class='caret'> </span></button>");
            htmls.push('<ul class="dropdown-menu pull-right">');
            htmls.push('<li><a class="tpColorLink" data-palette="default" href="#">Reset to Default</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="rainbow" href="#">Qualitative: Rainbow</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="tatarize" href="#">Qualitative: Tatarize</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="iwanthue" href="#">Qualitative: Iwanthue</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="tol-dv" href="#">Semi-Qualitative: Paul Tol&#39;s</a></li>');
            //htmls.push('<li><a class="tpColorLink" data-palette="cb-Paired" href="#">Qualitative: paired</a></li>');
            //htmls.push('<li><a class="tpColorLink" data-palette="cb-Set3" href="#">Qualitative: pastel</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="blues" href="#">Gradient: shades of blue</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="reds" href="#">Gradient: shades of red</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="tol-sq-blue" href="#">Gradient: beige to red</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="tol-rainbow" href="#">Gradient: blue to red</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="viridis" href="#">Gradient: Viridis</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="magma" href="#">Gradient: Magma</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="inferno" href="#">Gradient: Inferno</a></li>');
            htmls.push('<li><a class="tpColorLink" data-palette="plasma" href="#">Gradient: Plasma</a></li>');
            htmls.push('</ul>');
        htmls.push("</div>"); // btn-group
        //htmls.push("</div>"); // tpToolbarButtons

        htmls.push("</div>"); // tpSidebarHeader

        //htmls.push("<div id='tpLegendTitleBox' style='position:relative; width:100%; height:1.5em'>");
        htmls.push("<div id='tpLegendContent'>");
        htmls.push("</div>"); // content
        htmls.push("</div>"); // bar
        $(document.body).append(htmls.join(""));

        $(".tpColorLink").click( onColorPaletteClick );
    }

    function getTextWidth(text, font) {
        // re-use canvas object for better performance
        // http://stackoverflow.com/questions/118241/calculate-text-width-with-javascript
        var canvas = getTextWidth.canvas || (getTextWidth.canvas = document.createElement("canvas"));
        var context = canvas.getContext("2d");
        context.font = font;
        var metrics = context.measureText(text);
        return metrics.width;
    }

    function populateTable(table, rows, cells, content) {
    /* build table from DOM objects */
        var is_func = (typeof content === 'function');
        if (!table) table = document.createElement('table');
        for (var i = 0; i < rows; i++) {
            var row = document.createElement('tr');
            for (var j = 0; j < cells; j++) {
                row.appendChild(document.createElement('td'));
                var text = !is_func ? (content + '') : content(table, i, j);
                row.cells[j].appendChild(document.createTextNode(text));
            }
            table.appendChild(row);
        }
        return table;
    }

    function legendGetColors(rows) {
    /* go over the legend lines: create an array of colors in the order of their meta value indexes.
     * (the values in the legend may be sorted not in the order of their internal indices) */
        if (rows===undefined)
            return [];

        var colArr = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var col = row.color;
            if (col===null)
                col = row.defColor; // only use default color if nothing else set

            var idx = row.intKey;
            colArr[idx] = col; // 0 = color
        }

        return colArr;
    }

    function legendUpdateLabels(fieldName) {
        /* re-copy the labels into the legend rows */
        // rows have attributes like these: defColor, currColor, label, count, valueIndex, uniqueKey
        var shortLabels = db.findMetaInfo(fieldName).ui.shortLabels;
        var rows = gLegend.rows;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var valIdx = row.intKey;
            var shortLabel = shortLabels[valIdx];
            row.label = shortLabel;
        }
    }

    function legendLabelGetIdx(legend, findLabel) {
         /* given a label, find the index in the legend */
        let rows = legend.rows;
        for (let i = 0; i < rows.length; i++) {
            let row = rows[i];
            if (row.label === findLabel)
                return i;
        }
        return null;
     }

    function legendRemoveManualColors(gLegend) {
        /* remove all manually defined colors from the legend */
        // reset the legend object
        legendSetColors(gLegend, null, "color");

        // reset the URL and local storage settings
        var rows = gLegend.rows;
        var urlChanges = {};
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var urlVar = COL_PREFIX+row.strKey;
            localStorage.removeItem(urlVar);
            urlChanges[urlVar] = null;

        }
        changeUrl(urlChanges);
    }


    function legendChangePaletteAndRebuild(palName, resetManual) {
        /* change the legend color palette and put it into the URL */
        var success = legendSetPalette(gLegend, palName);
        if (success) {
            if (palName==="default") {
                legendRemoveManualColors(gLegend);
                changeUrl({"pal":null});
            }
            else
                changeUrl({"pal":palName});
            buildLegendBar();
            var colors = legendGetColors(gLegend.rows);
            renderer.setColors(colors);
        }
    }

    function legendSetColors(legend, colors, keyName) {
        /* set the colors for all legend rows, keyName can be "color" or "defColor", depending on
         * whether the current row color or the row default color should be changed.
         * colors can also be null to reset all values to null. */
        if (!keyName)
            keyName = "color";
        var rows = legend.rows;
        for (let i = 0; i < rows.length; i++) {
            var colorVal = null;
            if (colors)
                colorVal = colors[i];

            var legendRow = rows[i];
            if (legendRow.label == "0" && legend.type=="expr")
                colorVal = cNullColor;
            legendRow[keyName] = colorVal;
        }
    }

    function legendSetPalette(legend, origPalName) {
    /* update the defColor [1] attribute of all legend rows. pal is an array of hex colors.
     * Will use the predefined colors that are
     * in the legend.metaInfo.colors configuration, if present.
     * */
        var palName = origPalName;
        if (origPalName==="default") {
            if (legend.rowType==="category")
                palName = datasetQualPalette;
            else
                palName = datasetGradPalette;
        }

        var rows = legend.rows;
        var n = rows.length;
        var pal = null;
        var usePredefined = false;

        pal = makeColorPalette(palName, n);
        // if this is a field for which colors were defined manually during the cbBuild, use them
        if (legend.metaInfo!==undefined && legend.metaInfo.colors!==undefined && origPalName==="default") {
            // the order of the color values in the metaInfo object is the same as the order of the order of the values in the
            // JSON file. But the legend has been sorted now, so we cannot just copy over the array as it is
            var rows = legend.rows;
            var predefColors = legend.metaInfo.colors;
            for (var i=0; i < rows.length; i++) {
                var origIndex = rows[i].intKey;
                var col = predefColors[origIndex];
                if (col !== null)
                    pal[i] = col;
            }
            usePredefined = true;
        } else
            pal = makeColorPalette(palName, n);

        if (pal===null) {
            alert("Sorry, palette '"+palName+"' does not have "+rows.length+" different colors");
            return false;
        }

        legendSetColors(legend, pal, "defColor");
        legend.palName = palName;

        // update the dropdown menu
        $('.tpColorLink').parent().removeClass("active");
        // force the menu to the "defaults" entry if we're using predefined colors
        if (usePredefined)
            palName = "default";
        $('.tpColorLink[data-palette="'+palName+'"]').parent().addClass("active");
        return true;
    }

     function labelForBinMinMax(binMin, binMax, isAllInt) {
        /* given the min/max of a numeric value bin, return a good legend for it */
        // pretty print the numbers
        var minDig = 2;
        //if (binMin % 1 === 0) // % 1 = fractional part
            //minDig = 0

        var maxDig = 2;
        //if (binMin % 1 === 0)
         //   maxDig = 0


        if (isAllInt) {
            minDig = 0;
            maxDig = 0
        }

        var legLabel = "";
        if (binMax===0 && binMax===0)
            legLabel = "0";
        else if (binMin==="Unknown")
            legLabel = "Unknown";
        else if (binMin!==binMax) {
            if (Math.abs(binMin) > 1000000)
                binMin = binMin.toPrecision(4);
            if (Math.abs(binMax) > 1000000)
                binMax = binMax.toPrecision(4);
            if (typeof(binMin)=== 'number')
                binMin = binMin.toFixed(minDig);
            if (typeof(binMax)=== 'number')
                binMax = binMax.toFixed(minDig);

            legLabel = binMin+' &ndash; '+binMax;
        }
        else
            legLabel = binMin.toFixed(minDig);
        return legLabel;
    }

    function makeLegendRowsNumeric(binInfo) {
        /* return an array of legend lines given bin info from gene expression or a numeric meta field  */
        var legendRows = [];

        // figure out if all our ranges are integers
        var isAllInt = true;
        for (var binIdx = 0; binIdx < binInfo.length; binIdx++) {
            let oneBin = binInfo[binIdx];
            var binMin = oneBin[0];
            var binMax = oneBin[1];

            var restMin = binMin - Math.trunc(binMin);
            var restMax = binMax - Math.trunc(binMax);
            if (restMin!==0 || restMax!==0)
                isAllInt = false;
        }

        var colIdx = 0;
        for (var binIdx = 0; binIdx < binInfo.length; binIdx++) {
            let oneBin = binInfo[binIdx];

            var binMin = oneBin[0];
            var binMax = oneBin[1];
            var count  = oneBin[2];

            var legendId = binIdx;

            var legLabel = labelForBinMinMax(binMin, binMax, isAllInt);

            var uniqueKey = legLabel;

            // override any color with the color specified in the current URL
            var savKey = COL_PREFIX+legLabel;
            var legColor = getVar(savKey, null);

            if (binMin===0 && binMax===0) {
                uniqueKey = "noExpr";
                legColor = cNullColor;
            }
            else if (binMin==="Unknown" && binMax==="Unknown") {
                uniqueKey = "noExpr";
                legColor = cNullColor;
            }
            else
                colIdx++;

            legendRows.push( {
                "color": legColor,
                "defColor":null,
                "label":legLabel,
                "count":count,
                "intKey":binIdx,
                "strKey":uniqueKey
            });
        }
        return legendRows;
    }

    function makeLegendExpr(geneSym, mouseOver, binInfo, exprVec, decExprVec) {
        /* build gLegend object for coloring by expression
         * return the colors as an array of hex codes */

        activateTooltip("#tpGeneSym");

        var legendRows = makeLegendRowsNumeric(binInfo);

        gLegend = {};
        gLegend.type = "expr";
        gLegend.rows = legendRows;
        var subTitle = null;
        if (db.isAtacMode()) {
            let peakCount = geneSym.split("+").length;
            if (peakCount===1)
                gLegend.title = "One ATAC peak";
            else
                gLegend.title = ("Sum of "+geneSym.split("+").length) + " ATAC peaks";
        }
        else {
            //  make a best effort to find the gene sym and gene ID
            if (geneSym.indexOf("+")===-1) {
                var geneInfo = db.getGeneInfo(geneSym);
                geneSym = geneInfo.sym;
                subTitle = geneInfo.id;
            } else {
                subTitle = "Sum of "+geneSym.split("+").length+" genes";
            }
            gLegend.title = getGeneLabel()+": "+geneSym;
        }

        gLegend.titleHover = mouseOver;
        gLegend.geneSym = geneSym;
        gLegend.subTitle = mouseOver;
        gLegend.rowType = "range";
        gLegend.exprVec = exprVec; // raw expression values, e.g. floats
        gLegend.decExprVec = decExprVec; // expression values as deciles, array of bytes
        gLegend.selectionDirection = "all";
        var oldPal = getVar("pal", "default")
        legendSetPalette(gLegend, oldPal);

        var colors = legendGetColors(legendRows);
        return colors;
    }

    function alphaNumSearch(genes, saneSym) {
        /* use alpha-num-only search in gene list for saneSym */
        for (var i=0; i<genes.length; i++) {
            var geneSym = genes[i][0];
            if (saneSym===onlyAlphaNum(geneSym))
                return geneSym;
        }
        return null;
    }

    function phoneHome() {
      /* add empty javascript to document so we can count usage at UCSC for grant reports */
      /* -> does this pose a data protection issue? Need to document. Does it require opt-in ? */
      var s = document.createElement( 'script' );
      s.setAttribute( 'src', "https://cells.ucsc.edu/js/cbTrackUsage.js" );
      s.async = true;
      document.body.appendChild( s );
    }

    function onGeneClick (event) {
    /* user clicked on a gene in the gene table */
        var locusId = event.target.getAttribute("data-geneId"); // the geneId of the gene
        var locusLabel = event.target.textContent;
        $('.tpMetaBox').removeClass('tpMetaSelect');
        $('.tpGeneBarCell').removeClass("tpGeneBarCellSelected");
        // XX TODO: How find all the elements with this ID?
        var saneId = onlyAlphaNum(locusId)
        $('#tpGeneBarCell_'+saneId).addClass("tpGeneBarCellSelected");

        colorByLocus(locusId, null, locusLabel);
        event.stopPropagation();
    }

    function showDialogBox(htmlLines, title, options) {
        /* show a dialog box with html in it */
        $('#tpDialog').remove();

        if (options===undefined)
            options = {};

        var addStr = "";
        if (options.width!==undefined)
            addStr = "max-width:"+options.width+"px;";
        var maxHeight = $(window).height()-200;
        // unshift = insert at pos 0
        //htmlLines.unshift("<div style='display:none;"+addStr+"max-height:"+maxHeight+"px' id='tpDialog' title='"+title+"'>");
        htmlLines.unshift("<div style='display:none;"+addStr+"' id='tpDialog' title='"+title+"'>");
        htmlLines.push("</div>");
        $(document.body).append(htmlLines.join(""));

        var dialogOpts = {modal:true, closeOnEscape:true};
        if (options.width!==undefined)
            dialogOpts["width"] = options.width;
        if (options.height!==undefined)
            dialogOpts["height"] = options.height;
        //dialogOpts["maxHeight"] = maxHeight;
        if (options.buttons!==undefined)
            dialogOpts["buttons"] =  options.buttons;
        else
            dialogOpts["buttons"] =  [];

        if (options.showClose!==undefined)
            dialogOpts["buttons"].unshift({ text:"Cancel", click:function() { $( this ).dialog( "close" ); }});
        if (options.showOk!==undefined)
            dialogOpts["buttons"].push({ text: "OK", click:function() { $( this ).dialog( "close" ); }});
        //dialogOpts["position"] = "center";
        //dialogOpts["height"] = "auto";
        //dialogOpts["width"] = "auto";

        $( "#tpDialog" ).dialog(dialogOpts);
    }

    function onChangeGenesClick(ev) {
    /* called when user clicks the "change" button in the gene list */
        var htmls = [];
        htmls.push("<p style='padding-bottom: 5px'>Enter a list of gene symbols, one per line:</p>");
        htmls.push("<textarea id='tpGeneListBox' class='form-control' style='height:320px'>");

        var geneFields = gCurrentDataset.preloadGenes.genes;
        for (var i = 0; i < geneFields.length; i++) {
            htmls.push(geneFields[i][1]+"\r\n");
        }
        htmls.push("</textarea>");
        //htmls.push("<p>");
        //htmls.push("<button style='float:center;' id='tpGeneDialogOk' class='ui-button ui-widget ui-corner-all'>OK</button>");
        //htmls.push("</div>");
        //htmls.push("</div>");
        var buttons = [{text:"OK", click:onGeneDialogOkClick}];
        showDialogBox(htmls, "Genes of interest", {height: 500, width:400, buttons:buttons});

        $('#tpGeneDialogOk').click ( onGeneDialogOkClick );
    }

    function onSetRadiusAlphaClick(ev) {
        let newRadius = parseFloat(getById('tpSizeInput').value);
        let newAlpha = parseFloat(getById('tpAlphaInput').value);
        renderer.setRadiusAlpha(newRadius, newAlpha);
        renderer.drawDots();
    }

    function onGeneLoadComplete() {
        /* called when all gene expression vectors have been loaded */
        console.log("All genes complete");
        // Close the dialog box only if all genes were OK. The user needs to see the list of skipped genes
        if ( $( "#tpNotFoundGenes" ).length===0 ) {
            $("#tpDialog").dialog("close");
        }

        var cellIds = getSortedCellIds();

        // transform the data from tpLoadGeneExpr as gene -> list of values (one per cellId) to
        // newExprData cellId -> list of values (one per gene)

        // initialize an empty dict cellId = floats, one per gene
        var newExprData = {};
        var geneCount = gLoad_geneList.length;
        var cellIdCount = cellIds.length;
        for (var i = 0; i < cellIdCount; i++) {
            let cellId = cellIds[i];
            newExprData[cellId] = new Float32Array(gLoad_geneList); // XX or a = [] + a.length = x ?
        }

        // do the data transform
        var newGeneFields = [];
        var newDeciles = {};
        for (var geneI = 0; geneI < gLoad_geneList.length; geneI++) {
            var geneSym = gLoad_geneList[geneI];
            var geneInfo = gLoad_geneExpr[geneSym];

            var geneId = geneInfo[0];
            var geneVec = geneInfo[1];
            var deciles = geneInfo[2];
            newGeneFields.push( [geneSym, geneId] );
            newDeciles[geneSym] = deciles;

            for (var cellI = 0; cellI < cellIdCount; cellI++) {
                let cellId = cellIds[cellI];
                newExprData[cellId][geneI] = geneVec[cellI];
            }
        }

        gLoad_geneList = null;
        gLoad_geneExpr = null;

        gCurrentDataset.preloadExpr = {};
        gCurrentDataset.preloadExpr.genes = newGeneFields;
        gCurrentDataset.preloadExpr.cellExpr = newExprData;
        gCurrentDataset.preloadExpr.deciles = newDeciles;

    }

    function onGeneDialogOkClick(ev) {
    /* called the user clicks the OK button on the 'paste your genes' dialog box */
        var genes = $('#tpGeneListBox').val().replace(/\r\n/g, "\n").split("\n");
        $("#tpDialog").remove();

        gLoad_geneList = [];
        gLoad_geneExpr = {};

        var notFoundGenes = [];
        var baseUrl = gCurrentDataset.baseUrl;
        var url = cbUtil.joinPaths([baseUrl, "geneMatrix.tsv"]);
        var validCount = 0; // needed for progressbar later
        var matrixOffsets = gCurrentDataset.matrixOffsets;
        for (var i = 0; i < genes.length; i++) {
            var gene = genes[i];
            if (gene.length===0) // skip empty lines
                continue;
            if (!(gene in matrixOffsets))
                {
                notFoundGenes.push(gene);
                continue;
                }

            gLoad_geneList.push(gene);
            var offsetInfo = matrixOffsets[gene];
            var start = offsetInfo[0];
            var end = start+offsetInfo[1];
            jQuery.ajax( { url: url,
                headers: { Range: "bytes="+start+"-"+end } ,
                geneSymbol : gene,
                success: onReceiveExprLineProgress
            });
        }

        var htmls = [];
        htmls.push("<div id='tpGeneProgress'><div class='tpProgressLabel' id='tpProgressLabel'>Loading...</div></div>");

        if (notFoundGenes.length!==0) {
            htmls.push("<div id='tpNotFoundGenes'>Could not find the following gene symbols: ");
            htmls.push(notFoundGenes.join(", "));
            htmls.push("</div>");
            //htmls.push("<button style='float:center;' id='tpGeneDialogOk' class='ui-button ui-widget ui-corner-all'>OK</button>");
            //for (var i = 0; i < notFoundGenes.length; i++) {
                //htmls.push(notFoundGenes[i]);
            //}
            //htmls.push("<p>Could not find the following gene symbols:</p>");
            //showDialogBox(htmls, "Warning", 400);
        }

        var showOk = (notFoundGenes.length!==0);
        showDialogBox(htmls, "Downloading expression data", {width:350, showOk:true});

        var progressLabel = $( "#tpProgressLabel" );
        $("#tpGeneProgress").progressbar( {
              value: false,
              max  : gLoad_geneList.length
              });

    }

    function shortenRange(s) {
        /* reformat atac range chr1|start|end to chr1:10Mbp */
        var parts = s.split("|");
        return parts[0]+":"+prettyNumber(parts[1]);
    }

    function htmlAddInfoIcon(htmls, helpText, placement) {
        /* add an info icon with some text to htmls */
        var iconHtml = '<svg style="width:0.9em" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Pro 6.1.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. --><path d="M256 0C114.6 0 0 114.6 0 256s114.6 256 256 256s256-114.6 256-256S397.4 0 256 0zM256 128c17.67 0 32 14.33 32 32c0 17.67-14.33 32-32 32S224 177.7 224 160C224 142.3 238.3 128 256 128zM296 384h-80C202.8 384 192 373.3 192 360s10.75-24 24-24h16v-64H224c-13.25 0-24-10.75-24-24S210.8 224 224 224h32c13.25 0 24 10.75 24 24v88h16c13.25 0 24 10.75 24 24S309.3 384 296 384z"/></svg>';
        var addAttrs = "";
        if (placement!==undefined)
            addAttrs = " data-placement='"+placement+"'"
        htmls.push("<span class='hasTooltip' title='"+helpText+"'"+addAttrs+">&nbsp;"+iconHtml+"</span>");
        return htmls;
    }

    function buildGeneTable(htmls, divId, title, subtitle, geneInfos, noteStr, helpText) {
    /* create gene expression info table. if htmls is null, update DIV with divId in-place. 
     * geneInfos is array of [gene, mouseover]. gene can be geneId+"|"+symbol. 
     * You must run activateTooltip(".hasTooltip") after adding the htmls.
     * */
        var doUpdate = false;
        if (htmls===null) {
            htmls = [];
            doUpdate = true;
        }

        var tableWidth = metaBarWidth;

        if (title) {
            htmls.push("<div style='margin-top:8px' id='"+divId+"_title'>");
            htmls.push("<div style='display: inline; padding-left:3px; font-weight:bold'>"+title+"</div>");
            if (helpText) {
                // https://fontawesome.com/icons/circle-info?s=solid
                htmls = htmlAddInfoIcon(htmls, helpText);
            }
            if (subtitle) {
                htmls.push('<div style="margin-top:6px" class="tpHint">');
                htmls.push(subtitle);
                htmls.push('</div>');
            }
            htmls.push("</div>"); // divId_title

        }

        if (doUpdate) {
            $('#'+divId).empty();
        }

        htmls.push("<div id='"+divId+"'>");

        if (geneInfos===undefined || geneInfos===null || geneInfos.length===0) {
            if (noteStr!==undefined)
                htmls.push("<div style='font-style:80%'>"+noteStr+"</div>");
            htmls.push("</div>");
            return;
        }

        var i = 0;
        while (i < geneInfos.length) {
            var geneInfo = geneInfos[i];
            var geneIdOrSym   = geneInfo[0];
            var mouseOver = geneInfo[1];

            // geneIdOrSym can be just the symbol (if we all we have is symbols) or geneId|symbol
            var internalId;
            var label;
            if (geneIdOrSym.indexOf("|")!==-1) {
                if (db.isAtacMode()) {
                    label = shortenRange(geneIdOrSym);
                    internalId = geneIdOrSym;
                    //if (mouseOver!==undefined) {
                        //label = mouseOver.split()[0];
                        //internalId = geneIdOrSym;
                    //} else {
                        // quickGene is a range in format chr|123123|125443
                        //label = shortenRange(geneIdOrSym);
                        //internalId = geneIdOrSym;
                    //}
                } else {
                    var parts = geneIdOrSym.split("|");
                    internalId = parts[0];
                    label = parts[1];
                }
            } else {
                internalId = geneIdOrSym;
                label = internalId;
            }

            if (mouseOver===undefined)
                mouseOver = internalId;

            htmls.push('<span title="'+mouseOver+'" style="width: fit-content;" data-geneId="'+internalId+'" id="tpGeneBarCell_'+onlyAlphaNum(internalId)+'" class="hasTooltip tpGeneBarCell">'+label+'</span>');
            i++;
        }
        htmls.push("</div>"); // divId

        if (doUpdate) {
            $('#'+divId).html(htmls.join(""));
        }
    }

    function resizeGeneTableDivs(tableId) {
        /* the size of the DIVs in the gene table depends on the size of the longest DIV in pixels and we know that only once the table is shown. so resize here now */
        var tdEls = document.getElementById(tableId).querySelectorAll("span");
        var maxWidth = 0;
        var totalWidth = 0;
        for (var el of tdEls) {
            maxWidth = Math.max ( maxWidth, el.offsetWidth+2 ); // 2 pixel borders
            totalWidth = totalWidth + el.offsetWidth;
        }

        // if we have less than one row, make the cells cover the whole row, but limit the total size a little
        if (totalWidth < (metaBarWidth-(tdEls.length*6))) // 6 pixels for the borders = 2 + 2 + 2 for the selection border.
            maxWidth = Math.min(70, Math.floor(metaBarWidth/tdEls.length)-6);

        for (var el of tdEls) {
            el.style.minWidth = maxWidth+"px";
        }
    }

    function likeEmptyString(label) {
    /* some special values like "undefined" and empty string get colored in grey  */
        return (label===null || label.trim()==="" || label==="none" || label==="None" || label==="unknown" ||
            label==="nd" || label==="n.d." ||
            label==="Unknown" || label==="NaN" || label==="NA" || label==="undefined" || label==="Na");
    }

    function numMetaToBinInfo(fieldInfo) {
        /* convert a numeric meta field info to look like gene expression info for the legend:
         * an array of [start, end, count] */
        var binInfo = [];
        var binMethod = fieldInfo.binMethod;
        if (binMethod==="uniform") {
            // old method, not used anymore
            let binMin = fieldInfo.minVal;
            var stepSize = fieldInfo.stepSize;
            let binCounts = fieldInfo.binCounts;
            let binCount = fieldInfo.binCounts.length;
            for (var i=0; i<binCount; i++) {
                binInfo.push( [binMin, binMin+stepSize, binCounts[i]] );
                binMin+=stepSize;
            }
        } else if (binMethod==="quantiles") {
            // newer method for pre-quantified fields
            let binMin = fieldInfo.minVal;
            let breaks = fieldInfo.breaks;
            let binCounts = fieldInfo.binCounts;
            let binCountsLen = fieldInfo.binCounts.length;
            let binIdx = 0;
            if (breaks[0]==="Unknown") {
                binInfo.push( ["Unknown", "Unknown", binCounts[0]] );
                binIdx = 1;
            }

            for (; binIdx<binCountsLen; binIdx++) {
                let binMin = breaks[binIdx];
                let binMax = breaks[binIdx+1];
                let binCount = binCounts[binIdx];
                binInfo.push( [binMin, binMax, binCount] );
            }
        }
        else if (binMethod==="raw") {
            // no binning was done at all, this happens when there are not enough distinct values
            let values = fieldInfo.values;
            let binCounts = fieldInfo.binCounts;
            for (let i=0; i<values.length; i++) {
                let value = values[i];
                let valCount = binCounts[i];
                binInfo.push( [value, value, valCount] );
            }
        }
        else
            // these days, we don't pre-quantify anymore. The binning is done on the client now
            // and the meta loading function adds the bin info to the field info object
            //alert("invalid value for meta field binMethod: "+binMethod);
            binInfo = fieldInfo.binInfo;

        return binInfo;
    }

    function getFieldColors(metaInfo) {
        /* return a list with the color codes for a field, taking into account field type and cart settings */

        let palName = metaInfo.ui.palette;
        let colCount;
        if (!palName)
            if (metaInfo.type==="int" || metaInfo.type==="float") {
                palName = datasetGradPalette;
                colCount = exprBinCount+1; // +1 because <unknown> is a special bin
            }
            else {
                palName = cDefQualPalette;
                colCount = metaInfo.valCounts.length;
            }

        var colors = makeColorPalette(palName, colCount);

        let colOverrides = metaInfo.ui.colors;
        if (colOverrides)
            for (let i=0; i<colOverrides.length; i++)
                if (colOverrides[i])
                    colors[i] = colOverrides[i];

        return colors;
    }

    function makeLegendMeta(metaInfo, sortBy) {
    /* Build a new legend object and return it */
        var legend = {};
        legend.type = "meta";
        legend.titleHover = null;

        legend.title = metaInfo.label.replace(/_/g, " ");
        legend.metaInfo = metaInfo;

        // numeric meta fields are a special case
        if (metaInfo.type==="int" || metaInfo.type==="float") {
            var binInfo = numMetaToBinInfo(metaInfo);
            legend.rows = makeLegendRowsNumeric(binInfo);
            legend.rowType = "range";
            legendSetPalette(legend, "default");
            return legend;
        }

        if (metaInfo.diffValCount > MAXCOLORCOUNT) {
            warn("This field has "+metaInfo.diffValCount+" different values. Coloring on a "+
                "field that has more than "+MAXCOLORCOUNT+" different values is not supported.");
            return null;
        }

        var metaCounts = metaInfo.valCounts; // array of [count, value]

        // we are going to sort this list later, so we need to keep track of what the original
        // index in the list was, as every meta data value is stored by its index, not
        // its label. Simply append the index as [2] of the metaCounts array.
        for (var valIdx=0; valIdx < metaCounts.length; valIdx++)
            metaCounts[valIdx].push(valIdx);

        var oldSortBy = getFromUrl("SORT");
        // URL overrides default value
        if (sortBy===undefined && oldSortBy!==undefined)
            sortBy = oldSortBy;

        // default sorting can be specfied with "sortBy" in cellbrowser.conf
        if (sortBy===undefined && metaInfo.sortBy)
            sortBy = metaInfo.sortBy;
        if (sortBy!==undefined && sortBy!=="freq" && sortBy!=="name" && sortBy!=="none") {
            alert("sortBy is '"+cleanString(sortBy)+' but it can only be "freq" or "name"');
            sortBy = undefined;
        }

        var fieldName = metaInfo.label;

        // force field names that look like "cluster" to a rainbow palette
        // even if they are numbers
        if (sortBy===undefined) {
            // should cluster fields be sorted by their name
            if (metaInfo.type==="float" || metaInfo.type==="int" || (metaCounts.length > 60))
                // long lists are easier to grasp if they're sorted by name
                sortBy = "name";
            else if (fieldName.indexOf("luster") || fieldName.indexOf("ouvain") || fieldName.indexOf("res."))
                sortBy = "count";
            else
                sortBy = "count";
        }

        // sort like numbers if the strings are mostly numbers, otherwise sort like strings
        var sortResult = sortPairsBy(metaCounts, sortBy);
        var countListSorted = sortResult.list;

        var useGradient = (metaInfo.type==="float" || metaInfo.type==="int");
        //var defaultColors = makeColorPalette(countListSorted.length, useGradient);

        var rows = [];
        var shortLabels = metaInfo.ui.shortLabels;
        var longLabels = metaInfo.ui.longLabels;
        for (var legRowIdx = 0; legRowIdx < countListSorted.length; legRowIdx++) {
            var legRowInfo = countListSorted[legRowIdx];
            let valIdx = legRowInfo[2]; // index of the original field in fieldInfo
            var label = shortLabels[valIdx];

            var desc  = null;
            if (longLabels)
                desc  = longLabels[valIdx];

            // first use the default palette, then try to get from URL
            var count = legRowInfo[1];
            var uniqueKey = label;
            if (uniqueKey==="")
                uniqueKey = "_EMPTY_";

            var color = null;
            // default any color that looks like "NA" or "undefined" to grey
            if (likeEmptyString(label))
                color = cNullColor;
            // override any color with the color specified in the current URL
            var savKey = COL_PREFIX+uniqueKey;
            color = getFromUrl(savKey, null);

            rows.push( {
                "color": color,
                "defColor": color,
                "label": label,
                "count": count,
                "intKey":valIdx,
                "strKey":uniqueKey,
                "longLabel" : desc,
            } );
        }

        legend.rows = rows;
        legend.isSortedByName = sortResult.isSortedByName;
        legend.rowType = "category";
        legend.selectionDirection = "all";
        legendSetPalette(legend, "default");
        return legend;
    }

    function legendSetTitle(label) {
        $('#tpLegendTitle').text(label);
    }

    function buildLegendForMeta(metaInfo) {
    /* build the gLegend for a meta field */
        var legend = makeLegendMeta(metaInfo);
        if (legend===null)
            return;

        var metaIdx = db.fieldNameToIndex(metaInfo.name);
        $('.tpMetaBox').removeClass('tpMetaSelect');
        $('.tpMetaValue').removeClass('tpMetaValueSelect');
        $('#tpMetaBox_'+metaIdx).addClass('tpMetaSelect');
        $('#tpMeta_'+metaIdx).addClass('tpMetaValueSelect');
        $('.tpGeneBarCell').removeClass('tpGeneBarCellSelected');
        //$('#tpLegendTitle').text(legend.metaInfo.label.replace(/_/g, " "));
        legendSetTitle(legend.metaInfo.label.replace(/_/g, " "));

        return legend;
    }

    function onMetaClick (event) {
    /* called when user clicks a meta data field or label */
        var fieldName = event.target.dataset.fieldName;
        if (isNaN(fieldName)) {
            // try up one level in the DOM tree, in case the user clicked the little child div in the meta list
            fieldName = event.target.parentElement.dataset.fieldName;
        }
        setColorByDropdown(fieldName);
        colorByMetaField(fieldName);
    }

    function addMetaTipBar(htmls, valFrac, valStr, valFracCategory) {
        /* add another bar to a simple histogram built from divs */
        htmls.push("<div>&nbsp;");
        htmls.push("<div class='tpMetaTipPerc'>"+(100*valFrac).toFixed(1)+"%</div>");
        htmls.push("<div class='tpMetaTipName'>"+valStr);
        if (valFracCategory !== undefined) {
            htmls.push(" <small>(" + (100 * valFracCategory).toFixed(1) + "% of all cells with this value)</small>");
        }
        htmls.push("</div>");
        //htmls.push("<span class='tpMetaTipCount'>"+valCount+"</span>");
        var pxSize = (valFrac * metaTipWidth).toFixed(0);
        htmls.push("<div style='width:"+pxSize+"px' class='tpMetaTipBar'>&nbsp</div>");
        htmls.push("</div>");
    }

    function binInfoToValCounts(binInfo) {
        /* given an array of (start, end, count), return an array of (label, count) */
        var valCounts = [];

        for (var binIdx = 0; binIdx < binInfo.length; binIdx++) {
            var binMin = binInfo[binIdx][0];
            var binMax = binInfo[binIdx][1];
            var count  = binInfo[binIdx][2];
            var label = labelForBinMinMax(binMin, binMax);
            valCounts.push( [label, count] );
        }
        return valCounts;
    }

    function buildMetaTip(metaInfo, valHist, htmls) {
        /* build the content of the tooltip that summarizes the multi selection */
        var valCounts = metaInfo.valCounts;
        var shortLabels = metaInfo.ui.shortLabels;
        if (valCounts===undefined)  // for client-side discretized fields, we have to discretize first
            valCounts = binInfoToValCounts(metaInfo.binInfo);

        var otherCount = 0;
        var totalSum = 0;
        for (var i = 0; i < valHist.length; i++) {
            var valInfo  = valHist[i];
            var valCount = valInfo[0];
            var valFrac  = valInfo[1];
            var valIdx   = valInfo[2];
            var valFracCategory = valInfo[3];
            //var valStr   = valCounts[valIdx][0]; // 0 = label, 1 = count
            var label   = shortLabels[valIdx];

            totalSum += valCount;
            // only show the top values, summarize everything else into "other"
            if (i > HISTOCOUNT) {
                otherCount += valCount;
                continue;
            }

            if (label==="")
                label = "<span style='color:indigo'>"+stringEmptyLabel("")+"</span>";
            addMetaTipBar(htmls, valFrac, label, valFracCategory);
        }

        if (otherCount!==0) {
            var otherFrac = (otherCount / totalSum);
            addMetaTipBar(htmls, otherFrac, "<span style='color:indigo'>(other)</span>");
        }
        return htmls;
    }

    function metaInfoFromElement(target) {
        /* get the metaInfo object given a DOM element  */
        if (target.dataset.fieldName === undefined)
            target = target.parentNode;
        if (target.dataset.fieldName === undefined)
            target = target.parentNode;
        var fieldName = target.dataset.fieldName;
        var metaInfo = db.findMetaInfo(fieldName);
        return metaInfo;
    }

    function onSelectSameLinkClick (ev) {
        /* user clicks the "select same" link in the meta bar */
        let parent = ev.target.parentElement;
        let metaIdx = parent.id.split("_")[1];
        let metaBarField = gMeta.rows[metaIdx];
        findCellsMatchingQueryList([{"m":metaBarField.field, "eq":metaBarField.value}], 
            function(cellIds) {
                colorByMetaField(metaBarField.field);
                renderer.selectSet(cellIds);
                renderer.drawDots();
                }
            );
    }

    function onMetaMouseOver (event) {
    /* called when user hovers over meta element: shows the histogram of selected cells */
        var metaHist = db.metaHist;

        // mouseover over spans or divs will not find the id, so look at their parent, which is the main DIV
        var target = event.target;

        var metaInfo = metaInfoFromElement(target);
        var fieldName = metaInfo.name;

        // change style of this field a little
        var metaSel = "#tpMetaBox_"+metaInfo.index;
        $(metaSel).addClass("tpMetaHover");
        $(metaSel+" .tpMetaValue").addClass("tpMetaHover");

        $(".tpSameLink").remove();

        if (gMeta.mode==="single" && metaInfo.type==="enum" && renderer.getSelection().length==1) {
            $("#tpMeta_"+metaInfo.index).append("<div title='select all cells with this value in this meta data field' class='tpSameLink' style='cursor: pointer; color:darkgrey; float:right'>Select same</div>");
            $('.tpSameLink').on("click", onSelectSameLinkClick);
        }

        if (metaHist===undefined || metaHist===null)
            return;

        var htmls = [];

        if (metaInfo.type==="uniqueString")
            htmls.push("<div>Cannot summarize: this is a field with unique values</div>");
        else
            htmls = buildMetaTip(metaInfo, metaHist[fieldName], htmls);

        $('#tpMetaTip').html(htmls.join(""));

        // make sure that tooltip doesn't go outside of screen
        //var tipTop = event.target.offsetTop;
        var tipTop = event.target.getBoundingClientRect().top-8;
        var tipHeight = $('#tpMetaTip').height();
        var screenHeight = $(window).height();
        if (tipTop+tipHeight > screenHeight)
            tipTop = screenHeight - tipHeight - 8;

        $('#tpMetaTip').css({top: tipTop+"px", left: metaBarWidth+"px", width:metaTipWidth+"px"});
        $('#tpMetaTip').show();
        activateTooltip(".tpSameLink");
    }

    function buildComboBox(htmls, id, entries, selIdx, placeholder, width, opts) {
    /* make html for a combo box and add lines to htmls list.
     * selIdx is an array of values if opt.multi exists, otherwise it's an int or 'undefined' if none. */

        let addStr = "";
        if (opts && opts.multi)
            addStr= " multiple";

        htmls.push('<select style=width:"'+width+'px" id="'+id+'"'+addStr+' data-placeholder="'+placeholder+'" class="tpCombo">');
        for (var i = 0; i < entries.length; i++) {
            var isSelStr = "";
            var entry = entries[i];

            // entries can be either key-val or just values
            var name, label;
            if (Array.isArray(entry)) {
                name = entry[0];
                label = entry[1];
            } else {
                name = label = entry;
            }

            // determine if element is selected
            let isSel = false;
            if (opts && opts.multi) {
                if (selIdx.indexOf(i)!==-1 || selIdx.indexOf(name)!==-1)
                    isSel = true;
            } else if ((selIdx!==undefined && i===selIdx))
                isSel = true;

            if (isSel)
                isSelStr = " selected";

            htmls.push('<option value="'+name+'"'+isSelStr+'>'+label+'</option>');
        }
        htmls.push('</select>');
    }

    function loadCoordSet(coordIdx, labelFieldName) {
        /* load coordinates and color by meta data */
        var newRadius = db.conf.coords[coordIdx].radius;
        var colorOnMetaField = db.conf.coords[coordIdx].colorOnMeta;
        renderer.background = null; // remove the background image

        db.loadCoords(coordIdx,
                function(coords, info, clusterMids) {
                    gotCoords(coords,info,clusterMids, newRadius);

                    setLabelField(labelFieldName);
                    setLabelDropdown(labelFieldName);

                    if (colorOnMetaField!==undefined) {
                        setColorByDropdown(colorOnMetaField);
                        colorByMetaField(colorOnMetaField, undefined);
                    }
                    else
                        renderer.drawDots();
                },
                gotSpatial,
                onProgress);
    }

    function changeLayout(coordIdx) {
        var labelFieldName = null;
        var labelFieldVal = $("#tpLabelCombo").val();
        if (labelFieldVal!==null) {
            var labelFieldToken = $("#tpLabelCombo").val().split("_")[1];
            if (labelFieldToken!=="none") {
                var labelFieldIdx = parseInt(labelFieldToken);
                labelFieldName = db.getMetaFields()[labelFieldIdx].name;
            }
        }

        loadCoordSet(coordIdx, labelFieldName);

        changeUrl({"layout":coordIdx, "zoom":null});
        renderer.coordIdx = coordIdx;
    }

    function onLayoutChange(ev, params) {
        /* user changed the layout in the combobox */
        var coordIdx = parseInt(params.selected);
        changeLayout(coordIdx);

        // remove the focus from the combo box
        removeFocus();
    }

    function onGeneComboChange(ev) {
        /* user changed the gene in the combobox */
        var geneId = ev.target.value;
        if (geneId==="")
            return; // do nothing if user just deleted the current gene

        if (db.conf.atacSearch) {
            updatePeakListWithGene(geneId);
        } else {
            // in the normal, gene-matrix mode.
            var locusStr = null;
            var geneInfo = db.getGeneInfo(geneId);
            colorByLocus(geneInfo.id);
        }
    }

    function onMetaComboChange(ev, choice) {
        /* called when user changes the meta field combo box */
        //if (choice.selected==="_none")
        var fieldId = parseInt(choice.selected.split("_")[1]);
        var fieldName = db.getMetaFields()[fieldId].name;
        console.log(choice);
        console.log(ev);

        colorByMetaField(fieldName);
    }

    function onLabelComboChange(ev, choice) {
        /* called when user changes the label field combo box */
        var fieldLabel = choice.selected.split("_")[1];
        if (fieldLabel==="none")
            setLabelField(null); // = switch off labels
        else {
            var fieldIdx = parseInt(fieldLabel);
            var fieldName = db.getMetaFields()[fieldIdx].name;
            setLabelField(fieldName);
        }
        renderer.drawDots();
    }

    function showCollectionDialog(collName) {
        /* load collection with given name and open dialog box for it */
        loadCollectionInfo(collName, function(collData) { openDatasetDialog(collData)});
    }

    function onConfigLoaded(datasetName) {
        /* dataset config JSON is loaded -> build the entire user interface */
        // this is a collection if it does not have any field information
        if (db.conf.sampleDesc)
            gSampleDesc = db.conf.sampleDesc;
        else
            gSampleDesc = "cell";

        // allow config to override the default palettes
        datasetGradPalette = cDefGradPalette;
        datasetQualPalette = cDefQualPalette;
        if (db.conf.defQuantPal)
            datasetGradPalette = db.conf.defQuantPal;
        if (db.conf.defCatPal)
            datasetQualPalette = db.conf.defCatPal;

        if (db.conf.metaBarWidth)
            metaBarWidth = db.conf.metaBarWidth;
        else
            metaBarWidth = 250;

        renderer.setPos(null, metaBarWidth+metaBarMargin);

        if (!db.conf.metaFields) {
            // pablo often has single-dataset installations, there is no need to open the
            // dataset selection box then.
            if (db.conf.datasets && db.conf.datasets.length===1 && datasetName==="") // "" is the root dataset
                loadDataset(db.conf.datasets[0].name, false);
            else
                showCollectionDialog(datasetName);
            return;
        }

        let binData = localStorage.getItem(db.name+"|custom");
        if (binData) {
            let jsonStr = LZString.decompress(binData);
            let customMeta = JSON.parse(jsonStr);
            db.conf.metaFields.unshift(customMeta);
        }

        cartLoad(db);
        if (getVar("exprGene")) {
            // show the gene expression viewer
            buildExprViewWindow()
        }
        else {
            // show the UMAP view
            let showTutorial = true;

            loadAndRenderData();
            resizeDivs(true);
            // special URL argument allows to force the info dialog to open
            if (getVar("openDialog")) {
                openDatasetDialog(db.conf, db.name); // open Info dialog
                showTutorial = false;
            }
            cartSave(db); // = set the current URL from local storage settings

            // start the tutorial after a while
            var introShownBefore = localStorage.getItem("introShown");
            if (introShownBefore===undefined)
               setTimeout(function(){ showIntro(true); }, 3000); // shown after 5 secs
        }

    }

    function loadDataset(datasetName, resetVars, md5) {
        /* load a dataset and optionally reset all the URL variables.
         * When a dataset is opened through the UI, the variables have to
         * be reset, as their values (gene or meta data) may not exist
         * there. If it's opened via a URL, the variables must stay. */

        gRecentGenes = [];
        // collections are not real datasets, so ask user which one they want

        if (db!==null && db.heatmap)
            removeHeatmap();
        removeSplit();

        db = new CbDbFile(datasetName);
        cellbrowser.db = db; // easier debugging

        var vars;
        if (resetVars)
            vars = {};

        if (datasetName!=="")
            changeUrl({"ds":datasetName.replace(/\//g, " ")}, vars); // + is easier to type than %23

        db.loadConfig(onConfigLoaded, md5);
        trackEvent("open_dataset", datasetName);
        trackEventObj("select_content", {content_type: "dataset", item_id: datasetName});
    }

    function loadCollectionInfo(collName, onDone) {
        /* load collection info and run onDone */
        var jsonUrl = cbUtil.joinPaths([collName, "dataset.json"]);
        cbUtil.loadJson(jsonUrl, onDone);
    }

    function onDatasetChange(ev, params) {
        /* user changed the dataset in the collection dropdown box */
        /* jshint validthis: true */
        $(this).blur();
        removeFocus();

        var parts = params.selected.split("?");
        var datasetName = parts[0];
        var md5 = parts[1];
        loadDataset(datasetName, true, md5);
    }

    function buildLayoutCombo(coordLabel, htmls, files, id, left, top) {
        /* files is a list of elements with a shortLabel attribute. Build combobox for them. */
        if (!coordLabel)
            coordLabel = "Layout";

        //htmls.push('<div class="tpToolBarItem" style="position:absolute;left:'+left+'px;top:'+top+'px"><label for="'+id+'">');
        htmls.push('<div class="tpLeftSideItem"><label for="'+id+'">');
        htmls.push(coordLabel);
        htmls.push("</label>");

        var entries = [];
        for (var i = 0; i < files.length; i++) {
            var coordFiles = files[i];
            var label = coordFiles.shortLabel;
            if (label===undefined)
                warn("Layout coordinate file "+i+" has no .shortLabel attribute");
            entries.push([i, label]);
        }
        buildComboBox(htmls, id, entries, 0, "Select a layout algorithm...", "100%");
        htmls.push('</div>');

        htmls.push('<form id="radiusAlphaForm">');
        htmls.push('<div class="tpLeftSideItem">');
        htmls.push('<label for="tpSizeInput">Circle size factor (1-7)</label>');
        htmls.push('&nbsp;<input id="tpSizeInput" type="text" size="6"></input>');
        htmls.push('</div>'); // tpLeftSideItem

        htmls.push('<div class="tpLeftSideItem">');
        htmls.push('<label for="tpAlphaInput">Transparency factor (1-7)</label>');
        htmls.push('&nbsp;<input id="tpAlphaInput" type="text" size="6"></input>');
        htmls.push('</div>'); // tpLeftSideItem

        htmls.push('<input type="submit" value="Apply" style="float:right" id="tpSetRadiusAlphaButton"></input><br>');
        htmls.push('<small>You can also change size and transparency with the sliders at the bottom right of the image</small>');
        htmls.push('</form>');
    }

    function buildCollectionCombo(htmls, id, width, left, top) {
        /* build combobox with shortLabels of all datasets that are part of same collection */
        //htmls.push('<div class="tpToolBarItem" style="position:absolute;width:'+width+'px;left:'+left+'px;top:'+top+'px"><label for="'+id+'">Jump to...</label>');
        htmls.push('<div class="tpToolBarItem" style="position:relative;top:3px; margin-left:10px;width:'+width+'px;top:'+top+'px"><label for="'+id+'">Jump to...</label>');

        var entries = [];
        //var linkedDatasets = parentConf.datasets;
        //for (var i = 0; i < linkedDatasets.length; i++) {
            //var dsInfo = linkedDatasets[i];
            //entries.push( [i, dsInfo.shortLabel] );
        //}

        buildComboBox(htmls, id, entries, 0, "Select a dataset...", width);
        htmls.push('</div>');
    }

    function buildMetaFieldCombo(htmls, idOuter, id, left, selectedField, optStr) {
        /* build htmls to select a meta data field from */
        var metaFieldInfo = db.getMetaFields();
        htmls.push('<div id="'+idOuter+'" style="padding-left:2px; display:inline">');
        //var entries = [["_none", ""]];
        var entries = [];
        var selIdx = 0;

        // special handling for the 'Label by Annotation' dropdown
        var doLabels = (optStr==="doLabels");
        if (doLabels)
            entries.push( ["tpMetaVal_none", "No label"] );

        for (var i = 1; i < metaFieldInfo.length; i++) { // starts at 1, skip ID field
            var field = metaFieldInfo[i];
            var fieldName = field.label;
            var isNumeric = (field.type==="int" || field.type==="float");
            var hasTooManyVals = (field.diffValCount>MAXCOLORCOUNT);
            if ((optStr==="noNums" && isNumeric) || 
                (optStr=='doLabels' && (isNumeric || hasTooManyVals))) {
                    continue;
            }

            entries.push( ["tpMetaVal_"+i, fieldName] );
            if (selectedField == fieldName) {
                selIdx = i-1; // -1 because the first element was skipped
            }
        }

        buildComboBox(htmls, id, entries, selIdx, "select a field...", metaBarWidth+50);
        htmls.push('</div>');
    }

    function getGeneLabel() {
        /* some datasets have data not on genes, but on other things e.g. "lipids". The config can
         * define a label for the rows in the expression matrix */
        var geneLabel = "Gene";
        if (db.conf.atacSearch)
            geneLabel = "Range";
        if (db.conf.geneLabel)
            geneLabel = db.conf.geneLabel;
        return geneLabel;
    }

    function splitButtonLabel(state) {
        let dataType = "gene";
        if (db.isAtacMode())
            dataType = "peak";
        if (state)
            return "Split on this "+dataType;
        else
            return "Remove split screen";
    }

    function buildGeneCombo(htmls, id, left, width) {
        /* Combobox that allows searching for genes */
        htmls.push('<div class="tpLeftSideItem" style="padding-left: 3px">');
        var title = "Color by "+getGeneLabel();
        if (db.conf.atacSearch)
            title = "Find peaks at or close to:"
        htmls.push('<label style="display:block; margin-bottom:8px; padding-top: 8px;" for="'+id+'">'+title+'</label>');
        var geneLabel = getGeneLabel().toLowerCase();
        var boxLabel = 'search for '+geneLabel+'...';
        if (db.conf.atacSearch)
            boxLabel = "enter gene or chrom:start-end";
        htmls.push('<select style="width:'+width+'px" id="'+id+'" placeholder="'+boxLabel+'" class="tpCombo">');
        htmls.push('</select>');

        htmls.push('<div><button style="margin-top:4px" id="tpSplitOnGene">'+splitButtonLabel(true)+'</button>');
        htmls.push('<button style="margin-left: 4px" id="tpMultiGene">Multi Gene</button></div>');
        htmls.push('<div><button style="margin-top:4px" id="tpResetColors">Reset to default coloring</button></div>');
        htmls.push('</div>');
    }


    function activateCombobox(id, widthPx) {
        $('#'+id).chosen({
            inherit_select_classes : true,
            disable_search_threshold: 10,
            width : widthPx
        });
    }

    function updateCollectionCombo(id, collData) {
        /* load dataset sibling labels into collection combobox from json */
        var htmls = [];
        var datasets = collData.datasets;
        for (var i = 0; i < datasets.length; i++) {
            var ds = datasets[i];
            var selStr =  "";
            if (ds.name===db.conf.name)
                selStr = "selected";
            var val = ds["name"]+"?"+ds["md5"];
            htmls.push('<option value="'+val+'"'+selStr+'>'+ds.shortLabel+'</option>');
        }
        $('#'+id).html(htmls.join(""));
        $("#"+id).trigger("chosen:updated");
    }

    /* ----- PEAK LIST START ----- */

    function buildPeakList(htmls) {
        /* add a container for the list of peaks to htmls */
        htmls.push("<div id='tpPeakListTitle'>Peaks found</div>");

        htmls.push("<div id='tpPeakList' style='height: 30%'>");
            htmls.push("<span id='noPeaks'>No genes or ranges found</span>");
        htmls.push("</div>");

        htmls.push("<div id='tpPeakListSelector'>");
        //htmls.push("<input id='tpPeakListAuto' style='margin-right: 3px' type='checkbox' checked>");
        htmls.push("<div id='tpPeakListButtonControls' style='margin-left: 4px'>");
        htmls.push('<button title="Select all peaks in the list above" id="tpPeakListAll">All</button>');
        htmls.push('<button title="Select no peaks in the list above" id="tpPeakListNone">None</button>');
        htmls.push('<button title="Select only peaks within a certain distance upstream from the TSS. Click on the field to edit the distance. Click the button to select the peaks." id="tpPeakListUpstream">');
        htmls.push('<input id="tpPeakListAutoDist" type="text" value="2" style="width:2em;border: 0;height: 0.8em;">');
        htmls.push('kbp upstream</button>');
        htmls.push("<div id='tpPeakListButtons'>");

        //htmls.push("<label for='tpPeakListAuto' style='display:inline; font-weight:normal'>Peaks ");
            //htmls.push("<input id='tpPeakListAutoDist' style='width:2em; height:1.3em; margin-right: 0.3em' type='text' value='2'>");
            //htmls.push("kbp upstream</input>");
            //htmls.push("<button id='tpPeakListUpstream' style='float:right; margin-top: 2px'>Select</button>");
        //htmls.push("</label>");
        htmls.push("</div>"); // tpPeakListButtons
        htmls.push("</div>"); // tpPeakListBottons
        htmls.push("</div>"); // tpPeakListSelector
    }

    function peakListShowTitle(sym, chrom, start, end) {
        /* update the peak list box title */
        var el = getById("tpPeakListTitle");
        if (sym)
            el.innerHTML = "<b>"+sym+"</b>, TSS at <span id='tpTss'>"+chrom+":"+start+"</span>";
        else
            el.innerHTML = "Peaks at <b>"+chrom+":"+prettySeqDist(start)+"-"+prettySeqDist(end)+"</b>";
    }

    function peakListSetStatus(str) {
        /* given a string like "chr1|1000|2000+chr2|3000|4000" set the corresponding checkboxes */
        if (!db.conf.atacSearch)
            return;
        let activePeaks = str.split("+");
        let inEls = document.querySelectorAll(".tpPeak > input");
        for (let el of inEls) {
            let parts = el.id.split(":");
            let peakId = parts[1]+"|"+parts[2]+"|"+parts[3];
            el.checked = (activePeaks.includes(peakId));
        }
    }

    function peakListGetPeaksWith(status) {
        /* return array of objects , e.g. [ {chrom:"chr1", start:1000, end:2000, dist:-70000, el:<domObject>} ]
         * status can be "on" or "off" = will only return ranges that are checked or unchecked.
         * */
        let ranges = [];
        let inEls = document.querySelectorAll(".tpPeak > input");
        for (let el of inEls) {
            if (status==="on" && !el.checked)
                continue;
            else if (status==="off" && el.checked)
                continue;
            let parts = el.id.split(":");
            ranges.push({
                "chrom" : parts[1],
                start : parseInt(parts[2]),
                end : parseInt(parts[3]),
                dist : parseInt(parts[4]),
                el : el,
                locusName : parts[1]+"|"+parts[2]+"|"+parts[3]
            });
        }
        return ranges;
    }

    function peakListSerialize() {
        /* return a summary of all currently selected peaks, e.g. "chr1|1000|2000+chr2|3000|4000" */
        let ranges = [];
        for (let r of peakListGetPeaksWith("on")) {
            let locusId = r.chrom+"|"+r.start+"|"+r.end;
            ranges.push(locusId);
        }
        return ranges.join("+");
    }

    function onPeakChange(ev) {
        /* user checks or unchecks a peak */
        //let el = ev.currentTarget.firstChild; // user may have clicked the label
        //var isChecked = el.checked;
        //var peakInfos = el.id.split(":");
        //let chrom = peakInfos[1];
        //let start = peakInfos[2];
        //let end = peakInfos[3];
        //let prefix = "+";
        //if (!isChecked)
            //prefix = "-";
        //let rangeStr = prefix+chrom+"|"+start+"|"+end;
        let rangeStr = peakListSerialize();
        if (rangeStr==="")
            colorByNothing();
        else
            colorByLocus(rangeStr);
    }

    function peakListShowRanges(chrom, foundRanges, searchStart) {
        /* load a list of ranges (arrays of [start, end] into the peak list box */
        var htmls = [];
        var i = 0;
        if (foundRanges.length === 0) {
            htmls.push("No peaks around this gene");
        }
        else
            for (let rangeInfo of foundRanges) {
                let foundStart = rangeInfo[0];
                let foundEnd = rangeInfo[1];
                //let label = chrom+":"+foundStart+"-"+foundEnd;
                let dist = foundStart-searchStart;
                let label = prettySeqDist(dist, true);
                let regLen = foundEnd-foundStart;
                if (regLen!==0)
                    label += ", "+(foundEnd-foundStart)+" bp long";
                let checkBoxId = "range:"+chrom+":"+foundStart+":"+foundEnd+":"+dist;
                htmls.push("<div class='tpPeak'>");
                htmls.push("<input style='margin-right: 4px' id='"+checkBoxId+"' type='checkbox'>");
                htmls.push("<label for='"+checkBoxId+"'>"+label+"</label>");
                htmls.push("</div>");
                i++;
            }
        var divEl = document.getElementById("tpPeakList");
        divEl.innerHTML = htmls.join(""); // set the DIV
        classAddListener("tpPeak", "input", onPeakChange);
    }

    function onPeakAll(ev) {
        /* select all peaks */
        let peaks = peakListGetPeaksWith("off");
        let peakNames = [];
        if (peaks.length>100) {
            alert("More than 100 peaks to select. This will take too long. Please contact us if you need this feature.");
            return;
        }
        for (let p of peaks) {
            peakNames.push(p.locusName);
            p.el.checked = true;
        }
        if (peakNames.length===0)
            return;

        let locusStr = "+"+peakNames.join("+");
        colorByLocus(locusStr);
    }

    function onPeakNone(ev) {
        /* unselect all peaks */
        let peaks = peakListGetPeaksWith("on");
        let peakNames = [];
        for (let p of peaks) {
            peakNames.push(p.locusName);
            p.el.checked = false;
        }

        colorByNothing();
        changeUrl({"locus":null, "meta":null});
        renderer.drawDots();
    }

    function onPeakUpstream(ev) {
        /* select all peaks that are closer than the distance in #tpPeakListAutoDist */
        if (ev.target.id==="tpPeakListAutoDist")
            // user actually clicked the input box = do nothing
            return;
        let maxDistStr = document.getElementById("tpPeakListAutoDist").value;
        let maxDist = parseInt(maxDistStr);
        if (isNaN(maxDist)) {
            alert(maxDistStr+" is not a number");
            return;
        }
        if (maxDist > 2000) {
            alert("The distance filter is too high: "+maxDistStr+". It cannot be larger than 2000, = 2Mbp. If you think this is too restrictive, please contact us.");
            return;
        }
        maxDist = -1*maxDist*1000; // needs to be negative

        let addPeaks = [];
        let peaks = peakListGetPeaksWith("off");
        for (let p of peaks) {
            let dist = p.dist;
            if (dist < 0 && dist > maxDist) {
                addPeaks.push(p.chrom+"|"+p.start+"|"+p.end);
                p.el.checked = true;
            }
        }

        if (addPeaks.length===0) {
            alert("Either there is no active gene TSS or there are no peaks at "+maxDist+" bp relative to the TSS");
            return;
        }

        let loadStr = addPeaks.join("+")

        colorByLocus(loadStr);
        ev.stopPropagation();
    }

    /* ----- PEAK LIST END ----- */

    function selectizeSendGenes(arr, callback) {
        /* given an array of strings s, return an array of objects with id=s and call callback with it.*/
        let foundArr = [];
        for (let o of arr) {
            var text = o.sym;
            if (o.sym!==o.id)
                text = o.sym + " (" + o.id+")";
            foundArr.push( {"id": o.id, "text": text} );
        }
        callback(foundArr);
    }

    function comboLoadGene(query, callback) {
        /* The load() function for selectize for genes.
         * called when the user types something into the gene box, returns matching gene symbols */
        if (!query.length)
            return callback();
        this.clearOptions();
        var genes = db.findGenes(query);
        selectizeSendGenes(genes, callback);
    }

    function updatePeakListWithGene(geneId) {
        /* update the peak list box with all peaks close to a gene's TSS */
        var peaksInView = db.findRangesByGene(geneId);
        var gene = db.getGeneInfoAtac(geneId);
        peakListShowTitle(gene.sym, gene.chrom, gene.chromStart);
        peakListShowRanges(gene.chrom, peaksInView.ranges, gene.chromStart);
        changeUrl({"locusGene":geneId});
    }

    function comboLoadAtac(query, callback) {
        /* The load() function for selectize for ATAC datasets.
         * called when the user types something into the gene box, calls callback with matching gene symbols or peaks
         * or shows the peaks in the peakList box */
        if (!query.length)
            return callback();

        this.clearOptions();
        this.renderCache = {};

        var range = cbUtil.parseRange(query);
        if (range===null) {
            if (!db.geneToTss || db.geneToTss===undefined)
                db.indexGenesAtac();

            var geneInfos = db.findGenesAtac(query);

            if (geneInfos.length === 0)
                return;

            if (geneInfos.length > 1)
                selectizeSendGenes(geneInfos, callback);
            else {
                var geneId = geneInfos[0].id;
                updatePeakListWithGene(geneId);
            }
        } else {
            // user entered a range e.g. chr1:0-190k or chr1:1m-2m
            let searchStart = range.start;
            let searchEnd = range.end;
            peakListShowTitle(null, range.chrom, range.start, range.end);
            let foundRanges = db.findOffsetsWithinPos(range.chrom, searchStart, searchEnd);
            peakListShowRanges(range.chrom, foundRanges, searchStart);
        }
    }

    function comboRender(item, escape) {
        if (item.dist)
            return '<div style="display:block">'+escape(item.text)+'<div style="text-color: darkgrey; font-size:80%;float:right">+'+prettyNumber(item.dist, "bp")+'</div>';
        else
            return '<div>'+escape(item.text)+'</div>';
    }

    function arrayBufferToString(buf, callback) {
        /* https://stackoverflow.com/questions/8936984/uint8array-to-string-in-javascript */
         var bb = new Blob([new Uint8Array(buf)]);
         var f = new FileReader();
         f.onload = function(e) {
           callback(e.target.result);
         };
         f.readAsText(bb);
    }


    function makeXenaUrl(metaFieldName, geneSyms, geneSym, actMeta) {
        /* return URL to Xena view with this dataset and geneSyms loaded */
        var xenaId = db.conf.xenaId;
        var phenoId = db.conf.xenaPhenoId;
        var browser = 'https://singlecell.xenabrowser.net/';
        var view = [{
                name: phenoId,
                host: 'https://singlecellnew.xenahubs.net',
                fields: metaFieldName,
                columnLabel : 'Cell Annotations',
                fieldLabel: metaFieldName
            }];

        if (geneSyms.length!==0)
            view.push({
                name: xenaId,
                host: 'https://singlecellnew.xenahubs.net',
                fields: geneSyms.join(" "),
                width : 15*geneSyms.length,
                columnLabel : 'Dataset genes',
                fieldLabel: geneSyms.join(" ")
            });

        if (actMeta)
            view.push({
                name: phenoId,
                host: 'https://singlecellnew.xenahubs.net',
                fields: actMeta,
                width : 120,
                columnLabel : 'Current Meta',
                fieldLabel: actMeta
            });

        if (geneSym)
            view.push({
                name: xenaId,
                host: 'https://singlecellnew.xenahubs.net',
                fields: geneSym,
                width : 120,
                columnLabel : 'Current Gene',
                fieldLabel: geneSym
            });

        var heatmap = { "showWelcome" : false };

        var url = browser + 'heatmap/?columns=' +
            encodeURIComponent(JSON.stringify(view)) +
            '&heatmap=' + encodeURIComponent(JSON.stringify(heatmap));
        return url;
    }

    function makeHubUrl(geneSym) {
        /* return URL of the hub.txt file, possibly jumping to a given gene  */
            var hubUrl = db.conf.hubUrl;

            if (hubUrl===undefined)
                return null;

            // we accept full session links in the hubUrl statement and just pass these through
            if (hubUrl && hubUrl.indexOf("genome.ucsc.edu/s/")!==-1)
                return hubUrl;

            var ucscDb = db.conf.ucscDb;
            if (ucscDb===undefined) {
                alert("Internal error: ucscDb is not defined in cellbrowser.conf. Example values: hg19, hg38, mm10, etc. You have to set this variable to make track hubs work.");
                return "";
            }

            var fullUrl = null;
            if (hubUrl.indexOf("/")===-1) {
                // no slash -> it's not a URL at all but just a track name (e.g. "tabulamuris")
                var trackName = hubUrl;
                fullUrl = "https://genome.ucsc.edu/cgi-bin/hgTracks?"+trackName+"=full&genome="+ucscDb;
            } else {
                // it's a url to a hub.txt file: either relative or absolute
                if (!hubUrl.startsWith("http")) {
                    // relative URL to a hub.txt file -> make absolute now
                    //hubUrl = getBaseUrl()+db.name+"/"+hubUrl
                    hubUrl = cbUtil.absPath("", cbUtil.joinPaths([getBaseUrl(), db.name, hubUrl]));
                }
                // URL is an absolute link to a hub.txt URL
                fullUrl = "https://genome.ucsc.edu/cgi-bin/hgTracks?hubUrl="+hubUrl+"&genome="+ucscDb;
            }

            if (geneSym && !geneSym.startsWith("atac-"))
                fullUrl += "&position="+geneSym+"&singleSearch=knownCanonical";

            return fullUrl;
    }

    function onGenomeButtonClick(ev) {
        /* run when the user clicks the 'genome browser' button */
        let actSym = null;
        if (gLegend.type==="expr")
            actSym = gLegend.geneSym;
        var fullUrl = makeHubUrl(actSym);
        db.gbWin = window.open(fullUrl, 'gbTab');
        return false;
    }

    function onXenaButtonClick(ev) {
        /* run when the user clicks the xena button */
        var geneInfos = db.conf.quickGenes;
        var syms  = []
        if (geneInfos!=undefined) {
            for (var i = 0; i < geneInfos.length; i++)
                syms.push( geneInfos[i][0] ); // make array of symbols
        }

        var actSym = null;
        var actMeta = null;
        if (gLegend.type==="expr")
            actSym = gLegend.geneSym;
        else
            actMeta = gLegend.metaInfo.label;

        if (syms.length===0 && actSym===null) {
            alert("Sorry, the view is not colored by a gene and there are no 'Dataset genes' "+
                   " defined, so there are no genes active "+
                "that could be shown on the heatmap. Please color by a gene first, "+
                "then click the button again.");
            return;
        }

        var fullUrl = makeXenaUrl(db.conf.labelField, syms, actSym, actMeta);
        //if (!db.xenaWin)
        db.xenaWin = window.open(fullUrl, 'xenaTab');
        //else
            //db.xenaWin.location.href = fullUrl;
        return false;
    }

    function openCurrentDataset() {
        /* open dataset dialog with current dataset highlighted */
        $(this).blur();  // remove focus = tooltip disappears
        var parentNames = db.name.split("/");
        parentNames.pop();
        var newPath = cbUtil.joinPaths([parentNames.join("/"), "dataset.json"]);
        cbUtil.loadJson(newPath, function(parentConf) {
            openDatasetDialog(parentConf, db.name);
        });
    }

    function activateGeneCombo(id, onGeneComboChange) {
    /* initialize the gene search combo box with selectize */
        // selectize: gene or ATAC Color by search box
        var comboLoad = comboLoadGene;
        if (db.conf.atacSearch) {
            comboLoad = comboLoadAtac;
            getById("tpPeakListUpstream").addEventListener("click", onPeakUpstream);
            getById("tpPeakListAll").addEventListener("click", onPeakAll);
            getById("tpPeakListNone").addEventListener("click", onPeakNone);
            activateTooltip("#tpPeakListButtons > button");

        }

        var select = $("#"+id).selectize({
                maxItems: 1,
                valueField : 'id',
                labelField : 'text',
                searchField : 'text',
                closeAfterSelect: true,
                load : comboLoad,
                render : {option : comboRender }
        });

        select.on("change", onGeneComboChange);
    }

    function onGeneExprMetaComboChange(ev, choice) {
        /* gene expression viewer: called when user changes the meta field combo box */
        var fieldId = parseInt(choice.selected.split("_")[1]);
        var metaName = db.getMetaFields()[fieldId].name;
        debug("changed meta on gene expr view", ev);
        buildGeneExprPlotsAddGenes([], metaName);
    }

    function onGeneExprGeneComboChange(ev) {
        /* on the expr violin viewer: user selected a gene */
        var geneId = ev.target.value;
        if (geneId==="") // "" = user deleted the gene.
            return;
        buildGeneExprPlotsAddGenes([geneId], null);
    }

    function promiseGene(locusStr, onProgress, metaArr, metaCount) {
        /* A promise for loading the gene data and calculation average expression per meta data value.
           Resolves with a geneData object with gene-related attributes, exprMin, exprMax and dotRows.  */
        /* dotRows is an array of [cellCount, zeroPerc, avg] */
        return new Promise(function(resolve, reject) {

            function gotGeneData(exprArr, decArr, locusStr, geneDesc, binInfo) {
                /* called when the expression vector has been loaded and binning is done */
                debug("Promise - Received expression vector, for "+locusStr+", desc: "+geneDesc);
                let res = splitExprByMeta(metaArr, metaCount, exprArr);

                let metaToExpr = res[0];
                let exprMin = res[1];
                let exprMax = res[2];
                let dotData = calcDotData(metaToExpr, false);

                let geneData = {};
                geneData.dotRows = dotData.rows;
                geneData.exprMin = exprMin;
                geneData.exprMax = exprMax;
                geneData.avgMin = dotData.avgMin;
                geneData.avgMax = dotData.avgMax;
                geneData.geneId = locusStr;
                geneData.geneDesc = geneDesc;
                resolve(geneData);
            }

            db.loadExprAndDiscretize(locusStr, gotGeneData, onProgress, "none");
        });
    }

    function promiseMeta(metaName, onProgress) {
        /* a promise for loading the meta data. Resolves with a metaInfo object that has an .arr attribute. */
        return new Promise(function(resolve, reject) {
            var metaInfo = db.findMetaInfo(metaName);
            // don't do anything if the data has already been loaded
            if (metaInfo.arr !== undefined) {
                debug("Promise: meta data already loaded")
                resolve(metaInfo);
                return;
            }

            function gotMetaArray(metaArr, metaInfo) {
                debug("Promise: meta data finished loading")
                metaInfo.arr = metaArr;
                resolve(metaInfo);
            }

            db.loadMetaVec(metaInfo, gotMetaArray, onProgress, {}, db.conf.binStrategy);
        });
    }

    function calcMedianQuart(arr) {
        /* given array, return obj with .quart1, .median, .quart3. For a barchart */
        arr = arr.sort(function(a, b){ return a-b; }); // why is the function necessary? does sort() not sort numerically?
        let arrLen = arr.length;
        let quartSize = 1/6; // quartile = partition number space into 6 equal parts

        let ret = {};
        ret.median = arr[Math.round(arrLen*0.5)];

        ret.quart1 = arr[Math.round(arrLen*1*quartSize)];
        ret.quart2 = arr[Math.round(arrLen*2*quartSize)];
        ret.quart3 = arr[Math.round(arrLen*3*quartSize)];
        ret.quart4 = arr[Math.round(arrLen*4*quartSize)];
        ret.count = arr.length;
        console.log(ret);
        return ret;
    }

    function plotBarchartAxis(htmls, labelWidth, chartWidth, minY, minExpr, maxExpr) {
        /* add barchart axis to htmls as svg elements */
        let x1 = labelWidth;
        let x2 = chartWidth;
        let y1 = minY;
        let y2 = minY;
        htmls.push("<line x1='"+x1+"' y1='"+y1+"' x2='"+x2+"' y2='"+y2+"' stroke='black' stroke-width='2'/>");

        // left start tick
        y1 = minY-5;
        y2 = minY+5;
        x1 = x2 = labelWidth;
        htmls.push("<line x1='"+x1+"' y1='"+y1+"' x2='"+x2+"' y2='"+y2+"' stroke='black' stroke-width='1'/>");

        // right end tick
        x1 = x2 = chartWidth;
        htmls.push("<line x1='"+x1+"' y1='"+y1+"' x2='"+x2+"' y2='"+y2+"' stroke='black' stroke-width='1'/>");

        // min label
        let x = labelWidth;
        let y = minY - 8;
        let label = minExpr;
        htmls.push("<text font-family='sans-serif' font-size='12' fill='black' text-anchor='middle' x='"+x+"' y='"+y+"'>"+label+"</text>");
        // max label
        x = chartWidth;
        label = maxExpr;
        htmls.push("<text font-family='sans-serif' font-size='12' fill='black' text-anchor='middle' x='"+x+"' y='"+y+"'>"+label+"</text>");
    }

    function plotOneBarchartSvg(htmls, labelWidth, minY, minX, maxX, scaleFact, rowIdx, label, dataSumm) {
        /* add SVG elements for one barchart to htmls */
        let barchartHeight = 40;
        let x = 20;
        let y = minY+(rowIdx*barchartHeight);
        htmls.push("<text font-family='sans-serif' font-size='14' fill='black' text-anchor='left' x='"+x+"' y='"+y+"'>"+label+"</text>");

        // draw a rectangle from second to third quartile
        y -= 15;
        let barWidth = Math.round(scaleFact*(dataSumm.quart3-dataSumm.quart2));
        let barStart = labelWidth+Math.round(scaleFact*(dataSumm.quart2));
        let barHeight = 15;
        x = barStart;
        let fillHex = "DDDDDD";
        htmls.push("<rect width='"+barWidth+"' height='"+barHeight+"' fill='#"+fillHex+"' x='"+x+"' y='"+y+"'></rect>");

        // a line from first to fourth quartile
        y = minY+(rowIdx*barchartHeight)-0.5*barHeight;
        let y1 = y;
        let y2 = y;
        let x1 = labelWidth+Math.round(scaleFact*(dataSumm.quart1));
        let x2 = labelWidth+Math.round(scaleFact*(dataSumm.quart4));
        htmls.push("<line x1='"+x1+"' y1='"+y1+"' x2='"+x2+"' y2='"+y2+"' stroke='black' stroke-width='2'/>");

        console.log("<rect width='"+barWidth+"' height='"+barHeight+"' fill='#"+fillHex+"' x='"+x+"' y='"+y+"'></rect>");
    }

    function buildExprBarcharts(parentDomId, metaToExpr, metaLabels, exprMin, exprMax) {
        /* plot barcharts on the expression viewer */
        let htmls = [];
        let parentEl = getById(parentDomId);

        let metaCount = metaToExpr.length;
        let chartHeight = metaCount*40;
        let chartWidth = parentEl.getBoundingClientRect().width;
        htmls.push("<svg xmlns='http://www.w3.org/2000/svg' height='"+chartHeight+"' width='"+chartWidth+"'>");

        let minY = 20;
        let labelWidth = 150;
        plotBarchartAxis(htmls, labelWidth, chartWidth, minY, exprMin, exprMax);

        let minX = 0;
        let maxX = chartWidth;
        let scaleFact = (maxX-minX)/(exprMax-exprMin);

        minY+=30;

        for (let i=0; i < metaToExpr.length; i++) {
            console.log(metaLabels[i]);
            let exprArr = metaToExpr[i];
            let dataSumm = calcMedianQuart(exprArr);
            plotOneBarchartSvg(htmls, labelWidth, minY, minX, maxX, scaleFact, i, metaLabels[i], dataSumm);
        }
        htmls.push("</svg>");
        parentEl.innerHTML = htmls.join("");
    }

    function buildExprViolins(parentDomId, metaToExpr, metaLabels, exprMax) {
        /* plot the violin plots on the expression viewer */
            // first make the canvas DOM objects...
            let htmls = [];
            for (let i=0; i < metaToExpr.length; i++) {
                htmls.push("<div class='tpExprViolin' id='tpExprViolin_"+i+"'>");
                htmls.push("<canvas style='width:200px;height:150px' class='tpExprViolinCanvas' id='tpExprViolinCanvas_"+i+"'></canvas>");
                htmls.push("</div>"); // violin
            }
            getById(parentDomId).innerHTML = htmls.join("");

            // then fill them with violin plots

            let vioData = {};

            for (let i=0; i < metaToExpr.length; i++) {
                var exprArr = metaToExpr[i];

                // if the arrays are very big, just sample to 10k points - violin plots are too slow
                let sampleSize = 10000;
                let exprLen = exprArr.length;
                if (exprLen > sampleSize) {
                    exprArr = arrSample(exprArr, sampleSize);
                }

                let labelLines = [[metaLabels[i], exprLen+" cells"]];
                let dataList = [exprArr];
                let violinData = {
                  labels : labelLines,
                  datasets: [{
                    data : dataList,
                    label: 'Mean',
                    backgroundColor: 'rgba(255,0,0,0.5)',
                    borderColor: 'red',
                    borderWidth: 1,
                    outlierColor: '#999999',
                    padding: 7,
                    itemRadius: 1
                  }]
                };

                vioData[i] = violinData;
            }

            let optDict = {
                maintainAspectRatio: false,
                legend: { display: false },
                title: { display: false }
            };

            // finally build the charts
            window.violinCharts = [];

            window.setTimeout(function() {
                for (let i=0; i < metaToExpr.length; i++) {
                    const ctx = getById("tpExprViolinCanvas_"+i).getContext("2d");
                        console.time("violinDraw_"+i);
                        window.violinCharts.push( new Chart(ctx, {
                            type: 'violin',
                            data: vioData[i],
                            options: optDict,
                            scales : {
                                y : {
                                    max : exprMax
                                }
                            }
                        }));
                        console.timeEnd("violinDraw_"+i);
                }
            }, 5);
    }

    function stringEmptyLabel(s) {
        /* return the string or alternatively a human-readable indicator that it's empty */
        if (s==="")
            return "(empty)"
        else
            return s;
    }

    function svgMaxTextLength(parentEl, fontSize, strings) {
        // return maximum width in SVG pixels of array of strings */
        let htmls = [];
        let chartHeight = 500;
        let chartWidth = 500;
        htmls.push("<svg xmlns='http://www.w3.org/2000/svg' height='"+chartHeight+"' width='"+chartWidth+"'>");
        for (let i=0; i < strings.length; i++) {
            let label = stringEmptyLabel(strings[i]);
            let x = 1;
            let y = 20;
            htmls.push("<text class='tpTestString' font-family='sans-serif' font-size='"+fontSize+"' fill='transparent' x='"+x+"' y='"+y+"'>"+label+"</text>");
        }
        htmls.push("</svg>");

        parentEl.innerHTML = htmls.join("");

        let domEls = document.getElementsByClassName("tpTestString");
        let maxWidth = 0;
        for (let el of domEls) {
            maxWidth = Math.max(maxWidth, el.getBoundingClientRect().width);
        }

        return maxWidth;
    }

    function plotDotRowLabels(htmls, minX, minY, rowDist, labels, cellCounts, fill, fontSize) {
        /* plot the names of the meta values downwards on the left */
        let x = minX;
        for (let i=0; i < labels.length; i++) {
            let label = stringEmptyLabel(labels[i]);
            let y = minY+(i*rowDist)+fontSize;
            let tooltip = cellCounts[i]+" cells";
            htmls.push("<text class='tpExprRowLabel' title='"+tooltip+"' font-family='sans-serif' font-size='"+fontSize+"' fill='"+fill+"' "+
                "alignment-baseline='bottom' text-anchor='start' x='"+x+"' y='"+y+"'>"+label+"</text>");
        }
    }

    function plotDotColumnLabels(htmls, minX, minY, xDist, geneSyms, fill) {
        /* plot the names of the genes rightwards at the top and slanted. Returns the maximum height of them */
        let y = minY-10;
        let fontSize = 14;

        for (let i=0; i < geneSyms.length; i++) {
            let label = geneSyms[i];
            let x = minX+(i*xDist)+(fontSize);
            htmls.push("<text class='tpExprColLabel' data-gene='"+label+"' font-family='sans-serif' font-weight='bold' font-size='"+
                    fontSize+"' fill='"+fill+"' transform='translate("+x+", "+y+
                    ") rotate(45)' alignment-baseline='bottom' text-anchor='end'>ⓧ&nbsp;"+label+"</text>");
        }
    }

    function plotDotColumnLabelsAutoSize(parentEl, htmls, minX, minY, xDist, geneSyms) {
        /* plot the the names of the genes at the top. return height */
        // we need to know the height of the gene name boxes, so plot these in white and measure their height
        let htmls2 = [];
        let chartHeight = 500;
        let chartWidth = 500;
        htmls2.push("<svg xmlns='http://www.w3.org/2000/svg' height='"+chartHeight+"' width='"+chartWidth+"'>");
        plotDotColumnLabels(htmls2, minX, 300, xDist, geneSyms, "white");
        htmls2.push("</svg>");

        parentEl.innerHTML = htmls2.join("");

        let domEls = document.getElementsByClassName("tpExprColLabel");
        let maxHeight = 0;
        for (let el of domEls) {
            maxHeight = Math.max(maxHeight, el.getBoundingClientRect().height);
        }
        maxHeight += 10;

        parentEl.innerHTML = "";

        // now that we know the height, plot them again
        plotDotColumnLabels(htmls, minX, minY+maxHeight, xDist, geneSyms, "black");
        return maxHeight;
    }

    function plotDotCircles(htmls, syms, rowLabels, dotRows, leftPad, topPad, colDist, rowDist, maxDotSize, colors, cellCounts, avgMin, avgMax) {
        /* plot the circles of the dot plot */
        let rows = dotRows;

        let radius = maxDotSize/0.5;

        let binCount = colors.length;
        let binSize = (avgMax-avgMin)/binCount;

        for (let rowI=0; rowI < rows.length; rowI++) {
            let row = rows[rowI];
            let label = rowLabels[rowI]

            for (let colI=0; colI < row.length; colI++) {
                let sym = syms[colI];

                let cellCount = cellCounts[rowI];
                let colData = row[colI];
                let nonZeroCount = colData[0];
                let avgExpr = colData[1];

                let y = topPad+(rowI*rowDist);
                let x = leftPad+(colI*colDist)+(0.5*colDist);

                let nonZeroPercent = 0;
                if (cellCount!==0)
                    nonZeroPercent = nonZeroCount / cellCount;
                let radius = Math.max(1, Math.round(nonZeroPercent*(maxDotSize*0.5)));

                let alpha = 0.7;

                let colBin = Math.min(binCount, Math.round((avgExpr-avgMin) / binSize)); // at the edge, floating point problems can make it sometimes 21
                let color = colors[colBin];

                let cellCountStr = cellCount.toLocaleString('en-US');
                let tooltip = label+": "+cellCountStr+" cells. For "+sym+", "+nonZeroCount+" cells are non-zero ("+Math.round(100*nonZeroPercent)+"%), avgExpr="+avgExpr.toFixed(2);
                htmls.push("<circle class='tpDotCircle' title='"+tooltip+"' cx='"+x+"' cy='"+y+"' r='"+radius+"' fill-opacity='"+alpha+"' fill='#"+color+"' />");
            }
        }
    }

    function plotLegend(htmls, avgMin, avgMax, legendX, legendY, colorPal, legendWidth, legendHeight, maxDotSize) {
        /* plot the legend at x, y*/
        htmls.push('<rect style="fill:transparent;stroke-width:0.3;stroke:black" x="'+legendX+'" y="'+legendY+'" width="'+(legendWidth)+'" height="'+legendHeight+'"/>');

        let titleX = legendX + 5;
        let titleY = legendY + 20;
        htmls.push("<text font-family='sans-serif' font-size='16' fill='black' text-anchor='start' x='"+titleX+"' y='"+titleY+"'>Average Expression (sum/cell#)</text>");

        titleY += 100;
        htmls.push("<text font-family='sans-serif' font-size='16' fill='black' text-anchor='start' x='"+titleX+"' y='"+titleY+"'>Expressed in Cells (non-zeroes)</text>");

        titleY += 85;
        htmls.push("<text font-family='sans-serif' font-size='14' fill='black' text-anchor='start' x='"+(titleX)+"' y='"+titleY+"'>Exact values on mouse-over</text>");

        // draw five circles and 0% and 100% percent values underneath
        let circlesY = legendY+150;
        let lastCircleX = 0;
        for (let i=0; i < 5; i++) {
            let x = legendX+20+(i*30);
            let radius = Math.round(Math.max(1, (maxDotSize*0.5)*(i*0.2)));
            htmls.push("<circle fill-opacity='0.8' cx='"+x+"' cy='"+circlesY+"' r='"+radius+"' fill='black' />");
            lastCircleX = x;
        }

        let zeroX = legendX+10;
        let circleLabelY = legendY+150+30;
        htmls.push("<text font-family='sans-serif' font-size='14' fill='black' text-anchor='start' x='"+zeroX+"' y='"+circleLabelY+"'>0%</text>");
        htmls.push("<text font-family='sans-serif' font-size='14' fill='black' text-anchor='start' x='"+(lastCircleX-15)+"' y='"+circleLabelY+"'>100%</text>");

        let rectY = legendY+25;
        let rectX = legendX+10;
        let colCount = colorPal.length;
        let rectIncX = (legendWidth-20)/colCount;
        let lastRectX = 0;
        for (let i=0; i < colorPal.length; i++) {
            let colHex = colorPal[i];
            htmls.push('<rect style="fill:#'+colHex+';stroke-width:0;stroke:transparent" x="'+rectX+'" y="'+rectY+'" width="'+rectIncX+'" height="'+30+'"/>');
            rectX += rectIncX;
            lastRectX = rectX;
        }

        let minLabel = avgMin.toFixed(2);
        let maxLabel = avgMax.toFixed(2);

        let exprMinX = legendX+10;
        let avgLabelY = rectY+50;
        htmls.push("<text font-family='sans-serif' font-size='14' fill='black' text-anchor='start' x='"+exprMinX+"' y='"+avgLabelY+"'>"+minLabel+"</text>");
        htmls.push("<text font-family='sans-serif' font-size='14' fill='black' text-anchor='end' x='"+(lastRectX)+"' y='"+avgLabelY+"'>"+maxLabel+"</text>");

    }

    let exprData = null;

    function exprDataRemoveGene(sym) {
        /* remove a gene from the expr data */
        let geneIdx = exprData.syms.indexOf(sym);
        exprData.syms.splice(geneIdx, 1); // remove the symbol
        exprData.geneIds.splice(geneIdx, 1); // and the geneId

        // remove the gene data
        let rowCount = exprData.rows.length;
        for (let rowIdx=0; rowIdx < rowCount; rowIdx+=1) {
            let row = exprData.rows[rowIdx];
            row.splice(geneIdx, 1);
        }
        
        exprDataUpdateMinMax(exprData);
    }

    function onDotCircleHover(ev, minY, maxY, minX, maxX) {
        /* user hovers over the dotplot circle */
        console.log(ev);
        let target = ev.currentTarget;
        let cx = parseInt(target.getAttribute("cx"));
        let cy = parseInt(target.getAttribute("cy"));

        let xLine = document.getElementById("tpExprDotPlotXLine");
        xLine.setAttribute("x1", minX);
        xLine.setAttribute("y1", cy);
        xLine.setAttribute("x2", maxX);
        xLine.setAttribute("y2", cy);
        xLine.setAttribute("stroke", "#AAAAAA");

        let yLine = document.getElementById("tpExprDotPlotYLine");
        yLine.setAttribute("x1", cx);
        yLine.setAttribute("y1", minY);
        yLine.setAttribute("x2", cx);
        yLine.setAttribute("y2", maxY)
        yLine.setAttribute("stroke", "#AAAAAA");

        //let lineEl = document.createElement('line'); 
        //<line x1="0" y1="80" x2="100" y2="20" stroke="black" />
        //lineEl.setAttribute("x1", cx);
        //lineEl.setAttribute("y1", 0);
        //lineEl.setAttribute("x2", cx);
        //lineEl.setAttribute("y2", 100);
        //lineEl.setAttribute("stroke", "black");
        //lineEl.setAttribute("stroke-width", "1");

        //let svgEl = getById("tpExprDotPlot");
        //svgEl.appendChild(lineEl);
    }

    function buildExprDotplot(parentDomId, exprData) {
        /* create an svg under parentDomId that shows dot plots for each meta category */
        let syms = exprData.syms;
        let cellCounts = exprData.cellCounts;
        let dotRows = exprData.rows;
        let metaLabels = exprData.metaLabels;
        let avgMin = exprData.allAvgMin;
        let avgMax = exprData.allAvgMax;

        let htmls = [];
        let parentEl = getById(parentDomId);

        let rowLabels = metaLabels;
        // let rowLabels = cloneArray(metaLabels);  // we'll sort this in place, so make a copy first
        //rowLabels.sort(function(a, b) { return naturalSort(a, b); });
        let rowCount = rowLabels.length;

        let colCount = syms.length;
        
        //                              topPad 
        //
        //                              col label
        //                              height
        //
        //  leftPad  <row label width> +<-colWidth--->+                     |  legendWidth     |
        //                             +              |                     |  & legendHeight  |
        //                             +  rowHeight ->|
        //                             +              |
        //
        let topPad = 6;
        let leftPad = 6;

        let maxDotSize = 30;
        let rowHeight = maxDotSize+4;
        let colWidth = maxDotSize+4;
        let legendWidth = 240;
        let legendHeight = 220;

        let cellCountColWidth = 50;

        let fontSize = 14;
        let rowLabelWidth = 10+svgMaxTextLength(parentEl, fontSize, rowLabels);

        rowLabelWidth = Math.max(50, rowLabelWidth); // need some minimum width since the column labels are slanted to the left

        let colLabelHeight = plotDotColumnLabelsAutoSize(parentEl, htmls, leftPad+rowLabelWidth, topPad, colWidth, syms)+10;
        plotDotRowLabels(htmls, leftPad, colLabelHeight, rowHeight, rowLabels, cellCounts, "black", fontSize);

        let colorPal = makeColorPalette(cDefGradPalette, 20);

        plotDotCircles(htmls, syms, rowLabels, dotRows, leftPad+rowLabelWidth, topPad+colLabelHeight, colWidth, rowHeight, maxDotSize, colorPal, cellCounts, avgMin, avgMax);

        let legendMinX = leftPad+rowLabelWidth+(colCount*colWidth)+(0.5*cellCountColWidth);
        plotLegend(htmls, avgMin, avgMax, legendMinX, topPad+colLabelHeight, colorPal, legendWidth, legendHeight, maxDotSize)

        let chartWidth = leftPad+rowLabelWidth+(colWidth*colCount)+legendWidth+cellCountColWidth+1; // +1 because the legend box can be 2 pixels wide
        let chartHeight = topPad+colLabelHeight+Math.max(legendHeight, rowCount*rowHeight);

        htmls.unshift("<svg id='tpExprDotPlot' xmlns='http://www.w3.org/2000/svg' height='"+chartHeight+"' width='"+chartWidth+"'>");

        // used for mouseover later
        htmls.push('<line id="tpExprDotPlotXLine" x1="0" y1="0" x2="0" y2="0" stroke="transparent" stroke-width="1"/>');
        htmls.push('<line id="tpExprDotPlotYLine" x1="0" y1="0" x2="0" y2="0" stroke="transparent" stroke-width="1"/>');
        htmls.push("</svg>");

        parentEl.innerHTML = htmls.join("");

        $(".tpDotCircle").on("mouseover", function(ev) { 
                    onDotCircleHover(ev, topPad+colLabelHeight-8, chartHeight, leftPad+rowLabelWidth, legendMinX-10)
                } );
        $(".tpDotCircle").on("mouseout", function(ev) { 
                    document.getElementById("tpExprDotPlotXLine").setAttribute("stroke", "transparent");
                    document.getElementById("tpExprDotPlotYLine").setAttribute("stroke", "transparent");
                } );

        function onExprColLabelClick(ev) {
            var geneSym = ev.target.getAttribute("data-gene");
            exprDataRemoveGene(geneSym);
            buildExprDotplot("tpExprViewPlot", exprData); 
            selectizeSetValue("tpGeneExprGeneCombo", ""); // clear the dropdown box
        }

        $(".tpExprColLabel").on("click", onExprColLabelClick);
        $(".tpDotCircle").tooltip({show:false}); // switch off animations. For some reason, the Bootstrap tooltip doesn't seem to work on the SVG tag
        $("text").tooltip({show:false}); // switch off animations. For some reason, the Bootstrap tooltip doesn't seem to work on the SVG tag
    }

    //function summarizeGeneExpr(metaToExpr, doLog) {
    //    let exprArr = metaToExpr[metaIdx];
    //    let nonZeroCount = 0;
    //    let sum = 0;
    //    for (let i=0; i < exprArr.length; i++) {
    //        let val = exprArr[i];
    //        if (val!==0)
    //            nonZeroCount++;
    //        if (doLog)
    //            sum += Math.log(val+1);
    //        else
    //            sum += val;
    //    }
    //    let cellCount = exprArr.length;
    //    let avg = 0;
    //    let nonZeroPercent = 0;
    //    if (cellCount!==0) {
    //        avg = sum / cellCount;
    //        nonZeroPercent = nonZeroCount / cellCount;
    //    }
    //    let o = {};
    //    o.avg = avg;
    //    o.nonZeroPerc = nonZeroPercent;
    //    o.cellCount = cellCount;
    //}

    function calcDotData(metaToExpr, doLog) {
        /* summarize gene expression to an array of rows [cellCount, nonZeroPercent, avgExpr], one per row */
        /* input is an array of small exprArrays, one array of expression values per meta value */
        /* returns object with o.dotRows of this array and o.avgMax and o.avgMin */
        let rows = [];
        let avgMax = -1000000;
        let avgMin = 1000000;
        if (metaToExpr.length===0) {
            avgMax = NaN;
            avgMin = Nan;
        }
        for (let metaIdx=0; metaIdx < metaToExpr.length; metaIdx++) {
            let exprArr = metaToExpr[metaIdx];
            let nonZeroCount = 0;
            let sum = 0;
            for (let i=0; i < exprArr.length; i++) {
                let val = exprArr[i];
                if (val!==0)
                    nonZeroCount++;
                if (doLog)
                    sum += Math.log(val+1);
                else
                    sum += val;
            }
            let cellCount = exprArr.length;
            let avg = 0;
            //let nonZeroPercent = 0;
            if (cellCount!==0) {
                avg = sum / cellCount;
                //nonZeroPercent = nonZeroCount / cellCount;
            }

            rows.push( [cellCount, nonZeroCount, avg] );
            avgMax = Math.max(avgMax, avg);
            avgMin = Math.min(avgMin, avg);
        }

        return {"avgMax":avgMax, "avgMin":avgMin, "rows" : rows};
    }

    function geneExprOnProgress(ev) {
        console.log("expression"+ev);
        let domId = null;
        let prefix = "";
        if (ev.target && ev.target._url) {
            let url = ev.target._url;
            if (url.search("/metaFields/")!=-1) {
                prefix = "Annotation data: ";
                domId = "#progressBarMeta";
            }
            else {
                prefix = "Expression data: ";
                domId = "#progressBarExpr";
            }
        }

        var progressDiv = $( domId );
        let perc = Math.round(100*ev.loaded/ev.total);
        let sizeInMb = (ev.total/1000000).toFixed(2);
        let label = prefix+perc+" % (of "+sizeInMb+" MB)";
        progressDiv.progressbar( "value", perc);
        var progressLabel = progressDiv.children().first();
        progressLabel.text( label );
    }

    function exprDataUpdateMinMax(exprData) {
        /* pull out the minimum and maximum of the dotRows and update exprData.allAvgMin and exprData.allAvgMax*/
        let allAvgMax = -1000000;
        let allAvgMin = 1000000;

        if (exprData.geneIds.length===0) {
            allAvgMax = NaN;
            allAvgMin = NaN;
        }


        let rows = exprData.rows;
        for (let row of rows) {
            for (let geneData of row) {
                let avg = geneData[1];
                allAvgMax = Math.max(avg, allAvgMax);
                allAvgMin = Math.min(avg, allAvgMin);
            }
        }

        exprData.allAvgMax = allAvgMax;
        exprData.allAvgMin = allAvgMin;
    }

    function exprDataLoadGenes(geneIds, exprData, onDone) {
        /* add a list of geneIds to the current exprData object */
        let promises = [];
        for (let geneId of geneIds) {
            geneId = geneId.split("|")[0]; // internal genes sometimes can be in format ENSG-ID|geneSymbol
            if (exprData.geneIds.indexOf(geneId)===-1)
                promises.push( promiseGene(geneId, geneExprOnProgress, exprData.metaData.arr, exprData.metaData.valCounts.length ));
            else
                alert("This gene is already on the plot");
        }

        // pull out necesssary data from exprData object
        let cellCounts = exprData.cellCounts;

        let addNewRows = false;
        if (exprData.syms.length===0)
            addNewRows = true;

        let rows = exprData.rows;

        // reformat input gene expression "geneData" to an array of gene symbols, an array of meta values, 
        // an array of cell counts (one per meta value) and
        // an array of [ [zeroPerc0, avg0], [zeroPerc1, avg1], ... ]
        Promise.all(promises).then( function(resArr) {
            let cellCountsDone = false; // we need to copy the cell counts only once, not for every gene again
            for (let geneIdx = 0; geneIdx < resArr.length; geneIdx++) {
                let geneData = resArr[geneIdx];
                exprData.syms.push( geneData.geneDesc );
                exprData.geneIds.push( geneData.geneId );

                let dotRows = geneData.dotRows;

                for (let rowIdx=0; rowIdx < dotRows.length; rowIdx++) {
                    let dotRow = geneData.dotRows[rowIdx];
                    if (addNewRows)
                        rows.push( [] );

                    let cellCount = dotRow[0];
                    let zeroPerc = dotRow[1];
                    let avg = dotRow[2];

                    rows[rowIdx].push( [zeroPerc, avg] ); // copy over zeroPerc and avg
                    if (!cellCountsDone) {
                        cellCounts.push( cellCount );
                    }
                }
                cellCountsDone = true;
            }

            exprDataUpdateMinMax(exprData);
            onDone();
        });
    }

    function buildGeneExprPlotsAddGenes(geneIds, metaName, plotType) {
        /* build the plots for the gene expression viewer */
        // get meta field from function call or dropdown
        if (metaName==null) {
            let metaIdx = document.getElementById("tpGeneExprMetaCombo").value.split("_")[1]; // e.g. tpMetaVal_1
            metaName = db.conf.metaFields[metaIdx].name;
        } else {
            let metaIdx = db.findMetaInfo(metaName).index
            chosenSetValue("tpGeneExprMetaCombo", "tpMetaVal_"+metaIdx);
        }

        //if (geneIds===null) {
            //geneIds = getById("tpGeneExprGeneCombo").value;
        //} //else {
           // geneIds = geneIds[0].split("+");
        //}

        //let geneIdStr = geneIds.join("|");

        if (geneIds.length>0)
            selectizeSetValue("tpGeneExprGeneCombo", geneIds[0].split("|")[0]);


        function buildProgressBar(domId) {
            var progressDiv = $( "#"+domId );
            var progressLabel = progressDiv.children().first();
            progressDiv.progressbar({
              value: false,
              complete: function() {
                progressLabel.text( "Creating plot..." );
              }
            });
        }

        let exprContent = getById("tpExprViewPlot");
        exprContent.innerHTML = 
            '<div id="progressBarExpr" style="width:500px"><div class="progress-label">Loading expression values...</div></div><br>'+
            '<div id="progressBarMeta" style="width:500px"><div class="progress-label">Loading annotation labels...</div></div>';

        buildProgressBar('progressBarExpr');
        buildProgressBar('progressBarMeta');

        if (exprData===null) {
            exprData = {};
            exprData.metaData = {};
            exprData.metaLabels = [];
            exprData.syms = [];
            exprData.rows = [];
            exprData.cellCounts = [];
            exprData.geneIds = [];
            exprData.allAvgMax = NaN;
            exprData.allAvgMin = NaN;
        }

        Promise.all([promiseMeta(metaName, geneExprOnProgress)]).then( function (resArr) {
            exprData.metaData = resArr[0];
            exprData.metaLabels = exprData.metaData.ui.shortLabels;

            function onGenesDone () { 
                buildExprDotplot("tpExprViewPlot", exprData); 
                // save into URL
                let allGeneIdStr = exprData.geneIds.join(" ");
                let urlOpts = { "exprGene" : allGeneIdStr, "exprMeta" : metaName };
                changeUrl(urlOpts);
            };

            exprDataLoadGenes(geneIds, exprData, onGenesDone);

        });

        //Promise.all([promiseGene(geneId, geneExprOnProgress), promiseMeta(metaName, geneExprOnProgress)]).then( function(resArr) {
        //    //console.log("promises are all loaded", resArr);
        //    $( '#progressBarMeta').progressbar( "value", 100); // make sure that the progress bars show "complete"
        //    $( '#progressBarExpr').progressbar( "value", 100);

        //    let geneData = resArr[0];
        //    let exprArr = geneData.exprArr;

        //    let metaData = resArr[1];
        //    let shortLabels = metaData.ui.shortLabels;
        //    let metaArr = metaData.arr;

        //    let oldMetaArr = metaArr;

        //    var metaCountSize = metaData.valCounts.length;

        //    let res = splitExprByMeta(metaArr, metaCountSize, exprArr);
        //    let metaToExpr = res[0];
        //    let exprMin = res[1];
        //    let exprMax = res[2];

        //    //getById("tpGeneExprYLimit").value = exprMax;
        //    //if (forceExprMaxNum)
        //        //exprMax = forceExprMaxNum;

        //    if (plotType==="violin") {
        //        buildExprViolins("tpExprViewPlot", metaToExpr, metaData.ui.shortLabels, exprMax);
        //    } else if (plotType==="barchart") {
        //        buildExprBarcharts("tpExprViewPlot", metaToExpr, metaData.ui.shortLabels, exprMin, exprMax);
        //    } else {
        //        let dotData = calcDotData(metaToExpr, false);
        //        buildExprDotplot("tpExprViewPlot", geneSym, dotData, shortLabels, exprMin, exprMax);
        //    }
        //});
    }

    function closeExprView() {
    /* close the expression viewer dialog window, remove the key handler, destroy the chart objects */
        if (!renderer.readyToDraw())
            loadAndRenderData(); // note that if 'exprGene' set on initial load, loadAndRenderData() was not run, so do this now.
        changeUrl({"exprGene":null, "exprMeta":null});
        getById("tpExprView").remove();
        window.violinCharts = [];
        window.removeEventListener("keyup", onEscapeCloseExprView); 
    }

    function onEscapeCloseExprView(e) {
        if(e.keyCode == 27) closeExprView(); 
    }

    function buildExprViewWindow() {
        /* build the expression viewer dialog box */
        if (db.conf.atacSearch) {
            alert("This is an ATAC-Seq dataset. Creating dot/violin/barchart gene plots from ATAC-Seq peak data "+
                    "is not obvious, as the Cell Browser does not know how to associate peaks to genes. "+
                    "Therefore this feature has been disabled. If you have suggestions or feedback about this choice, please "+
                    " do not hesitate to contact us at cells@ucsc.edu");
            return;
        }

        var htmls = [];
        htmls.push("<div id='tpExprView'>");

        htmls.push("<div id='tpExprViewTitle'>");
        htmls.push("<b>Gene Expression Plots</b>");
        htmls.push("<span id='tpCloseButton' class='ui-button-icon ui-icon ui-icon-closethick' style='float:right'></span>");
        htmls.push("</div>"); //tpExprViewTitle

        htmls.push('<div id="tpExprViewContent">');

        htmls.push('<div class="link" style="padding-bottom: 6px; padding-left: 6px" id="tpBackToCb">&#8592; Back to Cell Browser</div>');

        htmls.push("<div id='tpExprViewHeader'>");
        htmls.push('<label id="tpGeneExprLabel" for="tpGeneExprGeneCombo">Show expression of </label>');
        htmls.push('<select style="width:200px" id="tpGeneExprGeneCombo" placeholder="Gene" class="tpCombo"></select>');

        htmls.push('<label id="tpGeneExprMetaLabel" for="'+"tpGeneExprMetaCombo"+'">Split by cell annotation</label>');

        // try to use the current color field, but you cannot split on a number, so fall back to the default color field
        let metaName = getActiveColorField();
        //let metaName = getActiveColorField();;
        metaName = getVar("exprMeta", metaName);

        var fieldInfo = db.findMetaInfo(metaName);
        if (fieldInfo.type!=="enum") {
            metaName = db.getDefaultColorField();
            changeUrl({"exprMeta":metaName});
            fieldInfo = db.findMetaInfo(metaName);
            if (fieldInfo.type!=="enum") {
                alert("The default color field is a numerical field, select a non-numerical categorical field instead. Also, contact us.");
            }
        }

        buildMetaFieldCombo(htmls, "tpGeneExprMetaComboBox", "tpGeneExprMetaCombo", 0, metaName, "noNums");
        htmlAddInfoIcon(htmls, "Expression data can only be split by categorical fields. Numerical fields are not shown here.");
        

        htmls.push('<button id="tpGeneExprAddMulti" style="padding-left: 15px; padding-right: 15px; padding-bottom: 5px; padding-top: 5px; margin-left: 15px">Add multiple genes</button>');

        //htmls.push('<input style="margin-left:4em" type="checkbox" id="tpGeneExprYLimitCheck"></input>');
        //htmls.push('<label style="margin-left:0.6em" for="tpGeneExprYLimitCheck">Set maximum to</label>');
        //htmls.push('<input style="margin-left:0.6em" type="text" id="tpGeneExprYLimit" size="7"></input>');
        //htmls.push('<button style="margin-left:0.6em" type="button" id="tpGeneExprLimitApply">Apply</button>');
        //htmls.push('<button style="margin-left:2em" type="button" data-type="violin" id="tpGeneExprFlipType">Show Violins</button>');

        htmls.push("</div>"); //tpExprViewHeader

        htmls.push('<div style="display:flex; flex-direction: row; flex-flow: wrap; height:100%; padding-top:10px" id="tpExprViewPlot"></div>'); // empty div, will be filled later

        htmls.push("</div>"); //tpExprViewContent
        htmls.push("</div>"); //tpExprView

        $(document.body).append(htmls.join(""));
        window.addEventListener("keyup", onEscapeCloseExprView);

        activateGeneCombo("tpGeneExprGeneCombo", onGeneExprGeneComboChange);

        activateCombobox("tpGeneExprMetaCombo", metaBarWidth-10);

        $("#tpGeneExprMetaCombo").change( onGeneExprMetaComboChange );

        $("#tpBackToCb").click( closeExprView );
        $('#tpCloseButton').click( closeExprView );
        $('#tpGeneExprAddMulti').click( onGeneExprAddGenesClick  );

        /*
        $('#tpGeneExprFlipType').click( function() { 
            let button = $('#tpGeneExprFlipType');
            let chartType = button.attr("data-type");
            window.setTimeout(function() {
                buildGeneExprPlotsAddGenes(geneSym, metaName, chartType); 
            }, 5);

            if (chartType==="violin") {
                button.html("Show Violins");
                button.attr("data-type", "violin");
            } else {
                button.html("Show Dotplot");
                button.attr("data-type", "dotplot");
            }
        } );
        */

        //getById("tpGeneExprLimitApply").addEventListener("click", function(ev) {
            //changeUrl({"exprMax": getById("tpGeneExprYLimit").value});
            //buildGeneExprPlotsAddGenes([geneSym], metaName, $("tpGeneExprFlipType").attr("data-type")); 
        //});

        //getById("tpGeneExprYLimitCheck").addEventListener("change", function(ev) {
            // if the checkbox is on, enable the input field
            //let isDisabled = !ev.target.checked;
            //getById("tpGeneExprYLimit").disabled = isDisabled;
            //getById("tpGeneExprLimitApply").disabled = isDisabled;
        //});
        
        // use the current gene
        let geneSym = getVar("gene", null);
        
        // if there is none, pick a reasonable default gene and meta var
        if (geneSym===null && db.conf.quickGenes)
            geneSym = db.conf.quickGenes[0][0];
        if (geneSym==null)
            geneSym = db.getRandomLocus();

        // URL variables can override the defaults
        let geneIds = getVar("exprGene", geneSym).split(" ");

        buildGeneExprPlotsAddGenes(geneIds, metaName); 
    }

    function buildToolBar (coordInfo, dataset, fromLeft, fromTop) {
    /* add the tool bar with icons of tools and add under body to the DOM */
        $("#tpToolBar").remove();

        var htmls = [];

        htmls.push("<div id='tpToolBar' style='position:absolute;left:"+fromLeft+"px;top:"+fromTop+"px'>");
        htmls.push('<button title="More info about this dataset: abstract, methods, data download, etc." id="tpButtonInfo" type="button" class="ui-button tpIconButton" data-placement="bottom">Info &amp; Download</button>');

        if (db.conf.fileVersions.supplImageConf)
            htmls.push('<button id="tpOpenImgButton" class="gradientBackground ui-button ui-widget ui-corner-all" style="margin-top:3px; margin-left: 3px; height: 24px; border-radius:3px; padding-top:3px" title="Show supplemental hi-res images submitted with this dataset" data-placement="bottom">Supplemental Images</button>');

        if (!getVar("suppressOpenButton", false))
            htmls.push('<button id="tpOpenDatasetButton" class="gradientBackground ui-button ui-widget ui-corner-all" style="margin-top:3px; height: 24px; border-radius:3px; padding-top:3px" title="Open another dataset" data-placement="bottom">Open...</button>');

        //if (!db.conf.atacSearch)
        htmls.push('<button id="tpOpenExprButton" class="gradientBackground ui-button ui-widget ui-corner-all" style="margin-top:3px; margin-left: 3px; height: 24px; border-radius:3px; padding-top:3px" title="Open Gene Expression Violin Plot Viewer" data-placement="bottom">Gene Expression Plots</button>');

        //var nextLeft = 220;
        if (db.conf.hubUrl!==undefined) {
            htmls.push('<a target=_blank href="#" id="tpOpenGenome" class="gradientBackground ui-button ui-widget ui-corner-all" style="margin-left: 10px; margin-top:3px; height: 24px; border-radius:3px; padding-top:3px" title="Show sequencing read coverage and gene expression on UCSC Genome Browser" data-placement="bottom">Genome Browser</a>');
            //nextLeft += 155;
        }

        var xenaId = db.conf.xenaId;
        if (xenaId!==undefined) {
            htmls.push('<a target=_blank href="#" id="tpOpenXena" class="gradientBackground ui-button ui-widget ui-corner-all" style="margin-left: 10px; margin-top:3px; height: 24px; border-radius:3px; padding-top:3px" title="Show gene expression heatmap on UCSC Xena Browser, creates heatmap of current gene (if coloring by gene) and all dataset genes. Click this button also if you have an active Xena window open and want to update the view there." data-placement="bottom">Xena</a>');
            //nextLeft += 80;
        }

        if (coordInfo[coordInfo.length-1].shortLabel.length > 20)
            //$('.chosen-drop').css({"width": "300px"});
            layoutComboWidth += 50

        //buildLayoutCombo(dataset.coordLabel, htmls, coordInfo, "tpLayoutCombo", layoutComboWidth, nextLeft, 2);
        //nextLeft += 65+layoutComboWidth;

        var nameParts = dataset.name.split("/");
        var parentName = null;
        if (nameParts.length > 1) {
            //buildCollectionCombo(htmls, "tpCollectionCombo", 330, nextLeft, 0);
            buildCollectionCombo(htmls, "tpCollectionCombo", 330, null, 0);
            nameParts.pop();
            parentName = nameParts.join("/");
        }

        htmls.push("</div>");

        $(document.body).append(htmls.join(""));

        $('#tpOpenXena').click(onXenaButtonClick);
        $('#tpOpenGenome').click(onGenomeButtonClick);

        activateTooltip('.tpIconButton');
        activateTooltip('#tpOpenUcsc');
        activateTooltip('#tpOpenDatasetButton');
        activateTooltip('#tpOpenExprButton');
        activateTooltip('#tpOpenImgButton');

        $('#tpButtonInfo').click( function() { openDatasetDialog(db.conf, db.name) } );

        $('#tpOpenImgButton').click( function() { openDatasetDialog(db.conf, db.name, "images") } );

        activateCombobox("tpLayoutCombo", layoutComboWidth);

        if (parentName!==null) {
            activateCombobox("tpCollectionCombo", collectionComboWidth);
            loadCollectionInfo( parentName, function(dataset) {
                updateCollectionCombo("tpCollectionCombo", dataset);
            });
        }

        // selective gene or ATAC Color by search box
        var comboLoad = comboLoadGene;
        if (db.conf.atacSearch) {
            comboLoad = comboLoadAtac;
            getById("tpPeakListUpstream").addEventListener("click", onPeakUpstream);
            getById("tpPeakListAll").addEventListener("click", onPeakAll);
            getById("tpPeakListNone").addEventListener("click", onPeakNone);
            activateTooltip("#tpPeakListButtons > button");

        }

        // This is a hack to deactivate the "sifter" functionality of selectize.
        // It turns out that selectize is a very bad dropdown choice for us,
        // as it makes a strong assumption that matching is done on a keyword basis
        // which is not true for chrom ranges.
        // https://gist.github.com/rhyzx/2281e8d1662b7be21716
        Selectize.prototype.search = function (query) {
            return {
                query: query,
                tokens: [], // disable highlight
                items: $.map(this.options, function (item, key) {
                    return {id: key}
                })
            }
        };

        activateGeneCombo("tpGeneCombo", onGeneComboChange);
        $('#tpCollectionCombo').change(onDatasetChange);
        // update the combobox, select the right dataset
        $('#tpLayoutCombo').change(onLayoutChange);
        $('#tpOpenDatasetButton').click(openCurrentDataset);
        $('#tpOpenExprButton').click(buildExprViewWindow);
    }

    function metaFieldToLabel(fieldName) {
    /* convert the internal meta field string to the label shown in the UI. Fix underscores, _id, etc */
        if (fieldName==="_id")
            fieldName = capitalize(gSampleDesc)+" identifier";
        else
            fieldName = fieldName.replace(/_/g, " ");
        return fieldName;
    }

    function buildMetaPanel(htmls) {
        /* add html strings for the meta panel to the left side bar */
        var metaFields = db.conf.metaFields;
        for (var i = 0; i < metaFields.length; i++) {
            var metaInfo = metaFields[i];
            var fieldLabel = metaInfo.label;
            fieldLabel = fieldLabel.replace(/_/g, " ");
            var fieldMouseOver = metaInfo.desc;

            // fields without binning and with too many unique values are greyed out
            var isGrey = (metaInfo.type==="enum" && metaInfo.diffValCount>MAXCOLORCOUNT && metaInfo.binMethod===undefined);

            var addClass = "";
            var addTitle="";
            htmls.push("<div class='tpMetaBox' data-field-name='"+metaInfo.name+"' id='tpMetaBox_"+i+"'>");
            if (isGrey) {
                addClass=" tpMetaLabelGrey";
                addTitle=" title='This field contains too many different values. You cannot click it to color on it.'";
            }

            let divId = "tpMetaLabel_"+i;

            htmls.push("<div id='"+divId+"' class='tpMetaLabel"+addClass+"'"+addTitle+">"+fieldLabel);
            if (fieldMouseOver)
                htmls.push('<i title="'+fieldMouseOver+'" '+
                ' class="material-icons tpMetaLabelHelp" style="float:right;font-size:16px">help_outline</i>');
            htmls.push("</div>");

            var styleAdd="";
            if (metaInfo.opt!==undefined) {
                var opt = metaInfo.opt;
                if (opt.fontSize!==undefined)
                    styleAdd = ";font-size:"+metaInfo.opt.fontSize;
            }

            htmls.push("<div class='tpMetaValue' style='"+styleAdd+
                    "' data-field-name='"+metaInfo.name+"' id='tpMeta_" + i + "'>&nbsp;</div>");
            htmls.push("</div>"); // tpMetaBox
        }
        htmls.push("<div style='background-color:white; float:right' id='tpMetaNote' style='display:none; height:1em'></div>");
    }

    function rebuildMetaPanel() {
        $("#tpMetaPanel").empty();
        let htmls = [];
        buildMetaPanel(htmls);
        $("#tpMetaPanel").html(htmls.join(""));
        connectMetaPanel();
    }

    function connectMetaPanel() {
        activateTooltip(".tpMetaLabelHelp");
        $(".tpMetaLabel").click( onMetaClick );
        $(".tpMetaValue").click( onMetaClick );
        $(".tpMetaValue").on("mouseenter", onMetaMouseOver );
        $(".tpMetaValue").on ("mouseout", function() {
            $('#tpMetaTip').hide();
            $('.tpMetaBox').removeClass("tpMetaHover");
            $('.tpMetaBox .tpMetaValue').removeClass("tpMetaHover");
        } );

        // setup the right-click menu
        //var menuItems = [{name: "Use as cluster label"},{name: "Copy field value to clipboard"}];
        var menuItems = [{name: "Copy field value to clipboard"}];
        var menuOpt = {
            selector: ".tpMetaBox",
            items: menuItems,
            className: 'contextmenu-customwidth',
            callback: onMetaRightClick
        };
        $.contextMenu( menuOpt );

        var menuItemsCust = [{name: "Copy field value to clipboard"},
            {name: "Remove custom annotations"}];
        var menuOptCust = {
            selector: "#tpMetaBox_custom",
            items: menuItemsCust,
            className: 'contextmenu-customwidth',
            callback: onMetaRightClick
        };
        $.contextMenu( menuOptCust );
        // setup the tooltips
        //$('[title!=""]').tooltip();
    }

    function parseGenesFromTextBox(textBoxQuery, onDone) {
        /* parse the geneIds from a text box that matches selector textBoxQuery. runs onDone(geneIds) when done */
        //let inText = $('#tpMultiGeneText').val();
        let inText = $(textBoxQuery).val();

        inText = inText.trim().replace(/\r\n/g,"\n");
        let geneNames = [];
        if (inText.indexOf("\n")!==-1) {
            // multiple lines - use only first word on each line
            let inLines = inText.split("\n");
            for (let l of inLines) {
                if (l.startsWith("#"))
                    continue;
                let part1 = l.split(/[ ,]/)[0];
                geneNames.push(part1);
            }
        } else {
            // single line of text - accept comma or space or combinations
            inText = inText.replace(/\n/g, " ");
            inText = inText.replace(/,/g, " ");
            inText = inText.replace(/ +/g, " ");
            geneNames = inText.split(" ");
        }

        // check if all the inputs are either a geneId or a uniquely resolving gene symbol
        // if not, alert the user, fix the text box by commenting out the errors and stop.
        let outLines = [];
        let allGeneIds = [];
        let errCount = 0;
        let allSyms = [];
        for (let i=0; i < geneNames.length; i++) {
            let geneName = geneNames[i];
            if (db.isGeneId(geneName)) {
                outLines.push(geneName);
                allGeneIds.push(geneName);
                allSyms.push(geneName);
            }
            else {
                // not a gene ID
                let geneIds = db.findGenesExact(geneName);
                if (geneIds.length===0) {
                    outLines.push("# "+geneName+": not found");
                    errCount++;
                } else if (geneIds.length>1) {
                    outLines.push("# "+geneName+": more than one matching gene ID, try entering gene IDs, not symbols");
                    errCount++;
                }
                else {
                    let geneId = geneIds[0];
                    allGeneIds.push(geneId);
                    outLines.push(geneId+" "+geneName);
                    allSyms.push(geneName);
                }
            }
        }

        let outLineStr = outLines.join('\n');
        localStorage.setItem("multiGene", outLineStr);
        if (errCount!==0) {
            alert("At least one of the input geneIds are not found or is not unique. The input was corrected. ");
            $(textBoxQuery).val(outLineStr);
        } else {
            $(".ui-dialog-content").dialog("close");
            //colorByMultiGenes(allGeneIds, null, allSyms.join("+"));
            return { "geneIds":allGeneIds, "syms" : allSyms };
        }
    }

    function onMultiGeneLoadClick (ev) {
    /* user clicked 'load genes below' on the multi gene input dialog box to color the UMAP plot */
        let inGenes = parseGenesFromTextBox("#tpMultiGeneText");
        colorByMultiGenes(inGenes.geneIds, inGenes.syms);
    }

    function onGeneExprAddGenesLoadClick (ev) {
    /* user clicked 'load genes below' on the multi gene input dialog box to update the dotplot */
        let inGenes = parseGenesFromTextBox("#tpMultiGeneText");

        function onExprDataDone() {
            buildExprDotplot("tpExprViewPlot", exprData); 
        }

        exprDataLoadGenes(inGenes.geneIds, exprData, onExprDataDone);

    }

    function buildMultiGeneBox (htmls) {
        htmls.push("<div style='margin-bottom:5px'>");
        htmls.push("<span>Enter multiple genes below. Either as a single line, separated by commas or spaces.<br>");
        htmls.push("Or as one geneId or symbol per line, in which case only the first word of every line is used.</span>");
        htmls.push("<button id='tpGenesLoad' style='height: 1.3em; width: 200px; float:right'>Load the genes below</button>");
        htmls.push("</div>");

        htmls.push("<textarea placeholder='Enter or paste gene names here' id='tpMultiGeneText' style='width:100%; height:100%'/>");
    }


    function onGeneExprAddGenesClick() {
        /* user clicked 'Add multiple genes' on the gene expression dialog */
        let htmls = [];
        buildMultiGeneBox(htmls);
        showDialogBox(htmls, "Add genes to Dotplot", {"width": 900, "height":600});

        let lastVal = localStorage.getItem("multiGene");
        if (lastVal !== undefined)
            $("#tpMultiGeneText").val(lastVal);

        $('#tpGenesLoad').click( onGeneExprAddGenesLoadClick );
    }

    function onMultiGeneClick () {
    /* user clicks the 'multi gene' button */
        let htmls = [];
        buildMultiGeneBox(htmls);
        showDialogBox(htmls, "Color cells by the sum of expression values of multiple genes", {"width": 900, "height":600});

        let lastVal = localStorage.getItem("multiGene");
        if (lastVal !== undefined)
            $("#tpMultiGeneText").val(lastVal);

        $('#tpGenesLoad').click( onMultiGeneLoadClick );
    }

    function buildLeftSidebar () {
    /* add the left sidebar with the meta data fields. db.loadConf
     * must have completed before this can be run, we need the meta field info. */
        $("#tpLeftSidebar").remove();
        // setup the tabs
        var tabsWidth = metaBarWidth;

        var htmls = [];
        htmls.push("<div id='tpMetaTip' style='display:none'></div>");
        htmls.push("<div id='tpLeftSidebar' style='position:absolute;left:0px;top:"+menuBarHeight+"px;width:"+metaBarWidth+"px'>");

        //htmls.push("<div class='tpSidebarHeader'>Color By</div>");

        // a bar with the tabs
        htmls.push("<div id='tpLeftTabs'>");
        htmls.push("<ul>");
        htmls.push("<li><a href='#tpAnnotTab'>Annotation</a></li>");
        htmls.push("<li><a href='#tpGeneTab'>"+getGeneLabel()+"</a></li>");
        htmls.push("<li><a href='#tpLayoutTab'>Layout</a></li>");
        htmls.push("</ul>");

        htmls.push("<div id='tpAnnotTab'>");

        htmls.push('<label style="padding-left: 2px; margin-bottom:8px; padding-top:8px" for="'+"tpMetaCombo"+'">Color by Annotation</label>');
        buildMetaFieldCombo(htmls, "tpMetaComboBox", "tpMetaCombo", 0);
        htmls.push('<label style="padding-left: 2px; margin-bottom:8px; padding-top:8px" for="tpLabelCombo">Label by Annotation</label>');
        htmls = htmlAddInfoIcon(htmls, "Choose a field to generate labels for. Labels will be placed in the center between all the cells with "+
                "this annotation, so this is most useful for fields that label cells that are close together. Numerical "+
                "fields or fields with several hundred values cannot be selected here, as the labels would fill the screen.", "bottom");
        buildMetaFieldCombo(htmls, "tpLabelComboBox", "tpLabelCombo", 0, db.conf.labelField, "doLabels");

        htmls.push('<div style="padding-top:4px; padding-bottom: 4px; padding-left:2px" id="tpHoverHint" class="tpHint">Hover over a '+gSampleDesc+' to update data below</div>');
        htmls.push('<div style="padding-top:4px; padding-bottom: 4px; padding-left:2px; display: none" id="tpSelectHint" class="tpHint">Cells are selected. No update on hover.</div>');

        htmls.push("<div id='tpMetaPanel'>");
        buildMetaPanel(htmls);
        htmls.push("</div>"); // tpMetaPanel

        htmls.push("</div>"); // tpAnnotTab

        htmls.push("<div id='tpGeneTab'>");

        buildGeneCombo(htmls, "tpGeneCombo", 0, metaBarWidth-10);

        if (db.conf.multiModal && db.conf.multiModal.splitPrefix)
            htmls.push('<input type="checkbox" id="splitJoinBox" name="splitJoin" value="splitJoin" /> <label for="subscribeNews">Show on both screens</label>');
        // var myGenes = loadMyGenes();

        if (db.conf.atacSearch)
            buildPeakList(htmls);

        var geneLabel = getGeneLabel();
        var recentHelp = "Shown below are the 10 most recently searched genes. Click any gene to color the plot on the right-hand side by the gene.";

        buildGeneTable(htmls, "tpRecentGenes", "Recent "+geneLabel+"s",
            "Hover or select cells to update colors here<br>Click to color by gene", gRecentGenes, null, recentHelp);


        var noteStr = "No genes or peaks defined. Use the setting quickGenesFile in "
            "cellbrowser.conf to add a file with gene symbols or peaks that will be shown here";
        var geneHelp = "The dataset genes were defined by the dataset submitter, publication author or data wrangler at UCSC. " +
            "Click any of them to color the plot on the right hand side by the gene.";
        buildGeneTable(htmls, "tpGenes", "Dataset "+geneLabel+"s", null, db.conf.quickGenes, noteStr, geneHelp);

        htmls.push("</div>"); // tpGeneTab

        htmls.push("<div id='tpLayoutTab'>");
        buildLayoutCombo(db.conf.coordLabel, htmls, db.conf.coords, "tpLayoutCombo", 0, 2);
        htmls.push("</div>"); // tpLayoutTab

        htmls.push("</div>"); // tpLeftSidebar

        $(document.body).append(htmls.join(""));

        resizeGeneTableDivs("tpRecentGenes");
        resizeGeneTableDivs("tpGenes");

        activateTooltip('.hasTooltip');

        $("#tpResetColors").click ( function() { 
            removeSplit(renderer);
            colorByDefaultField(undefined, true) 
            activateTab();
        });

        $("#tpSplitOnGene").click ( function() { 
            if (renderer.isSplit())
            {
                removeSplit(renderer);
            } else {
                $("#tpSplitOnGene").text(splitButtonLabel(false));
                activateSplit();
                colorByDefaultField(undefined, true) 
                renderer.childPlot.activatePlot();
            }
        });

        $("#tpMultiGene").click ( onMultiGeneClick );

        $("#tpLeftTabs").tabs();
        activateTab();

        $('.tpGeneBarCell').click( onGeneClick );
        $('#tpChangeGenes').click( onChangeGenesClick );

        $('#tpSetRadiusAlphaButton').click( onSetRadiusAlphaClick );
        $('#radiusAlphaForm').on("submit",function(event){event.preventDefault()}); // do not reload page when submit clicked

        activateCombobox("tpMetaCombo", metaBarWidth-10);
        $("#tpMetaCombo").change( onMetaComboChange );

        activateCombobox("tpLabelCombo", metaBarWidth-10);
        $("#tpLabelCombo").change( onLabelComboChange );
        connectMetaPanel();
    }

    function makeTooltipCont() {
        /* make a div for the tooltips */
        var ttDiv = document.createElement('div');
        ttDiv.id = "tpTooltip";
        ttDiv.style.position = "absolute";
        //ttDiv.style.left = left+"px";
        //ttDiv.style.top = top+"px";
        ttDiv.style["padding"]="2px";
        ttDiv.style["border"]="1px solid black";
        ttDiv.style["border-radius"]="2px";
        ttDiv.style["display"]="none";
        ttDiv.style["cursor"]="pointer";
        ttDiv.style["background-color"]="rgba(255, 255, 255, 0.85)";
        ttDiv.style["box-shadow"]="0px 2px 4px rgba(0,0,0,0.3)";
        ttDiv.style["user-select"]="none";
        ttDiv.style["z-index"]="10";
        return ttDiv;
    }

    function showIntro(addFirst) {
        /* add the intro.js data */
        //var htmls = [];
        //htmls.push("<a href='http://example.com/' data-intro='Hello step one!'></a>");
        //$(document.body).append(htmls.join(""));

        localStorage.setItem("introShown", "true");
        activateTab("meta");
        var intro = introJs();
        intro.setOption("hintAnimation", false);
        intro.setOption("exitOnEsc", true);
        intro.setOption("exitOnOverlayClick", true);
        intro.setOption("scrollToElement", false);

        intro.setOption("doneLabel", "Close this window");
        intro.setOption("skipLabel", "Stop the tutorial");

        if (addFirst) {
            intro.setOption("skipLabel", "I know. Close this window.");
            intro.addStep({
                element: document.querySelector('#tpHelpButton'),
                intro: "Are you here for the first time and wondering what this is?<br>The tutorial takes only 1 minute. To skip the tutorial now, click 'I know' below or press Esc.<br>You can always show it again by clicking 'Help > Tutorial'.",
              });
        }

        intro.addSteps(
            [
              {
                intro: "In the middle of the screen, each circle represents a "+gSampleDesc+". You can click the cluster label text to show the marker gene lists of the cluster.",
                element: document.querySelector('#mpCanvas'),
                position: 'auto'
              },
              {
                element: document.querySelector('#tpLeftSidebar'),
                intro: "Info and color control: move the mouse over a circle to show its annotation data.<br>Select an annotation field from the dropdown or simply click it, to color by the field. Click a gene from the list of pre-selected genes or search for a gene in the dropdown to color by it.<br>",
                position: 'auto'
              },
              //{
                //element: document.querySelector('#tpGeneBar'),
                //intro: "Expression data: when you move the mouse, expression values will be shown here.<br>Click on a gene to color the circles by gene expression level (log'ed).",
                //position: 'top'
              //},
              {
                element: document.querySelector('#tpLegendBar'),
                intro: "Click into the legend to select "+gSampleDesc+"s.<br>Click a color to change it or select a palette from the 'Colors' menu.<br>If you need a dataset, send us a link to it. If you have a new dataset in your lab, send it to cells@ucsc.edu so we can add it (hidden until publication).<br>To setup your own cell browser on your own webserver, see 'Help - Setup your own'.",
                position: 'left'
              },
            ]);
        intro.start();
    }

     /**
     https://gist.github.com/mjackson/5311256
     * Converts an HSL color value to RGB. Conversion formula
     * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
     * Assumes h, s, and l are contained in the set [0, 1] and
     * returns r, g, and b in the set [0, 255].
     *
     * @param   Number  h       The hue
     * @param   Number  s       The saturation
     * @param   Number  l       The lightness
     * @return  Array           The RGB representation
     */
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }

    function hslToRgb(h, s, l) {
      var r, g, b;

      if (s === 0) {
	r = g = b = l; // achromatic
      } else {
	var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	var p = 2 * l - q;

	r = hue2rgb(p, q, h + 1/3);
	g = hue2rgb(p, q, h);
	b = hue2rgb(p, q, h - 1/3);
      }

      return [ r * 255, g * 255, b * 255 ];
    }

    function makeHslPalette(hue, n) {
        /* return a list of n hexcodes from hue to white */
        var pal = [];
        for (var i=1; i<n+1; i++) {
            var c = hslToRgb(hue, 1.0, (0.35+((n-i)/n*0.65)));
            pal.push( palette.rgbColor(c[0]/255, c[1]/255, c[2]/255));
        }
        return pal;
    }

    function isDark(c) {
	/* c is a six-digit hexcode, return true if it's a dark color */
	// from https://stackoverflow.com/questions/12043187/how-to-check-if-hex-color-is-too-black
	var rgb = parseInt(c, 16);   // convert rrggbb to decimal
	var r = (rgb >> 16) & 0xff;  // extract red
	var g = (rgb >>  8) & 0xff;  // extract green
	var b = (rgb >>  0) & 0xff;  // extract blue

	var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b; // per ITU-R BT.709

	return (luma < 40);
    }

    function makePercPalette(palName, n) {
        /* palettes from https://github.com/politiken-journalism/scale-color-perceptual */
        var pal = [];
        var step = 1/n;

        var func = null;
        var doRev = false;
        switch (palName) {
            case 'inferno' : func =  scale.color.perceptual.inferno; doRev=true; break;
            case 'viridis' : func =  scale.color.perceptual.viridis; doRev=true; break;
            case 'magma' : func =  scale.color.perceptual.magma; doRev=true; break;
            case 'plasma' : func =  scale.color.perceptual.plasma; doRev=true; break;
        }

        for (let x=0; x<n; x++) {
            pal.push(func(x*step).substr(1));
        }

        if (pal.length!==n)
            console.log("palette is too small");

        if (doRev)
            pal = pal.reverse();

        return pal;
    }

    function makeTatarizePalette(n) {
    /* suggested by Niko Papadopoulos from Detlev Arendt's group see http://godsnotwheregodsnot.blogspot.com/2012/09/color-distribution-methodology.html */
        var pal = ["000000", "FFFF00", "1CE6FF", "FF34FF", "FF4A46", "008941", "006FA6", "A30059",
                "FFDBE5", "7A4900", "0000A6", "63FFAC", "B79762", "004D43", "8FB0FF", "997D87",
                "5A0007", "809693", "FEFFE6", "1B4400", "4FC601", "3B5DFF", "4A3B53", "FF2F80",
                "61615A", "BA0900", "6B7900", "00C2A0", "FFAA92", "FF90C9", "B903AA", "D16100",
                "DDEFFF", "000035", "7B4F4B", "A1C299", "300018", "0AA6D8", "013349", "00846F",
                "372101", "FFB500", "C2FFED", "A079BF", "CC0744", "C0B9B2", "C2FF99", "001E09",
                "00489C", "6F0062", "0CBD66", "EEC3FF", "456D75", "B77B68", "7A87A1", "788D66",
                "885578", "FAD09F", "FF8A9A", "D157A0", "BEC459", "456648", "0086ED", "886F4C",
                "34362D", "B4A8BD", "00A6AA", "452C2C", "636375", "A3C8C9", "FF913F", "938A81",
                "575329", "00FECF", "B05B6F", "8CD0FF", "3B9700", "04F757", "C8A1A1", "1E6E00",
                "7900D7", "A77500", "6367A9", "A05837", "6B002C", "772600", "D790FF", "9B9700",
                "549E79", "FFF69F", "201625", "72418F", "BC23FF", "99ADC0", "3A2465", "922329",
                "5B4534", "FDE8DC", "404E55", "0089A3", "CB7E98", "A4E804", "324E72", "6A3A4C"];
        return pal.slice(0, n);
    }

    function makeColorPalette(palName, n) {
    /* return an array with n color hex strings */
    /* Use Google's palette functions for now, first Paul Tol's colors, if that fails, use the usual HSV rainbow
     * This code understands our special palette, tol-sq-blue
    */
        var pal = [];
        if (palName==="blues")
            pal = makeHslPalette(0.6, n);
        else if (palName==="magma" || palName==="viridis" || palName==="inferno" || palName=="plasma")
            pal = makePercPalette(palName, n);
        else if (palName==="iwanthue")
            pal = iWantHue(n);
        else if (palName==="reds")
            pal = makeHslPalette(0.0, n);
        else if (palName==="tatarize")
            pal = makeTatarizePalette(n);
        else {
            if (n===2)
                pal = ["ADD8E6","FF0000"];
            else {
                var realPalName = palName.replace("tol-sq-blue", "tol-sq");
                pal = palette(realPalName, n);
                if (palName==="tol-sq-blue")
                    pal[0]='f4f7ff';
            }
        }

        return pal;
    }

    function colorByCluster() {
    /* called when meta and coordinates have been loaded: scale data and color by meta field  */
        //setZoomRange();
    }

    function loadClusterTsv(fullUrl, func, divName, clusterName) {
    /* load a tsv file relative to baseUrl and call a function when done */
        function conversionDone(data) {
            Papa.parse(data, {
                    complete: function(results, localFile) {
                                func(results, localFile, divName, clusterName);
                            },
                    error: function(err, file) {
                                if (divName!==undefined)
                                    alert("could not load "+fullUrl);
                            }
                    });
        }

        function onTsvLoadDone(res) {
            var data = res.target.response;
            if (res.target.responseURL.endsWith(".gz")) {
                data = pako.ungzip(data);
                //data = String.fromCharCode.apply(null, data); // only good for short strings
                data = arrayBufferToString(data, conversionDone);
            }
            else
                conversionDone(data);
        }

    var req = new XMLHttpRequest();
    req.addEventListener("load", onTsvLoadDone);
    req.open('GET', fullUrl, true);
    req.responseType = "arraybuffer";
    req.send();
    }

    function removeFocus() {
    /* called when the escape key is pressed, removes current focus and puts focus to nothing */
        window.focus();
        if (document.activeElement) {
                document.activeElement.blur();
        }

    }

    function setupKeyboard() {
    /* bind the keyboard shortcut keys */
        phoneHome();
        Mousetrap.bind('o', openCurrentDataset);
        Mousetrap.bind('c m', onMarkClearClick);
        Mousetrap.bind('h m', onMarkClick);

        Mousetrap.bind('space', onZoom100Click);

        Mousetrap.bind('z', function() { activateMode("zoom"); });
        Mousetrap.bind('m', function() { activateMode("move"); });
        Mousetrap.bind('s', function() { activateMode("select"); });

        Mousetrap.bind('-', onZoomOutClick);
        Mousetrap.bind('+', onZoomInClick);
        Mousetrap.bind('s n', onSelectNoneClick);
        Mousetrap.bind('s a', onSelectAllClick);
        Mousetrap.bind('s i', onSelectInvertClick);
        Mousetrap.bind('s s', onSelectNameClick);

        Mousetrap.bind('b s', onBackgroudSetClick);
        Mousetrap.bind('b r', onBackgroudResetClick);

        Mousetrap.bind('m', function() {$('#tpMetaCombo').trigger("chosen:open"); return false;});
        Mousetrap.bind('d', function() {$('#tpDatasetCombo').trigger("chosen:open"); return false;});
        //Mousetrap.bind('l', function() {$('#tpLayoutCombo').trigger("chosen:open"); return false;});
        Mousetrap.bind('g', function() {$("#tpGeneCombo").selectize()[0].selectize.focus(); return false;});
        Mousetrap.bind('c l', onHideShowLabelsClick );
        Mousetrap.bind('f c', onFindCellsClick );
        Mousetrap.bind('f i', function() { onSelectByIdClick(); return false; } );
        Mousetrap.bind('t', onSplitClick );
        Mousetrap.bind('h', onHeatClick );

        Mousetrap.bind('up', function() { renderer.movePerc(0, 0.1); renderer.drawDots(); } );
        Mousetrap.bind('left', function() { renderer.movePerc(-0.1, 0); renderer.drawDots(); } );
        Mousetrap.bind('right', function() { renderer.movePerc(0.1, 0); renderer.drawDots(); } );
        Mousetrap.bind('down', function() { renderer.movePerc(0, -0.1); renderer.drawDots(); } );

        // yay vim
        Mousetrap.bind('i', function() { renderer.movePerc(0, 0.1); renderer.drawDots(); } );
        Mousetrap.bind('j', function() { renderer.movePerc(-0.1, 0); renderer.drawDots(); } );
        Mousetrap.bind('l', function() { renderer.movePerc(0.1, 0); renderer.drawDots(); } );
        Mousetrap.bind('k', function() { renderer.movePerc(0, -0.1); renderer.drawDots(); } );

        //Mousetrap.stopCallback = function(e, element, combo) {
            //var doStop = (element.tagName == 'INPUT' || element.tagName == 'SELECT' || element.tagName == 'TEXTAREA' || (element.contentEditable && element.contentEditable == 'true'));
            //console.log(e, element, combo);
            //return doStop;
        //};
    }

    // https://stackoverflow.com/a/33861088/233871
    function isInt(x) {
        return (typeof x==='number') && x % 1 === 0;
    }

    function naturalSort (a, b) {
    /* copied from https://github.com/Bill4Time/javascript-natural-sort/blob/master/naturalSort.js */
    /* "use strict"; */
    var re = /(^([+\-]?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+\-]?\d+)?)?$|^0x[0-9a-f]+$|\d+)/gi,
        sre = /(^[ ]*|[ ]*$)/g,
        dre = /(^([\w ]+,?[\w ]+)?[\w ]+,?[\w ]+\d+:\d+(:\d+)?[\w ]?|^\d{1,4}[\/\-]\d{1,4}[\/\-]\d{1,4}|^\w+, \w+ \d+, \d{4})/,
        hre = /^0x[0-9a-f]+$/i,
        ore = /^0/,
        i = function(s) { return naturalSort.insensitive && ('' + s).toLowerCase() || '' + s; },
        // convert all to strings strip whitespace
        x = i(a).replace(sre, '') || '',
        y = i(b).replace(sre, '') || '',
        // chunk/tokenize
        xN = x.replace(re, '\0$1\0').replace(/\0$/,'').replace(/^\0/,'').split('\0'),
        yN = y.replace(re, '\0$1\0').replace(/\0$/,'').replace(/^\0/,'').split('\0'),
        // numeric, hex or date detection
        xD = parseInt(x.match(hre), 16) || (xN.length !== 1 && x.match(dre) && Date.parse(x)),
        yD = parseInt(y.match(hre), 16) || xD && y.match(dre) && Date.parse(y) || null,
        oFxNcL, oFyNcL;
    // first try and sort Hex codes or Dates
    if (yD) {
        if ( xD < yD ) { return -1; }
        else if ( xD > yD ) { return 1; }
    }
    // natural sorting through split numeric strings and default strings
    for(var cLoc=0, numS=Math.max(xN.length, yN.length); cLoc < numS; cLoc++) {
        // find floats not starting with '0', string or 0 if not defined (Clint Priest)
        oFxNcL = !(xN[cLoc] || '').match(ore) && parseFloat(xN[cLoc]) || xN[cLoc] || 0;
        oFyNcL = !(yN[cLoc] || '').match(ore) && parseFloat(yN[cLoc]) || yN[cLoc] || 0;
        // handle numeric vs string comparison - number < string - (Kyle Adams)
        if (isNaN(oFxNcL) !== isNaN(oFyNcL)) { return (isNaN(oFxNcL)) ? 1 : -1; }
        // rely on string comparison if different types - i.e. '02' < 2 != '02' < '2'
        else if (typeof oFxNcL !== typeof oFyNcL) {
            oFxNcL += '';
            oFyNcL += '';
        }
        if (oFxNcL < oFyNcL) { return -1; }
        if (oFxNcL > oFyNcL) { return 1; }
    }
    return 0;
}

    function sortPairsBy(countList, sortBy) {
    /* sort an array in the format [name, count] by either name (using naturalSort) or count */
        var isSortedByName = null;

        if (sortBy==="name") {
            countList.sort(function(a, b) { return naturalSort(a[0], b[0]); });  // I have a feeling that this is very slow...
            isSortedByName = true;
        }
        else if (sortBy=="count") {
            // sort this list by count
            countList = countList.sort(function(a, b){ return b[1] - a[1]; }); // reverse-sort by count
            isSortedByName = false;
        } else {
            isSortedByName = false;
        }

        var ret = {};
        ret.list = countList;
        ret.isSortedByName = isSortedByName;
        // pallette should be a gradient for data types where this makes sense
        return ret;
    }

    function plotSelection(coords) {
    /* redraw block dots of current selection
       Redrawing makes sure that they are not hidden underneath others.
    */
        for (var i = 0; i < coords.length; i++) {
            var x = coords[i][0];
            var y = coords[i][1];
            var fill = coords[i][2];
            var dot = drawCircle(x, y, fill, 0x000000);
            stage.addChild(dot);
            visibleGlyps.push(dot);
        }
    }

    function removeCellIds(coords, cellIds) {
    /* remove all coords that are in an object of cellIds */
        var newCoords = [];
        for (var i = 0; i < coords.length; i++) {
            var coord = coords[i];
            var cellId = coord[0];
            if (!(cellId in cellIds))
                newCoords.push(coord);
        }
        return newCoords;
    }

    function showOnlyCellIds(coords, cellIds) {
    /* keep only coords that are in an object of cellIds */
        var newCoords = [];
        for (var i = 0; i < coords.length; i++) {
            var coord = coords[i];
            var cellId = coord[0];
            if (cellId in cellIds)
                newCoords.push(coord);
        }
        return newCoords;
    }

    function countValues(arr) {
        var counts = {};
        for (var i = 0; i < arr.length; i++) {
                counts[arr[i]] = 1 + (counts[arr[i]] || 0);
        }
        var countArr = Object.entries(counts);
        return countArr
    }

    function makeLabelRenames(metaInfo) {
        /* return an obj with old cluster name -> new cluster name */
        var valCounts = metaInfo.valCounts;
        if (valCounts===undefined) { // 'int' and 'float' types do not have their values counted yet
            // this doesn't work because the values are not loaded yet, requires moving this call to
            // later
            //metaInfo.valCounts = countValues(metaInfo.arr);
            alert("cannot label on numeric fields, please use the enumFields option in cellbrowser.conf");
        }
        var newLabels = metaInfo.ui.shortLabels;

        var oldToNew = {};
        for (var i = 0; i < valCounts.length; i++) {
            var oldLabel = valCounts[i][0];
            var newLabel = newLabels[i];
            oldToNew[oldLabel] = newLabel;
        }
        return oldToNew;
    }

    function getClusterFieldInfo() {
        var clusterField = db.conf.activeLabelField;
        var clusterMetaInfo = db.findMetaInfo(clusterField);
        return clusterMetaInfo;
    }

    function rendererUpdateLabels(metaInfo) {
        /* update the labels in the renderer from the metaInfo data. */
        var oldToNew = makeLabelRenames(metaInfo);

        var oldRendLabels = null;
        if (renderer.origLabels) {
            oldRendLabels = renderer.origLabels;
        }
        else {
            oldRendLabels = renderer.getLabels();
            renderer.origLabels = oldRendLabels;
        }

        var newRendLabels = [];
        for (var i = 0; i < oldRendLabels.length; i++) {
            var oldLabel = oldRendLabels[i];
            var newLabel = oldToNew[oldLabel];
            newRendLabels.push(newLabel);
        }
        renderer.setLabels(newRendLabels);
    }

    function onLegendLabelClick(ev) {
    /* called when user clicks on legend entry. */

        var legendId = parseInt(ev.target.id.split("_")[1]);
        var colorIndex = gLegend.rows[legendId].intKey;
        $("#tpLegendCheckbox_" + colorIndex).click();
    }

    function onSortByClick (ev) {
    /* flip the current legend sorting */
        var sortBy = null;
        if (ev.target.parentElement.id.endsWith("Col1")) // column 1 is the Name
            sortBy = "name"
        else
            sortBy = "freq";

        saveToUrl("s_"+gLegend.metaInfo.name,sortBy, gLegend.defaultSortBy);
        legendSort(sortBy);
        $(".tooltip").hide();
        buildLegendBar();
    }


    function onMetaRightClick (key, options) {
    /* user right-clicks on a meta field */
        var metaName = options.$trigger[0].id.split("_")[1];

        //if (key==0) {
            //gCurrentDataset.labelField = gCurrentDataset.metaFields[metaIdx];
            //gClusterMids = null; // force recalc
            //plotDots();
            //renderer.render(stage);
            //updateMenu();
        //}
        if (key===0) {
            copyToClipboard("#tpMeta_"+metaName);
        }

    }

    //function onLegendRightClick (key, options) {
    /* user right-clicks on a legend label */
        //var selEls = $(".tpLegendSelect")
        //var legendIds = [];
        //for (var i = 0; i < selEls.length; i++) {
            //var selEl = selEls[i];
            //var legendId = parseInt(selEl.id.split("_")[1]);
            //legendIds.push(legendId);
        //}

        //var cellIds = findCellIdsForLegendIds(gClasses, legendIds);
        //var mode;
        //if (key==0) // hide
            //mode = "hide";
        //else
            //mode = "showOnly";
        //filterCoordsAndUpdate(cellIds, mode);
    //}

    function setLegendHeaders(type) {
    /* set the headers of the right-hand legend */
        if (type==="category") {
            $('#tpLegendCol1').html('<span title="select all checkboxes below" id="tpLegendClear" style="font-size: 20px; vertical-align:top">&#9745;</span><span class="tpLegendHover" title="click to sort by name"> Name<span class="caret"></span></span>');
            $('#tpLegendCol2').html('<span class="tpLegendHover" title="click to sort by frequency"> Frequency<span class="caret"></span></span>');
        }
        else {
            $('#tpLegendCol1').html('<span title="select all checkboxes below" id="tpLegendClear">&#9745;</span> Range<span');
            $('#tpLegendCol2').html('Frequency');
        }
        activateTooltip("#tpLegendClear");
        activateTooltip(".tpLegendHover");
    }

    function updateLegendGrandCheckbox() {
        /* update the "uncheck all" checkboxes in the legend:
         * If all cells are selected */
        var checkbox = $("#tpLegendClear");
        if (gLegend.selectionDirection == "none") {
            gLegend.selectionDirection = "none";
            checkbox.html("&#9746;");
            // from https://stackoverflow.com/questions/9501921/change-twitter-bootstrap-tooltip-content-on-click
            checkbox.attr('title', "unselect all checkboxes below");
            var tip = checkbox.bsTooltip('fixTitle').data('bs.tooltip').$tip;
            if (tip) {
                tip.find('.tooltip-inner')
                .text("unselect all checkboxes below");
            }
        } else if (gLegend.selectionDirection == "all") {
            gLegend.selectionDirection = "all";
            checkbox.html("&#9745;");
            checkbox.attr('title', "select all checkboxes below");
            var tip = checkbox.bsTooltip('fixTitle').data('bs.tooltip').$tip;
            if (tip) {
                tip.find('.tooltip-inner')
                .text("select all checkboxes below");
            }
        } else {
            alert("internal error, gLegend.selectionDirection has an invalid value, please email cells@ucsc.edu");
        }
    }

    function legendSetCheckboxes(status) {
        /* set the legend checkboxes, status can be "none", "invert" or "all". Update the selection and redraw. */
        let els = document.getElementsByClassName("tpLegendCheckbox");

        //for (let el of els) {
        for (let i=0; i<els.length; i++) {
            let el = els[i];
            var valIdx = parseInt(el.getAttribute("data-value-index"));
            var valStr = null;

            if (gLegend.type==="meta")
                valStr = gLegend.rows[valIdx].label;

            if (status==="none") {
                if (el.checked)
                    renderer.unselectByColor(valIdx);
                el.checked = false;
            }
            else if (status==="all") {
                if (!el.checked)
                    renderer.selectByColor(valIdx);
                el.checked = true;
            }
            else if (status==="invert") {
                if (!el.checked) {
                    el.checked = true;
                    renderer.selectByColor(valIdx);
                }
                else {
                    el.checked = false;
                    renderer.unselectByColor(valIdx);
                }
            }
            else if (status==="notNull") {
                if ((i===0 && valStr===null) || (valStr!==null && likeEmptyString(valStr))) {
                    el.checked = false;
                    renderer.unselectByColor(valIdx);
                }
                else {
                    el.checked = true;
                    renderer.selectByColor(valIdx);
                }
            }
        }
        renderer.drawDots();
    }

    function onLegendClearClick(ev) {
        /* unselect all checkboxes in the legend and clear the selection */
        if (gLegend.selectionDirection == "all") {
            $(".tpLegendCheckbox").prop('checked', true);
            onSelectAllClick();
            gLegend.selectionDirection = "none";
        } else {
            $(".tpLegendCheckbox").prop('checked', false);
            onSelectNoneClick();
            gLegend.selectionDirection = "all";
        }
        updateLegendGrandCheckbox();
        ev.stopPropagation();
    }

    function onLegendApplyLimitsClick(ev) {
        /* user clicked the apply button: apply limits to the plot and redraw */
        makeLegendExpr(gLegend.geneSym, gLegend.titleHover, binInfo, exprArr, decArr);
    }

    function onLegendExportClick(ev) {
        /* export the legend to a tsv file */
        var lines = [ ["Label", "Long_Label", "Color", "Cell_Count", "Frequency"].join("\t") ] ;
        var rows = gLegend.rows;
        var sum = 0;

        // this code was copied from buildLegend -> refactor one day
        // it's also in the SVG drawing code in maxPLot.js
        for (var i = 0; i < rows.length; i++) {
            let count = rows[i].count;
            sum += count;
        }

        for (i = 0; i < rows.length; i++) {
            var row = rows[i];
            var colorHex = row.color; // manual color
            if (colorHex===null)
                colorHex = row.defColor; // default color
            // this was copied from cellbrowser:buildLegend - refactor soon
            var label = row.label;
            var longLabel = row.longLabel;
            let count = row.count;
            var freq  = 100*count/sum;
            label = label.replace("&ndash;", "-");
            var rowLine = [ label, longLabel, "#"+colorHex.toUpperCase(), count, freq].join("\t");
            lines.push( rowLine );
        }
        
        var blob = new Blob([lines.join("\n")], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "plotLegend.tsv");
    }

    function onLegendCheckboxClick(ev) {
        /* user clicked the small checkboxes in the legend */
        console.log(ev);
        console.log(ev.target);
        console.log(ev.target.checked);
        var valIdx = parseInt(ev.target.getAttribute("data-value-index"));
        if (ev.target.checked) {
            //ev.target.checked = true;
            renderer.selectByColor(valIdx);
            ev.target.checked = true;
        } else {
            //ev.target.checked = false; // why is this necessary?
            renderer.unselectByColor(valIdx);
            ev.target.checked = false;
        }
        renderer.drawDots();
    }

    function buildMinMaxPart(htmls) {
        /* create the min/max and apply/reset buttons */
        htmls.push("<div>");
        htmls.push("<table style='margin: 4px; margin-top: 6px'>");
        htmls.push("<tr>");
        htmls.push("<td><label for='exprMin'>Min:</label></td>");
        htmls.push("<td><input name='exprMin' size='8' type='text'></td>");
        htmls.push("<td><button id='tpExprLimitApply' style='border-radius: 4px; margin-left: 4px; padding: 3px 6px 3px 6px' class='ui-button'>Apply</button></td>");
        htmls.push("</tr>");

        htmls.push("<tr>");
        htmls.push("<td><label for='exprMax'>Max:</label></td>");
        htmls.push("<td><input name='exprMax' size='8' type='text'></td>");
        htmls.push("<td><button id='tpExprLimitClear' style='border-radius: 4px; margin-left: 4px; padding: 3px 6px 3px 6px' class='ui-button'>Clear</button></td>");
        htmls.push("</tr>");
        htmls.push("</table>");
        htmls.push("</div>");
    }


    function countLeadingZerosAfterDecimal(number) {
        // Convert number to string
        let numStr = number.toString();

        // Find the index of the decimal point
        let decimalIndex = numStr.indexOf('.');

        // If there is no decimal point, return 0
        if (decimalIndex === -1) {
            return 0;
        }

        // Iterate over characters after the decimal point
        let count = 0;
        for (let i = decimalIndex + 1; i < numStr.length; i++) {
            // If the character is '0', increment count
            if (numStr[i] === '0') {
                count++;
            } else {
                // If a non-zero digit is encountered, break the loop
                break;
            }
        }

        return count;
    }

    function buildLegendBar() {
    /* draws current legend as specified by gLegend.rows
     * */
        if (gLegend.rows===undefined)
            return;

        $('#tpLegendContent').empty();

        var htmls = [];

        var colors = [];
        var rows = gLegend.rows;

        var legTitle = gLegend.title;
        var subTitle = gLegend.subTitle;

        htmls.push('<span id="tpLegendTitle" title="' +gLegend.titleHover+'">'+legTitle+"</span>");
        if (subTitle)
            htmls.push('<div id="tpLegendSubTitle" >'+subTitle+"</div>");

        htmls.push('<div class="tpHint">Click buttons to select '+gSampleDesc+'s</small></div>');
        htmls.push("<small><button id='tpLegendAll'>All</button>");
        htmls.push("<button id='tpLegendNone'>None</button>");
        htmls.push("<button id='tpLegendInvert'>Invert</button></small>");
        htmls.push("<button id='tpLegendNotNull'>&gt; 0</button></small>");
        htmls.push("</div>"); // title
        htmls.push('<div id="tpLegendHeader"><span id="tpLegendCol1"></span><span id="tpLegendCol2"></span></div>');
        htmls.push('<div id="tpLegendRows">');

        // get the sum of all, to calculate frequency
        var sum = 0;
        for (var i = 0; i < rows.length; i++) {
            let count = rows[i].count;
            sum += count;
        }

        for (i = 0; i < rows.length; i++) {
            var row = rows[i];
            var colorHex = row.color; // manual color
            if (colorHex===null)
                colorHex = row.defColor; // default color

            var label = row.label;
            var longLabel = row.longLabel;

            let count = row.count;
            var valueIndex = row.intKey;
            var freq  = 100*count/sum;

            if (count===0) // never output categories with 0 count.
                continue;

            var labelClass = "tpLegendLabel";

            label = label.replace(/_/g, " ").replace(/'/g, "&#39;").trim();

            if (longLabel)
                longLabel = longLabel.replace(/_/g, " ").trim();

            if (likeEmptyString(label)) {
                labelClass += " tpGrey";
            }
            label = stringEmptyLabel(label);

            colors.push([i, colorHex]); // save for later

            var mouseOver = "";
            // only show the full value on mouse over if the label is long, "" suppresses mouse over
            if (longLabel && longLabel!=label)
                mouseOver = longLabel;
            else {
                if (label.length > 20)
                    mouseOver = label;
            }

            var classStr = "tpLegend";
            var line = "<div id='tpLegend_" +valueIndex+ "' class='" +classStr+ "'>";
            htmls.push(line);
            htmls.push("<input class='tpLegendCheckbox' data-value-index='"+valueIndex+"' "+
                "id='tpLegendCheckbox_"+valueIndex+"' type='checkbox'>");
            htmls.push("<input class='tpColorPicker' id='tpLegendColorPicker_"+i+"' />");

            htmls.push("<span class='"+labelClass+"' id='tpLegendLabel_"+i+"' data-placement='auto top' title='"+mouseOver+"'>");
            htmls.push(label);
            htmls.push("</span>");
            var prec = 1;
            if (freq<1)
                //prec = minPrec;
                prec = 1+countLeadingZerosAfterDecimal(freq) // one more digit than the smallest frequency

            htmls.push("<span class='tpLegendCount' title='"+count+" of "+sum+"'>"+freq.toFixed(prec)+"%</span>");
            htmls.push("</span>");

            htmls.push("</div>");
        }
        htmls.push('</div>'); // tpLegendRows

        htmls.push('<button id="tpExpColorButton" style="margin-top: 3px; line-height:9x">Export Legend</button>'); 

        // add the div where the violin plot will later be shown
        htmls.push("<div id='tpViolin'>");
        htmls.push("<canvas style='height:200px; padding-top: 10px; padding-bottom:30px' id='tpViolinCanvas'></canvas>");
        htmls.push("</div>"); // violin

        var htmlStr = htmls.join("");
        $('#tpLegendContent').append(htmlStr);

        setLegendHeaders(gLegend.rowType);

        // tpLegendContent has to go only up to the bottom of the screen.
        // This is done again in resizeDivs()
        // I have not found a way to do this in CSS...
        $("#tpLegendBar").css("height", (window.innerHeight - $('#tpLegendBar').offset().top)+"px");

        activateTooltip("#tpResetColors");
        activateTooltip("#tpSortBy");

        $("#tpLegendCol1").click( onSortByClick );
        $("#tpLegendCol2").click( onSortByClick );

        let checkEls = document.getElementsByClassName("tpLegendCheckbox");
        for (let i = 0; i < checkEls.length; i++) {
            checkEls[i].addEventListener("change", onLegendCheckboxClick);
        }

        $("#tpLegendClear").click( onLegendClearClick );
        $("#tpExprLimitApply").click( onLegendApplyLimitsClick );
        $("#tpExpColorButton").click( onLegendExportClick );

        $("#tpLegendNone").click( function() { legendSetCheckboxes("none"); } );
        $("#tpLegendAll").click( function() { legendSetCheckboxes("all"); } );
        $("#tpLegendInvert").click( function() { legendSetCheckboxes("invert"); } );
        $("#tpLegendNotNull").click( function() { legendSetCheckboxes("notNull"); } );

        $('.tpLegendLabel').click( onLegendLabelClick ); // clicking the legend should have the same effect as clicking the checkbox
        //$('.tpLegendLabel').attr( "title", "Click to select samples with this value. Shift click to select multiple values.");
        activateTooltip(".tpLegendLabel");
        activateTooltip(".tpLegendCount");

        // setup the right-click menu
        //var menuItems = [{name: "Hide "+gSampleDesc+"s with this value"}, {name:"Show only "+gSampleDesc+"s with this value"}];
        //var menuOpt = {
            //selector: ".tpLegend",
            //items: menuItems,
            //className: 'contextmenu-customwidth',
            //callback: onLegendRightClick
        //};
        //$.contextMenu( menuOpt );

        // activate the color pickers
        for (let i = 0; i < colors.length; i++) {
            var colInfo = colors[i];
            var rowIdx = colInfo[0];
            var hexCode = colInfo[1];

            var opt = {
                hideAfterPaletteSelect : true,
                color : hexCode,
                showPalette: true,
                allowEmpty : true,
                showInput: true,
                preferredFormat: "hex",
                change: onColorPickerChange
                }
            $("#tpLegendColorPicker_"+rowIdx).spectrum(opt);
        }

        buildViolinPlot();
    }

    function onColorPickerChange(color, ev) {
        /* called when user manually selects a color in the legend with the color picker */
        console.log(ev);
        /* jshint validthis: true */
        var valueIdx = parseInt(this.id.split("_")[1]);
        var rows = gLegend.rows;
        var clickedRow = rows[valueIdx];
        var oldColorHex = clickedRow.color;
        var defColorHex = clickedRow.defColor;
        var valueKey = clickedRow.strKey;
        if (valueKey==="")
            valueKey="_EMPTY_";

        /* jshint validthis: true */
        var newCol = $(this).spectrum('get');

        var newColHex = "";
        if (newCol===null)
            newColHex = oldColorHex; // if user clicked abort, revert to default color
        else
            newColHex = newCol.toHex();
        clickedRow.color = newColHex;

        // save color to cart if necessary
        saveToUrl(COL_PREFIX+valueKey, newColHex, defColorHex);

        var colors = legendGetColors(gLegend.rows);
        renderer.setColors(colors);
        renderer.drawDots();
    }

    function updateGeneTableColors(cellIds) {
    /* change the colors of the gene table to reflect the expression of cellIds */
        var quickGenes = db.conf.quickGenes;
        if (quickGenes===undefined)
            return;

        if (cellIds===null)
            cellIds = [];

        var pal = makeColorPalette(datasetGradPalette, exprBinCount);
        pal[0] = cNullColor; // this is hacky, but we don't want to color a table in beige if the values are 0

        //console.time("avgCalc");
        for (var i=0; i<quickGenes.length; i++) {
            var sym = quickGenes[i][0];
            //console.log("updating colors of "+sym+" for "+cellIds.length+" cells");
            var geneExpr = db.quickExpr[sym];
            if (geneExpr===undefined) { // if any gene is not loaded yet, just quit
                console.log(sym+" is not loaded yet, not updating expr table colors");
                return;
            }
            var vec = geneExpr[0];
            var binInfo = geneExpr[1];
            var sum = 0;

            var avg = 0;
            if (cellIds!==null && cellIds.length!==0) {
                for (var ci=0; ci<cellIds.length; ci++) {
                    sum += vec[cellIds[ci]];
                }
                avg = Math.round(sum / cellIds.length);
            }
            var color = pal[avg];
	    var fontColor = "#333333";
	    if (isDark(color))
		fontColor = "white";
            $("#tpGeneBarCell_"+onlyAlphaNum(sym)).css({"background-color": "#"+color, "color" : fontColor});
        }
        //console.timeEnd("avgCalc");
    }

    function makeFieldHistogram(metaInfo, selCellIds, metaVec) {
        /* count the values in metaInfo and return a sorted array of [count, fraction, valIndex] */
        let cellCount = selCellIds.length;
        if (!metaInfo.ui.shortLabels && (metaInfo.type === "float" || metaInfo.type === "int")) {
            // it's a numeric field, so let's create the labels now, they are derived from the bins
            let shortLabels = [];
            for (let bin of metaInfo.binInfo)
                shortLabels.push(labelForBinMinMax(bin[0], bin[1])); // 0,1 is min,max of the bin
            metaInfo.ui.shortLabels = shortLabels;
        }

        var metaCounts = {};
        // make an object with value -> count in the cells
        for (var i = 0; i < cellCount; i++) {
            var cellId = selCellIds[i];
            var metaVal = metaVec[cellId];
            metaCounts[metaVal] = 1 + (metaCounts[metaVal] || 0);
        }
        var categories = metaInfo.binInfo;
        var catCountIdx = 2;
        if (categories === undefined) {
            categories = metaInfo.valCounts;
            catCountIdx = 1;
        }

        // convert the object to an array (count, percent, value) and sort it by count
        var histoList = [];
        for (var key in metaCounts) {
            let intKey = parseInt(key);
            let count = metaCounts[key];
            let frac = (count / cellCount);
            let fracOfCategory;
            if (categories) {
                let catCellCount = categories[intKey][catCountIdx];
                fracOfCategory = count / catCellCount;
            }
            histoList.push([count, frac, intKey, fracOfCategory]);
        }
        if (metaInfo.type !== "float" && metaInfo.type !== "int") {
            histoList = histoList.sort(function (a, b) { return b[0] - a[0]; }); // reverse-sort by count
        }
        return histoList;
    }

    function updateMetaBarManyCells(cellIds) {
    /* update the meta fields on the left to reflect/summarize a list of cellIds */
        var metaFieldInfos = db.getMetaFields();
        var cellCount = cellIds.length;

        if (db.allMeta===undefined) {
            alert("The meta information has not been loaded yet. Please wait and try again in a few seconds.");
            return;
        }

        $('#tpMetaTitle').text("Meta data of "+cellCount+" "+gSampleDesc+"s");

        // for every field...
        var metaHist = {};
        for (var metaIdx = 0; metaIdx < metaFieldInfos.length; metaIdx++) {
            var metaInfo = metaFieldInfos[metaIdx];

            var metaVec = [];
            if (metaInfo.isCustom)
                metaVec = metaInfo.arr;
            else
                metaVec = db.allMeta[metaInfo.name];

            if (metaVec===undefined) {
                var metaMsg = null;
                if (metaInfo.type!=="uniqueString") {
                    console.log("cellBrowser.js:updateMetaBarManyCells - could not find meta info");
                    metaMsg = "(still loading - please wait and retry)";
                }
                else
                    metaMsg = "(unique identifier field)";
                $('#tpMeta_'+metaIdx).html(metaMsg);
                continue;
            }

            var histoList = makeFieldHistogram(metaInfo, cellIds, metaVec); // reverse-sort by count
            metaHist[metaInfo.name] = histoList;

            // make a quick list of the top values for the sparklines, ignore the rest
            var countList = [];
            var otherCount = 0;
            for (let i=0; i < histoList.length; i++) {
                let count = histoList[i][0];
                if (i<SPARKHISTOCOUNT)
                    countList.push(count);
                else
                    otherCount+=count;
            }
            if (otherCount!==0)
                countList.push(otherCount);

            // update the UI

            var topCount = histoList[0][0];
            var topPerc  = histoList[0][1];
            var topVal   = metaInfo.ui.shortLabels[histoList[0][2]];
            var percStr = (100*topPerc).toFixed(1)+"%";

            if (topVal.length > 14)
                topVal = topVal.substring(0, 14)+"...";

            var label = "";
            if (histoList.length === 1) {
                label = topVal;
            } else {
                // numeric type, calculate mean and sd
                if (metaInfo.origVals && (metaInfo.type === "float" || metaInfo.type === "int")) {
                    var sum = 0;
                    for (var i = 0, I = cellIds.length; i < I; i++) {
                        sum += metaInfo.origVals[cellIds[i]];
                    }
                    var mean = sum / cellIds.length;
                    sum = 0;
                    for (i = 0, I = cellIds.length; i < I; i++) {
                        sum += (metaInfo.origVals[cellIds[i]] - mean)**2;
                    }
                    var sd = Math.sqrt(sum / cellIds.length);
                    label = "<span class='tpMetaMultiVal'>mean = " + mean.toFixed(2) + "; sd = " + sd.toFixed(2) + "</span>";
                } else {
                    if (histoList[0][0] === 1) {
                        label = "<span class='tpMetaMultiVal'>" + histoList.length + " unique values</span>";
                    } else {
                        label = "<span class='tpMetaMultiVal'>" + percStr + " " +topVal+"</span>";
                    }
                }
            }

            $('#tpMeta_' + metaIdx).html(label);
        }
        db.metaHist = metaHist;
    }

    function clearMetaAndGene() {
        /* called when user hovers over nothing - clear the meta and gene field field info, hide the tooltip */
        if (db===null) // users moved the mouse while the db is still loading
            return;

        $('#tpMeta_custom').html("");
        $(".tpMetaValue").html("");

        var fieldCount = db.getMetaFields();
        for (let metaInfo of db.getMetaFields()) {
            $('#tpMeta_'+metaInfo.name).attr('title', "").html("");
        }
        $('#tpMetaNote').hide();
        updateGeneTableColors(null);
    }

    function updateMetaBarCustomFields(cellId) {
        /* update custom meta fields with custom data */
        if (!db.getMetaFields()[0].isCustom)
            return;

        let metaInfo = db.getMetaFields()[0];
        let intVal = metaInfo.arr[cellId];
        let strVal = metaInfo.ui.shortLabels[intVal];
        let rowDiv = $('#tpMeta_custom').html(strVal);
    }

    function updateMetaBarOneCell(cellInfo, otherCellCount) {
        /* update the meta bar with meta data from a single cellId */
        $('#tpMetaTitle').text(METABOXTITLE);

        let customCount = 0;
        if (db.getMetaFields()[0].isCustom)
            customCount = 1;

        let fieldInfos = db.getMetaFields();

        for (var i = 0; i < cellInfo.length; i++) {
            var fieldValue = cellInfo[i];
            let metaIdx = i + customCount;
            let metaInfo = fieldInfos[metaIdx];

            if (i===0) {
                //changeUrl({"cell":fieldValue});
                if (db.traces)
                    plotTrace(fieldValue);
            }

            let rowDiv = $('#tpMeta_'+i);
            if (fieldValue.startsWith("http") && fieldValue.endsWith(".png")) {
                rowDiv.css('height', "40px");
                rowDiv.html("<img src='"+fieldValue+"'></img>");
            } else
                rowDiv.html(fieldValue);
            rowDiv.attr('title', fieldValue);
            rowDiv.attr('data-one-cell', '1');
            gMeta.rows.push( { field : metaInfo.label, value : fieldValue } );
        }
        gMeta.mode="single";

        if (otherCellCount===0)
            $("#tpMetaNote").hide();
        else {
            $("#tpMetaNote").html("...and "+(otherCellCount)+" other "+gSampleDesc+"s underneath");
            $("#tpMetaNote").show();
        }
    }

    function clearSelectionState() {
        /* clear URL variable with select state, called when user clicks cells or unselects them */
        delState("select");
        delState("cell");

        $("#tpHoverHint").show();
        $("#tpSelectHint").hide();

        // clear all checkboxes in the legend
        $(".tpLegendLabel").removeClass("tpLegendSelect");
        $(".tpLegendCheckbox").prop('checked', false);
    }

    function onCellClickOrHover (cellIds, ev) { /* user clicks onto a circle with the mouse or hovers over one.
         * ev is undefined if not a click. cellIds is none if click was on empty background. */

        // do nothing if only hover but something is already selected
        var selCells = renderer.getSelection();
        if (ev===undefined && selCells.length!==0) {
            $("#tpHoverHint").hide();
            $("#tpSelectHint").show();
            return;
            }

        $("#tpHoverHint").show();
        $("#tpSelectHint").hide();

        if (cellIds===null || cellIds.length===0) {
            clearMetaAndGene();
            clearSelectionState();
        } else {
            var cellId = cellIds[0];
            var cellCountBelow = cellIds.length-1;
            updateMetaBarCustomFields(cellId);
            db.loadMetaForCell(cellId, function(ci) { updateMetaBarOneCell(ci, cellCountBelow);}, onProgress);
        }

        updateGeneTableColors(cellIds);

        if (ev===undefined) {
            db.metaHist = null;
        } else {
            // it was a click -> we have at least one cell ID
            let cellId = cellIds[0];
            if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey)
                renderer.selectClear();
            clearSelectionState();
            renderer.selectAdd(cellId);
            renderer.drawDots();
            event.stopPropagation();
        }
    }

    function showTooltip(x, y, labelStr) {
    $("#tpTooltip").css({
        "display":"block",
        "left" : x,
        "top" : y,
       }).html(labelStr);
    }

    function hideTooltip() {
        $("#tpTooltip").hide();
    }

    function onLineHover(lineLabel, ev) {
        if (lineLabel===null)
            hideTooltip();
        else
            showTooltip(ev.clientX+15, ev.clientY, lineLabel);
    }

    function fattenCluster(clusterName) {
    /* highlight one of the clusters */
        let valIdx = legendLabelGetIdx(gLegend, clusterName);
        renderer.fatIdx = valIdx;
        renderer.drawDots();
        let legQuery = "#tpLegend_"+valIdx;
        $(legQuery).addClass("tpLegendHl");
    }

    function resetFattening() {
    /* remove the highlighted cluster */
        if (renderer.fatIdx!==null) {
            $(".tpLegendHl").removeClass("tpLegendHl");
            renderer.fatIdx = null;
            renderer.drawDots();
        }
    }

function onClusterNameHover(clusterName, nameIdx, ev) {
        /* user hovers over cluster label */
        var labelLines = [clusterName];

        var labelField = db.conf.labelField;
        var metaInfo = db.findMetaInfo(labelField);
        var longLabels = metaInfo.ui.longLabels;
        if (longLabels) {
            for (let i=0; i<longLabels.length; i++) {
                let shortLabel = metaInfo.ui.shortLabels[i];
                let longLabel = longLabels[i];
                if (clusterName===shortLabel && longLabel!==shortLabel) {
                    labelLines.push(longLabels[i]);
                    break;
                }
            }
        }

        if (labelField == db.conf.activeLabelField) {
            if (db.conf.topMarkers!==undefined) {
                labelLines.push("Top enriched/depleted markers: "+db.conf.topMarkers[clusterName].join(", "));
            }
            labelLines.push("");

            if (db.conf.markers!==undefined)
                labelLines.push("Click to show full marker gene list.");

            if (db.conf.clusterPngDir!==undefined) {
                var fullPath = cbUtil.joinPaths([db.name, db.conf.clusterPngDir, clusterName+".png"]);
                labelLines.push("<img src='"+fullPath+"'>");
            }
        }

        labelLines.push("Alt/Option-Click to select cells in cluster; Shift-Click to add cluster to selection");
        showTooltip(ev.clientX+15, ev.clientY, labelLines.join("<br>"));

        fattenCluster(clusterName);
    }

    function onNoClusterNameHover(ev) {
        hideTooltip();
        resetFattening();
    }

    function sanitizeName(name) {
        /* ported from cellbrowser.py: remove non-alpha, allow underscores */
        var newName = name.replace(/\+/g, "Plus").replace(/-/g, "Minus").replace(/%/g, "Perc");
        var newName = newName.replace(/[^a-zA-Z_0-9+]/g, "");
        return newName;
    }

    function onlyAlphaNum(name) {
        /* only allow alphanumeric characters */
        var newName = name.replace(/[^a-zA-Z0-9+]/g, "");
        return newName;
    }

    function onActRendChange(otherRend) {
        /* called after the user has activated a view with a click */
        renderer.legend = gLegend;
        renderer = otherRend;
        gLegend = otherRend.legend;
        //$("#tpLayoutCombo").val( otherRend.coordIdx ).trigger('chosen:updated');
        chosenSetValue("tpLayoutCombo", otherRend.coordIdx);
        buildLegendBar();
    }

    function removeSplit(renderer) {
        /* stop split screen mode */
        if (!renderer)
            return;
        if (!renderer.childPlot && !renderer.parentPlot)
            return;
        if (!renderer.isMain) {
            // make sure the left renderer is the active one
            renderer = renderer.childPlot;
            renderer.activatePlot();
        }
        renderer.unsplit();
        $("#tpSplitMenuEntry").text("Split Screen");
        renderer.drawDots();
        $("#tpSplitOnGene").text(splitButtonLabel(true));
    }

    function activateSplit() {
        // nothing is split yet -> start the split
        buildWatermark(renderer);
        renderer.onActiveChange = onActRendChange;

        var currCoordIdx = $("#tpLayoutCombo").val();
        renderer.legend = gLegend;
        renderer.coordIdx = currCoordIdx; // keep for onActRendChange
        renderer.isMain = true;

        let rend2 = renderer.split();
        buildWatermark(rend2);

        //if (gLegend.type==="expr")
            //renderer.childPlot.setWatermark(gLegend.geneSym);

        renderer.childPlot.legend = gLegend;
        renderer.childPlot.coordIdx = currCoordIdx; // keep for onActRendChange

        $("#tpSplitMenuEntry").text("Unsplit Screen");
        $("#mpCloseButton").click( function() { removeSplit(renderer);} );
        $("#tpSplitOnGene").text(splitButtonLabel(false));

    }

    function onSplitClick() {
        /* user clicked on View > Split Screen */
        if (!renderer.childPlot && !renderer.parentPlot) {
            activateSplit();
        } else {
            removeSplit(renderer);
        }
        renderer.drawDots();
    }

    function groupAverages(geneArrs, arrGroups, groupCount) {
        /* given an array of gene expression vectors (ints), and a 2nd array that assigns these to groups,
        return an array of the arrays with the averages for the groups (as integers)
        */
        let geneAvgs = [];

        for (let geneIdx=0; geneIdx < geneArrs.length; geneIdx++) {
            let geneArr = geneArrs[geneIdx];

            let groupSums = new Uint32Array(groupCount);
            let groupCounts = new Uint32Array(groupCount);
            //for (var groupIdx=0; groupIdx < groupCount; groupIdx++) {
            //    groupSums.push(0);
            //    groupCounts.push(0);
            //}

            for (let i=0; i<geneArr.length; i++) {
                let group = arrGroups[i];
                groupSums[group] += geneArr[i];
                groupCounts[group]++;
            }

            let groupAvgs = [];
            for (var groupIdx=0; groupIdx < groupCount; groupIdx++)
            {
                var cellCount = groupCounts[groupIdx];
                var groupAvg = 0;
                if (cellCount!==0)
                    groupAvg = Math.round(groupSums[groupIdx]/cellCount);
                groupAvgs.push(groupAvg);
            }
            geneAvgs.push(groupAvgs);

        }
        return geneAvgs;
    }

    function onHeatCellClick(geneName, clusterName) {
        /* color by gene and select all cells in cluster */
        colorByLocus(geneName);
        // clusterName?
        //selectByColor
    }

    function onHeatCellHover(rowIdx, colIdx, rowName, colName, value, ev) {
        /* user hovers over a cell on the heatmap */
        let htmls = [];
        if (rowName)
            htmls.push(rowName);
        if (colName)
            htmls.push(colName)
        if (value!==null)
            htmls.push(" "+(value*10)+"-"+((value+1)*10)+"%");
        showTooltip(ev.clientX+15, ev.clientY, htmls.join(" "));
    }

    function plotHeatmap(clusterMetaInfo, exprVecs, geneSyms) {
        /* Create the heatmap from exprVecs.
        */
        if (!geneSyms || geneSyms.length===0) {
            alert("No quick genes are defined. Heatmaps currently only work on pre-defined gene sets.");
            return;
        }

        var clusterCount = clusterMetaInfo.valCounts.length;

        var clusterNames = [];
        for (let valInfo of clusterMetaInfo.valCounts) {
            clusterNames.push(valInfo[0]); // 0=name, 1=count
        }

        var clusterArr = clusterMetaInfo.arr;
        var geneAvgs = groupAverages(exprVecs, clusterArr, clusterCount);

        var div = document.createElement("div");
        //let heatHeight = Math.min(150, 16*exprVecs.length);
        let heatHeight = parseInt(renderer.height*0.5);
        div.id = "tpHeat";
        div.style.height = heatHeight+"px";

        renderer.setSize(renderer.getWidth(), renderer.height-heatHeight, true);

        var canvLeft = metaBarWidth+metaBarMargin;
        var heatWidth = window.innerWidth - canvLeft - legendBarWidth;
        // create the div for the heat map view
        div.style.width = heatWidth+"px";
        div.style.left = metaBarWidth+"px";
        div.style.top = (menuBarHeight+toolBarHeight+renderer.height)+"px";
        div.style.position = "absolute";
        document.body.appendChild(div);

        var heatmap = new MaxHeat(div, {mainRenderer:renderer});
        //var colors = getFieldColors(clusterMetaInfo)
        var colors = makeColorPalette(cDefGradPaletteHeat, db.exprBinCount);

        heatmap.loadData(geneSyms, clusterNames, geneAvgs, colors);
        heatmap.draw();
        heatmap.onCellHover = onHeatCellHover;
        heatmap.onClick = onHeatCellClick;
        db.heatmap = heatmap;
    }


    function removeHeatmap() {
        /* remove the heatmap */
        let heatHeight = db.heatmap.height;
        document.getElementById("tpHeat").remove();
        delete db.heatmap;
        renderer.setSize(renderer.getWidth(), renderer.height+heatHeight, true);
        changeUrl({'heat':null});
    }

    function onHeatClick() {
        // TODO: rewrite this one day with promises...
        let resultCount = 0;
        let exprVecs = [];
        let geneSyms = [];
        let metaInfo = null;

        function partDone() {
            resultCount++;
            if (resultCount===2)
                plotHeatmap(metaInfo, exprVecs, geneSyms);
        }

        function onClusterMetaDone(metaArr, metaInfo) {
            metaInfo.arr = metaArr;
            partDone();
        }

        function onGenesDone(geneVecs) {
            /* */
            for (var geneInfo of geneVecs) {
                geneSyms.push(geneInfo[0]); // gene symbol
                exprVecs.push(geneInfo[1]); // binned expression vector
            }
            partDone();
        }

        /* user clicked on View > Heatmap */
        if (db && db.heatmap) {
            removeHeatmap();
        }
        else {
            if (!db.conf.quickGenes) {
                alert("No quick genes defined for this dataset. Heatmaps currently only work if "+
                    "a list of dataset-specific genes is defined. " +
                    "Add a statement quickGenesFile to cellbrowser.conf and put a few gene symbols "+
                    "into the file, one per line.");
                return;
            }
            db.loadGeneSetExpr(onGenesDone);
            metaInfo = getClusterFieldInfo();
            db.loadMetaVec(metaInfo, onClusterMetaDone, onProgress, {}, db.conf.binStrategy);
            changeUrl({"heat":"1"});
        }
    }

    function onClusterNameClick(clusterName, clusterLabel, event) {
        /* build and open the dialog with the marker genes table for a given cluster */
        var metaInfo = getClusterFieldInfo();
        var isNumber = false;
        var nameIdx = null;
        if (metaInfo.type == "int" || metaInfo.type == "float") {
            isNumber = true;
        } else {
            nameIdx = metaInfo.ui.shortLabels.indexOf(clusterName);
        }
        if (event.altKey || event.shiftKey) {
            db.loadMetaVec(metaInfo, function(values) {
                var clusterCells = [];
                for (var i = 0, I = values.length; i < I; i++) {
                    if (isNumber && metaInfo.origVals[i].toFixed(2) == clusterName) {
                        clusterCells.push(i);
                    } else if (!isNumber && values[i] == nameIdx) {
                        clusterCells.push(i);
                    }
                }
                if (event.altKey) {
                    renderer.selectSet(clusterCells);
                } else if (event.shiftKey) {
                    var selection = renderer.getSelection();
                    selection = selection.concat(clusterCells);
                    renderer.selectSet(selection);
                }
                renderer.drawDots();
            });
            return;
        }

        // if current label field does not have markers, do nothing else
        if (metaInfo.name != db.conf.activeLabelField) {
            alert("There are no markers for this field");
            return;
        }

        var tabInfo = db.conf.markers; // list with (label, subdirectory)

        console.log("building marker genes window for "+clusterName);
        var htmls = [];
        htmls.push("<div id='tpPaneHeader' style='padding:0.4em 1em'>");

        var buttons = [];

        if (tabInfo===undefined || tabInfo.length===0) {
            tabInfo = [];
            buttons.push({
                text:"Close",
                click: function() { $( this ).dialog( "close" ) }
            });
            htmls.push("No marker genes are available in this dataset. " +
                "To add marker genes, if this is the cells.ucsc.edu website, contact us (cells@ucsc.edu) and ask us to add cluster markers " +
                "or contact the original authors of the dataset and ask them to send " +
                " us cluster markers.");
        } else {
            htmls.push("Sorted by the column which is highlighted. Click gene symbols below to color plot by gene<br>");
            buttons.push({
                text:"Download as file",
                click: function() {
                    document.location.href = markerTsvUrl;
                }
            });
        }
        htmls.push("</div>");

        var doTabs = (tabInfo.length>1);

        if (doTabs) {
            htmls.push("<div id='tabs'>");
            htmls.push("<ul>");
            for (var tabIdx = 0; tabIdx < tabInfo.length; tabIdx++) {
                var tabLabel = tabInfo[tabIdx].shortLabel;
                htmls.push("<li><a href='#tabs-"+tabIdx+"'>"+tabLabel+"</a>");
            }
            htmls.push("</ul>");
        }

        for (let tabIdx = 0; tabIdx < tabInfo.length; tabIdx++) {
            var divName = "tabs-"+tabIdx;
            var tabDir = tabInfo[tabIdx].name;
            var sanName = sanitizeName(clusterName);
            var markerTsvUrl = cbUtil.joinPaths([db.name, "markers", tabDir, sanName+".tsv.gz"]);
            htmls.push("<div id='"+divName+"'>");
            htmls.push("Loading...");
            htmls.push("</div>");

            loadClusterTsv(markerTsvUrl, loadMarkersFromTsv, divName, clusterName);
        }

        htmls.push("</div>"); // tabs

        var winWidth = window.innerWidth - 0.10*window.innerWidth;
        var winHeight = window.innerHeight - 0.10*window.innerHeight;
        var title = "Cluster markers for &quot;"+clusterName+"&quot;";

        var metaInfo = getClusterFieldInfo();
        if (metaInfo.ui.longLabels) {
            //var nameIdx = cbUtil.findIdxWhereEq(metaInfo.ui.shortLabels, 0, clusterName);
            //var acronyms = db.conf.acronyms;
            //title += " - "+acronyms[clusterName];
            var longLabel = metaInfo.ui.longLabels[nameIdx];
            if (clusterName!==longLabel)
                title += " - "+metaInfo.ui.longLabels[nameIdx];
        }

        //if (acronyms!==undefined && clusterName in acronyms)
            //title += " - "+acronyms[clusterName];
        showDialogBox(htmls, title, {width: winWidth, height:winHeight, "buttons":buttons});
        $(".ui-widget-content").css("padding", "0");
        $("#tabs").tabs();
    }

    function geneListFormat(htmls, s, symbol) {
    /* transform a string in the format dbName|linkId|mouseOver;... to html and push these to the htmls array */
        var dbParts = s.split(";");
        for (var i = 0; i < dbParts.length; i++) {
            var dbPart = dbParts[i];
            var idParts = dbPart.split("|");

            var dbName = idParts[0];
            var linkId = null;
            var mouseOver = "";

            // linkId and mouseOver are optional
            if (idParts.length>1) {
                linkId = idParts[1];
            }
            if (idParts.length>2) {
                mouseOver = idParts[2];
            }

            var dbUrl = dbLinks[dbName];
            if (dbUrl===undefined)
                htmls.push(dbName);
            else {
                if (linkId==="" || linkId===null)
                    linkId = symbol;
                htmls.push("<a target=_blank title='"+mouseOver+"' data-placement='auto left' class='link' href='"+dbUrl+linkId+"'>"+dbName+"</a>");
            }

            if (i!==dbParts.length-1)
                htmls.push(", ");
        }
    }

    function loadMarkersFromTsv(papaResults, url, divId, clusterName) {
        /* construct a table from a marker tsv file and write as html to the DIV with divID */
        console.log("got coordinate TSV rows, parsing...");
        var rows = papaResults.data;

        var headerRow = rows[0];

        var htmls = [];

        var markerListIdx = parseInt(divId.split("-")[1]);
        var markerInfo = db.conf.markers[markerListIdx];
        var selectOnClick = markerInfo.selectOnClick;
        var sortColumn = markerInfo.sortColumn || 1;
        var sortOrder = markerInfo.sortOrder || "asc";
        var sortOrderNum = 0;
        if (sortOrder==="desc")
            sortOrderNum = 1;

        //htmls.push("<table class='table' data-sortlist='[[1,1],[4,0]]' id='tpMarkerTable'>");
        htmls.push("<table class='table' data-sortlist='[["+sortColumn+","+sortOrder+"]]' id='tpMarkerTable'>");
        htmls.push("<thead>");
        var hprdCol = null;
        var geneListCol = null;
        var exprCol = null;
        var pValCol = null
        var doDescSort = false;
        for (var i = 1; i < headerRow.length; i++) {
            var colLabel = headerRow[i];
            var isNumber = false;

            if (colLabel.indexOf('|') > -1) {
                var parts = colLabel.split("|");
                colLabel = parts[0];
                var colType = parts[1];
                if (colType==="int" || colType==="float")
                    isNumber = true;
            }

            var width = null;
            if (colLabel==="_geneLists") {
                colLabel = "Gene Lists";
                geneListCol = i;
            }
            else if (colLabel==="pVal" || /[pP].[Vv]al.*/.test(colLabel)) {
                if (colLabel==="pVal" || colLabel==="p_val" || colLabel==="p-value")
                    colLabel = "P-value";
                pValCol = i-1; // the table displayed does not have the "id" column
                isNumber = true;
                if (i===2)
                    doDescSort = true;
            }
            else if (colLabel==="_expr") {
                colLabel = "Expression";
                exprCol = i-1; // table displayed does not have the "id" column
            }
            else if (colLabel==="_hprdClass") {
                hprdCol = i;
                colLabel = "Protein Class (HPRD)";
                width = "200px";
            }

            var addStr = "";
            if (isNumber)
                //addStr = " data-sort-method='number'";
                addStr = " sorter='number'";
                //addStr = ' class="{sorter: \'number\'}"';

            if (width===null)
                htmls.push("<th"+addStr+">");
            else
                htmls.push("<th style='width:"+width+"'"+addStr+">");
            colLabel = colLabel.replace(/_/g, " ");
            htmls.push(colLabel);
            htmls.push("</th>");
        }
        htmls.push("</thead>");

        var hubUrl = makeHubUrl();

        htmls.push("<tbody>");
        for (let i = 1; i < rows.length; i++) {
            var row = rows[i];
            if ((row.length===1) && row[0]==="") // papaparse sometimes adds empty lines to files
                continue;

            htmls.push("<tr>");
            var geneId = row[0];

            // old marker files still have the format geneId|sym, so tolerate this here
            if (geneId.indexOf("|") > -1)
                geneId = geneId.split("|")[0];

            var geneSym = row[1];
            htmls.push("<td><a data-gene='"+geneId+"' class='link tpLoadGeneLink'>"+geneSym+"</a>");
            if (hubUrl!==null) {
                var fullHubUrl = hubUrl+"&position="+geneSym+"&singleSearch=knownCanonical";
                htmls.push("<a target=_blank class='link' style='margin-left: 10px; font-size:80%; color:#AAA' title='link to UCSC Genome Browser' href='"+fullHubUrl+"'>Genome</a>");
            }
            htmls.push("</td>");

            for (var j = 2; j < row.length; j++) {
                var val = row[j];
                htmls.push("<td>");
                // added for the autism dataset, allows to add mouse overs with images
                // field has to start with ./
                if (val.startsWith("./")) {
                    var imgUrl = val.replace("./", db.url+"/");
                    var imgHtml = '<img width="100px" src="'+imgUrl+'">';
                    val = "<a data-toggle='tooltip' data-placement='auto' class='tpPlots link' target=_blank title='"+imgHtml+"' href='"+ imgUrl + "'>plot</a>";
                }
                if (j===geneListCol || j===exprCol)
                    geneListFormat(htmls, val, geneSym);
                else if (j===pValCol)
                    htmls.push(parseFloat(val).toPrecision(5)); // five digits ought to be enough for everyone
                else
                    //htmls.push(val);
                    geneListFormat(htmls, val, geneSym);
                htmls.push("</td>");
            }
            htmls.push("</tr>");
        }

        htmls.push("</tbody>");
        htmls.push("</table>");

        // sub function ----
        function onMarkerGeneClick(ev) {
            /* user clicks onto a gene in the table of the marker gene dialog window */
            var geneIdOrSym = ev.target.getAttribute("data-gene");

            // old marker tables do not contain the geneIds. For these we need to resolve the symbol to an ID
            if (!db.isAtacMode() && db.geneOffsets[geneIdOrSym]===undefined) {
                var geneIds = db.findGenesExact(geneIdOrSym);
                if (geneIds.length!==1)
                    alert("symbol "+geneIdOrSym+" resolves to more than one geneId. Internal error? Please contact us at cells@ucsc.edu");
                geneIdOrSym = geneIds[0];
            }

            $(".ui-dialog").remove(); // close marker dialog box
            if (selectOnClick) {
                clusterField = db.conf.labelField;
                var queryList = [{'m':clusterField, 'eq':clusterName}];
                findCellsMatchingQueryList(queryList, function(cellIds) {
                        renderer.selectSet(cellIds);
                        //changeUrl({'select':JSON.stringify(queryList)});
                });
            }

            // the marker table historically only contains symbols (this was a mistake)
            // colorByLocus will automatically resolve them to IDs.
            colorByLocus(geneIdOrSym);
        }
        // ----

        $("#"+divId).html(htmls.join(""));
        var sortOpt = {};
        var tableOpt = { sortList: [[pValCol,0]], theme: "bootstrap", widgets : [ "uitheme", "filter", "columns", "zebra" ],
        };
        if (doDescSort)
            tableOpt.sortList[0][1] = 1; // = sort first column descending
        //new Tablesort(document.getElementById('tpMarkerTable'), tableOpt);
        $("#tpMarkerTable").tablesorter(tableOpt);
        //$('#tpMarkerTable').trigger('sorton', tableOpt.sortList); // does not work, though documented
        // this is a pretty bad hack, but I have no idea why the sortList option doesn't work above...
        $("[data-column='1']").trigger("sort"); // this seems to work!
        if (doDescSort)
            $("[data-column='1']").trigger("sort"); // second click...

        $(".tpLoadGeneLink").on("click", onMarkerGeneClick);
        activateTooltip(".link");

        var ttOpt = {"html": true, "animation": false, "delay":{"show":100, "hide":100} };
        $(".tpPlots").bsTooltip(ttOpt);
    }

    var digitTest = /^\d+$/,
        keyBreaker = /([^\[\]]+)|(\[\])/g,
        plus = /\+/g,
        paramTest = /([^?#]*)(#.*)?$/;

    function deparam(params){
    /* https://github.com/jupiterjs/jquerymx/blob/master/lang/string/deparam/deparam.js */
        if(! params || ! paramTest.test(params) ) {
            return {};
        }

        var data = {},
            pairs = params.split('&'),
            current;

        for(var i=0; i < pairs.length; i++){
            current = data;
            var pair = pairs[i].split('=');

            // if we find foo=1+1=2
            if(pair.length !== 2) {
                pair = [pair[0], pair.slice(1).join("=")];
            }

            var key = decodeURIComponent(pair[0].replace(plus, " ")),
                value = decodeURIComponent(pair[1].replace(plus, " ")),
                parts = key.match(keyBreaker);

            for ( var j = 0; j < parts.length - 1; j++ ) {
                var part = parts[j];
                if (!current[part] ) {
                    // if what we are pointing to looks like an array
                    current[part] = digitTest.test(parts[j+1]) || parts[j+1] === "[]" ? [] : {};
                }
                current = current[part];

            }
            var lastPart = parts[parts.length - 1];
            if(lastPart === "[]"){
                current.push(value);
            }else{
                current[lastPart] = value;
            }
        }
        return data;
    }

    function changeUrl(vars, doReset) {
    /* push the variables (object) into the history as the current URL. key=null deletes a variable. 
     * To remove all current URL vars, call with doReset = True
     * */

       // first get the current variables from the URL of the window
       var myUrl = window.location.href;
       myUrl = myUrl.replace("#", "");
       var urlParts = myUrl.split("?");
       var baseUrl = urlParts[0];

       let urlVars;
       if (doReset===undefined || doReset===false) {
           var queryStr = urlParts[1];
           urlVars = deparam(queryStr); // parse key=val&... string to object
       } else {
           urlVars = {}; // ignore all current vars
       }

       // overwrite everthing that we got
       for (var key in vars) {
           var val = vars[key];
           if (val===null || val==="") {
               if (key in urlVars)
                   delete urlVars[key];
            } else
               urlVars[key] = val;
       }

       var argStr = jQuery.param(urlVars); // convert to query-like string
       argStr = argStr.replace(/%20/g, "+");

       var dsName = "noname";
       if (db!==null)
            dsName = db.getName();

       if (argStr.length > 1000)
           warn("Cannot save current changes to the URL, the URL would be too long. "+
               "You can try to shorten some cluster labels to work around the problem temporarily. "+
               "But please contact us at cells@ucsc.edu and tell us about the error. Thanks!");
        else
           history.pushState({}, dsName, baseUrl+"?"+argStr);
    }

    function delVars(varNames) {
        /* remove a CGI variable from the URL */
        var o = {};
        for (var varName of varNames)
            o[varName] = null;
        changeUrl(o);
    }

    function delState(varName) {
        /* remove a CGI variable from the URL */
        var o = {};
        o[varName] = null;
        changeUrl(o);
    }

    function addStateVar(varName, varVal) {
        /* add a CGI variable to the URL */
        var o = {};
        o[varName] = varVal;
        changeUrl(o);
    }

    function getVar(name, defVal) {
        /* get query variable from current URL or default value if undefined */
       var myUrl = window.location.href;
       myUrl = myUrl.split("#")[0]; // remove anchor from URL
       var urlParts = myUrl.split("?");
       var queryStr = urlParts[1];
       var varDict = deparam(queryStr); // parse key=val&... string to object
       if (varDict[name]===undefined)
           return defVal;
       else
           return varDict[name];
    }

    function getVarSafe(name, defVal) {
        let val = getVar(name, defVal);
        if (val)
            val = val.replace(/\W/g, '');
        return val;
    }

    function pushZoomState(zoomRange) {
        /* write the current zoom range to the URL. Null to remove it from the URL. */
       if (zoomRange===null)
            changeUrl({zoom:null});
       else
           changeUrl({zoom:zoomRange.minX.toFixed(5)+"_"+zoomRange.maxX.toFixed(5)+"_"+zoomRange.minY.toFixed(5)+"_"+zoomRange.maxY.toFixed(5)});
    }

    function getZoomRangeFromUrl() {
        /* return a zoomRange object based on current URL */
        var zoomStr = getVar("zoom", null);
        if (zoomStr===null)
            return null;
        var zs = zoomStr.split("_");
        if (zs.length!==4)
            return null;
        var zoomRange = {};
        zoomRange.minX = parseFloat(zs[0]);
        zoomRange.maxX = parseFloat(zs[1]);
        zoomRange.minY = parseFloat(zs[2]);
        zoomRange.maxY = parseFloat(zs[3]);
        return zoomRange;
    }

    function redirectIfSubdomain() {
        /* rewrite the URL if at ucsc and subdomain is specified
         * e.g. autism.cells.ucsc.edu -> cells.ucsc.edu?ds=autism */
        /* we cannot run in the subdomain, as otherwise localStorage and
         * cookies are not shared */

        // at UCSC, the dataset can be part of the hostname
        // we got a "* CNAME" in the campus DNS server for this.
        // it's easier to type, and pretty in manuscripts e.g.
        // autism.cells.ucsc.edu instead of cells.ucsc.edu?ds=autism
        var myUrl = new URL(window.location.href);
        var hostName = myUrl.hostname;
        if (hostName.endsWith("cells.ucsc.edu")) {
            var hostParts = hostName.split(".");
            if (hostParts.length===4) {
                var datasetName = hostParts[0];
                hostParts.shift();
                myUrl.hostname = hostParts.join(".");
                var newUrl = myUrl+"?ds="+datasetName;
                window.location.replace(newUrl);
                return true;
            }
        return false;
        }
    }

    function getDatasetNameFromUrl() {
        /* search for the "ds" parameter or a DNS hostname that indicates the dataset */
        // if ds=xxx was found in the URL, load the respective dataset
        var datasetName = getVar("ds");
        if (datasetName)
            datasetName = datasetName.replace(/ /g, "/"); // + is easier to type than %23

        if (datasetName===undefined)
            datasetName = "";
        // hacks for July 2018 and for backwards compatibility with previous version
        else if (datasetName==="autism10X" || datasetName==="autism10x")
            datasetName = "autism";
        else if (datasetName==="aparna")
            datasetName = "cortex-dev";
        else if (datasetName && datasetName.toLowerCase()==="adultpancreas")
            datasetName = "adultPancreas"
        else
        // adult pancreas is the only dataset with an uppercase letter
        // make sure that at least at UCSC, dataset names are always lowercased.
        // The reason is that at UCSC, the datasetname can be part of the URL as a hostname,
        // e.g. cortex-dev.cells.ucsc.edu, which the user could enter as CoRTex-dev.cells.ucsc.edu
        // On all other servers, this is not an issue
        // (But never do this for subdatasets, because they often include uppercase letters and are not
        // in the URL hostname part)
            if (datasetName && pageAtUcsc() && datasetName.indexOf("/")===-1 )
                datasetName = datasetName.toLowerCase();
        return datasetName;
    }

    /* ==== MAIN ==== ENTRY FUNCTION */
    function main(rootMd5) {
        /* start the data loaders, show first dataset. If in  */
        if (redirectIfSubdomain())
            return;

        setupKeyboard();
        buildMenuBar();

        var datasetName = getDatasetNameFromUrl()
        // pre-load dataset.json here?
        menuBarHeight = $('#tpMenuBar').outerHeight(true);

        var canvLeft = metaBarWidth+metaBarMargin;
        var canvTop  = menuBarHeight+toolBarHeight;
        var canvWidth = window.innerWidth - canvLeft - legendBarWidth;
        var canvHeight = window.innerHeight - menuBarHeight - toolBarHeight;

        if (renderer===null) {
           var div = document.createElement('div');
           div.id = "tpMaxPlot";
           renderer = new MaxPlot(div, canvTop, canvLeft, canvWidth, canvHeight);
           window.renderer = renderer; // XX undo this?

           document.body.appendChild(div);
           activateTooltip(".mpButton"); // tpMaxPlot has no special tooltip support itself
           renderer.activateSliders();

           self.tooltipDiv = makeTooltipCont();
           document.body.appendChild(self.tooltipDiv);
       }

        buildEmptyLegendBar(metaBarWidth+metaBarMargin+renderer.width, toolBarHeight);

        renderer.setupMouse();
        $(window).resize(onWindowResize);

        renderer.onLabelClick = onClusterNameClick;
        renderer.onLabelHover = onClusterNameHover;
        renderer.onNoLabelHover = onNoClusterNameHover;
        renderer.onCellClick = onCellClickOrHover;
        renderer.onCellHover = onCellClickOrHover;
        renderer.onNoCellHover = clearMetaAndGene;
        renderer.onLineHover = onLineHover;
        renderer.onZoom100Click = onZoom100Click;
        renderer.onSelChange = onSelChange;
        renderer.onRadiusAlphaChange = onRadiusAlphaChange;
        renderer.canvas.addEventListener("mouseleave", hideTooltip);

        loadDataset(datasetName, false, rootMd5);
    }

    // only export these functions
    return {
        "main":main
    }

}();



function _tpReset() {
/* for debugging: reset the intro setting */
    localStorage.removeItem("introShown");
}

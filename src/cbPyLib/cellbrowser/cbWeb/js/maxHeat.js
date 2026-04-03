"use strict";
// maxHeat: a simple scatter plot class using canvas. Data has to be binned beforehand.

/* jshint -W097 */ // allow file-wide use strict
/* jshint -W104 */  // allow some es6 parts 

function MaxHeat(div, args) {
    // a class to draw a heatmap with canvas
    // div is a div DOM element under which the canvas will be created
    // TODO: convert to a new-style class?
    var self = this;
 
    var COL_FONT_SIZE = 10; // minimum font size of column labels at the top
    var ROW_FONT_SIZE = 10; // minimum font size of row labels at the left

    var LABEL_MAX_LEN = 25; // max characters shown for labels
    var MIN_EXPR_WIDTH = 3; // minimum width of expression rectangle
    var MIN_ROW_HEIGHT = 4; // minimum height of row
    var META_GAP = 4; // pixel gap between metadata and expression sections

    if (!args)
        args = {};

    //let labelFontSize = args.fontSize || 11; // height of row labels, will decrease with increasing row count
    let drawMode = 2; // 1 = stupid simple, 2 = 2x faster
    var colLabelAngle = 50; // column labels are slanted by 50 degrees

    self.rowLabelWidth = null; // width of the row labels on the left 
    self.colLabelHeight = null; // height of the column label row

    // the rest of the constructor is done at the end of this file,
    // the init involves many functions that are not defined yet

    function transposeMatrix(matrix) {
        /* return the transpose of a 2D array */
        var rowCount = matrix.length;
        var colCount = matrix[0].length;
        var result = [];
        for (var c = 0; c < colCount; c++) {
            var row = new Array(rowCount);
            for (var r = 0; r < rowCount; r++)
                row[r] = matrix[r][c];
            result.push(row);
        }
        return result;
    }

    function truncLabel(s, maxLen) {
        /* truncate s to maxLen chars, replacing the last 3 with "..." if needed */
        if (s.length <= maxLen)
            return s;
        return s.substring(0, maxLen - 3) + "...";
    }

    function clearCanvas(ctx, width, height) {
    /* clear with a white background */
        // jsperf says this is fastest on Chrome, and still OK-ish in FF
        ctx.save();
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
    }

    function addCanvasToDom(self, div, id, conf, width, height) {
        /* add a canvas element under div using the div's width and height */
        //function sepMouseMove(ev)
        //    /* called when the user moves the mouse after they have clicked onto the separator */
        //    /* this seems overly complicated. I tried split.js but it didn't make it a lot easier.
        //     * Isn't there a better plugin to handle resizing ? */
        //    let rect = sep.getBoundingClientRect();
        //    let shiftY = ev.clientY - rect.top;
        //    console.log(shiftY);
        //    sep.style.top = ev.pageY - shiftY + 'px';
        //    console.log(ev);
        //    ev.stopPropagation();
        //    return false;

        let otherRenderer = conf.mainRenderer; // otherRenderer will be resized/redrawn when needed

        // the selection rectangle
        var sel = document.createElement("div");
        sel.id = "hmSel";
        sel.style.position = "absolute";
        sel.style.backgroundColor = "transparent";
        sel.style.boxSizing = "border-box";
        sel.style.border = "1px solid black";
        sel.style.display = "none";
        div.appendChild(sel);
        self.selEl = sel;

        //sep.style.cursor = "row-resize";
        //sep.style.userSelect = "none";
        //sep.style.zIndex = 1000;
        
        //var sep = document.createElement("div");
        //sep.id = "hmSep";
        //sep.style.position = "absolute";
        //var parEl = div.parentElement;
        //sep.style.top = divRect.top+"px";
        //sep.style.left = divRect.left+"px";
        //sep.style.width = width+"px";
        //sep.style.height = "3px";
        //sep.style.backgroundColor = "black";
        //sep.style.cursor = "row-resize";
        //sep.style.userSelect = "none";
        //sep.style.zIndex = 1000;
        //sep.style.backgroundColor = "#BBB";
        //sep.ondragstart = function() { return false; } // disable built-in drag/drop handling
        //sep.onmousedown = function() 
            //document.body.append(sep);
            //document.onmousemove = sepMouseMove;
            //document.onmouseup = function() { document.onmousemove = document.onmouseup = null };
        //document.body.appendChild(sep);

        // toolbar with buttons above the canvas
        if (!self.toolbarEl) {
            var toolbar = document.createElement("div");
            toolbar.id = "hmToolbar";
            toolbar.style.padding = "2px";
            var flipBtn = document.createElement("button");
            flipBtn.textContent = "Flip";
            flipBtn.title = "Swap rows and columns";
            flipBtn.addEventListener("click", function() {
                self.conf.doFlip = !self.conf.doFlip;
                self.reload();
            });
            toolbar.appendChild(flipBtn);
            div.appendChild(toolbar);
            self.toolbarEl = toolbar;
        }

        var canv = document.createElement("canvas");
        //canv.style.width = width+"px";
        //canv.style.height = height+"px";
        canv.id = id;
        canv.style.display = "block";
        canv.style.height = "auto";
        canv.style.width = "auto";
        // No scaling = one unit on screen is one pixel. Essential for speed.
        //canv.width = divRect.width;
        //canv.height = divRect.height;

        // keep these as ints, need them all the time
        //self.width = divRect.width;
        //self.height = divRect.height;
        self.canvas = canv;
        // alpha:false recommended by https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
        self.ctx = self.canvas.getContext("2d", { alpha: false });
        // by default, the canvas background is transparent+black
        // we use alpha=false, so we need to initialize the canvas with white pixels
        self.setSize(width, height);
        self.clear(); // make sure that we clear the canvas before it's added to the DOM, as it's black by default
        div.appendChild(canv); // adds the canvas to the div element

        // handle resizing

        $(div).resizable({
            handles : "n",
            start : function(ev) {
                self.origHeight = self.height;
                self.origOtherHeight = otherRenderer.height;
            },
            resize : function(ev) {
                if (otherRenderer) {
                    var newHeight = self.div.getBoundingClientRect().height;
                    otherRenderer.quickResize(null, self.origOtherHeight + (self.origHeight - newHeight));
                }
                self.setSize(self.width, newHeight);
                self.draw();
            },
            stop : function(ev) {
                if (otherRenderer) {
                    otherRenderer.setSize(null, self.origOtherHeight + (self.origHeight - self.height));
                    otherRenderer.drawDots();
                }
            },
        });

    }

    function evToRowCol(ev) {
        /* given a click or hover event, return hit info object */
        var rect = ev.target.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        var y = ev.clientY - rect.top;

        var result = {};
        result.rowIdx = null;
        result.colIdx = null;
        result.rowName = null;
        result.colName = null;
        result.metaHover = null;

        // determine row from y
        if (y >= self.exprStartY) {
            var ri = parseInt((y - self.exprStartY) / self.rowHeight);
            if (ri >= 0 && ri < self.rowLabels.length) {
                result.rowIdx = ri;
                result.rowName = self.rowLabels[self.rowOrder[ri]];
            }
        }

        // determine column from x
        if (x >= self.exprStartX) {
            var ci = parseInt((x - self.exprStartX) / self.colWidth);
            if (ci >= 0 && ci < self.colLabels.length) {
                result.colIdx = ci;
                result.colName = self.colLabels[self.colOrder[ci]];
            }
        }

        // check for metadata column hover (normal mode)
        if (self.metaColTotalWidth > 0 && x >= self.rowLabelWidth && x < self.exprStartX && result.rowIdx !== null) {
            var metaX = x - self.rowLabelWidth;
            var ss = self.metaColStartsSizes;
            for (var fi = 0; fi < ss.length / 2; fi++) {
                if (metaX >= ss[fi*2] && metaX < ss[fi*2] + ss[fi*2+1]) {
                    var realGi = self.rowOrder[result.rowIdx];
                    result.metaHover = {
                        fieldName: self.metaMatrix.fieldNames[fi],
                        value: self.metaMatrix.metaLabels[realGi][fi],
                        fieldIdx: fi,
                        groupIdx: result.rowIdx
                    };
                    break;
                }
            }
        }

        // check for metadata row hover (flipped mode)
        if (self.metaRowTotalHeight > 0 && y >= self.colLabelHeight && y < self.colLabelHeight + self.metaRowTotalHeight && result.colIdx !== null) {
            var metaY = y - self.colLabelHeight;
            var ss = self.metaRowStartsSizes;
            for (var fi = 0; fi < ss.length / 2; fi++) {
                if (metaY >= ss[fi*2] && metaY < ss[fi*2] + ss[fi*2+1]) {
                    var realGi = self.colOrder[result.colIdx];
                    result.metaHover = {
                        fieldName: self.metaMatrix.fieldNames[fi],
                        value: self.metaMatrix.metaLabels[realGi][fi],
                        fieldIdx: fi,
                        groupIdx: result.colIdx
                    };
                    break;
                }
            }
        }

        // check for gene annotation row hover (normal mode: genes are columns)
        if (self.geneAnnotRowTotalHeight > 0 && y >= self.colLabelHeight && y < self.colLabelHeight + self.geneAnnotRowTotalHeight && result.colIdx !== null) {
            var gaY = y - self.colLabelHeight;
            var ss = self.geneAnnotRowStartsSizes;
            for (var fi = 0; fi < ss.length / 2; fi++) {
                if (gaY >= ss[fi*2] && gaY < ss[fi*2] + ss[fi*2+1]) {
                    var realGi = self.colOrder[result.colIdx];
                    result.metaHover = {
                        fieldName: self.geneAnnotMatrix.fieldNames[fi],
                        value: self.geneAnnotMatrix.annotLabels[realGi][fi],
                        fieldIdx: fi,
                        groupIdx: result.colIdx,
                        isGeneAnnot: true
                    };
                    break;
                }
            }
        }

        // check for gene annotation column hover (flipped mode: genes are rows)
        if (self.geneAnnotColTotalWidth > 0 && x >= self.rowLabelWidth && x < self.rowLabelWidth + self.geneAnnotColTotalWidth && result.rowIdx !== null) {
            var gaX = x - self.rowLabelWidth;
            var ss = self.geneAnnotColStartsSizes;
            for (var fi = 0; fi < ss.length / 2; fi++) {
                if (gaX >= ss[fi*2] && gaX < ss[fi*2] + ss[fi*2+1]) {
                    var realGi = self.rowOrder[result.rowIdx];
                    result.metaHover = {
                        fieldName: self.geneAnnotMatrix.fieldNames[fi],
                        value: self.geneAnnotMatrix.annotLabels[realGi][fi],
                        fieldIdx: fi,
                        groupIdx: result.rowIdx,
                        isGeneAnnot: true
                    };
                    break;
                }
            }
        }

        return result;
    }

    function onClick(ev) {
        /* call self.click(rowName, colName) */
        var hit = evToRowCol(ev);
        if (hit.metaHover) return;
        if (self.onClick)
            self.onClick(hit.rowName, hit.colName);
    }

    function onMouseMove(ev) {
        /* mouse hover functionality */
        var hit = evToRowCol(ev);
        var geneIdx = hit.rowIdx;
        var metaIdx = hit.colIdx;
        var geneName = hit.rowName;
        var metaName = hit.colName;
        var selEl = self.selEl;

        if (hit.metaHover) {
            var mh = hit.metaHover;
            if (mh.isGeneAnnot && self.geneAnnotRowTotalHeight > 0) {
                // normal mode: gene annotations as rows
                var colStart = self.colStartsSizes[mh.groupIdx*2];
                var colW = self.colStartsSizes[mh.groupIdx*2+1];
                var rowStart = self.geneAnnotRowStartsSizes[mh.fieldIdx*2];
                var rowH = self.geneAnnotRowStartsSizes[mh.fieldIdx*2+1];
                selEl.style.top=(self.canvas.offsetTop+self.colLabelHeight+rowStart)+"px";
                selEl.style.left=(self.canvas.offsetLeft+self.exprStartX+colStart)+"px";
                selEl.style.height=rowH+"px";
                selEl.style.width=colW+"px";
            } else if (mh.isGeneAnnot && self.geneAnnotColTotalWidth > 0) {
                // flipped mode: gene annotations as columns
                var rowStart = self.rowStartsSizes[mh.groupIdx*2];
                var rowH = self.rowStartsSizes[mh.groupIdx*2+1];
                var colStart = self.geneAnnotColStartsSizes[mh.fieldIdx*2];
                var colW = self.geneAnnotColStartsSizes[mh.fieldIdx*2+1];
                selEl.style.top=(self.canvas.offsetTop+self.exprStartY+rowStart)+"px";
                selEl.style.left=(self.canvas.offsetLeft+self.rowLabelWidth+colStart)+"px";
                selEl.style.height=rowH+"px";
                selEl.style.width=colW+"px";
            } else if (self.metaColTotalWidth > 0) {
                // normal mode: metadata as columns
                var rowStart = self.rowStartsSizes[mh.groupIdx*2];
                var rowH = self.rowStartsSizes[mh.groupIdx*2+1];
                var colStart = self.metaColStartsSizes[mh.fieldIdx*2];
                var colW = self.metaColStartsSizes[mh.fieldIdx*2+1];
                selEl.style.top=(self.canvas.offsetTop+self.exprStartY+rowStart)+"px";
                selEl.style.left=(self.canvas.offsetLeft+self.rowLabelWidth+colStart)+"px";
                selEl.style.height=rowH+"px";
                selEl.style.width=colW+"px";
            } else {
                // flipped mode: metadata as rows
                var colStart = self.colStartsSizes[mh.groupIdx*2];
                var colW = self.colStartsSizes[mh.groupIdx*2+1];
                var rowStart = self.metaRowStartsSizes[mh.fieldIdx*2];
                var rowH = self.metaRowStartsSizes[mh.fieldIdx*2+1];
                selEl.style.top=(self.canvas.offsetTop+self.colLabelHeight+rowStart)+"px";
                selEl.style.left=(self.canvas.offsetLeft+self.exprStartX+colStart)+"px";
                selEl.style.height=rowH+"px";
                selEl.style.width=colW+"px";
            }
            selEl.style.display="block";
            if (self.onCellHover)
                self.onCellHover(null, null, geneName, metaName, null, null, ev, mh);
            return;
        }

        if (geneIdx===null || metaIdx===null) {
            selEl.style.display="none";
            if (self.onCellHover)
                self.onCellHover(null, null, geneName, metaName, null, null, ev);
            return;
        }

        var rowStart = self.rowStartsSizes[geneIdx*2];
        var rowHeight = self.rowStartsSizes[geneIdx*2+1];
        var colStart = self.colStartsSizes[metaIdx*2];
        var colWidth = self.colStartsSizes[metaIdx*2+1];
        selEl.style.top=(self.canvas.offsetTop+self.exprStartY+rowStart)+"px";
        selEl.style.left=(self.canvas.offsetLeft+self.exprStartX+colStart)+"px";
        selEl.style.height=rowHeight+"px";
        selEl.style.width=colWidth+"px";
        selEl.style.display="block";
        var value = self.exprValues[geneIdx][metaIdx];
        var rowExtra = self.rowExtraInfo ? self.rowExtraInfo[geneIdx] : null;

        if (metaName==="")
            metaName = "(empty)";

        if (self.onCellHover)
            self.onCellHover(self.rowOrder[geneIdx], self.colOrder[metaIdx], geneName, metaName, value, rowExtra, ev);
    }

    this.initDrawing = function (div, opts) {
        /* initialize a new plot */
        self.div = div;
        self.conf = opts;
    };

    this.setPalette = function(palette) {
        self.palette = palette;
        if (self.palette.length!==this.maxVal)
            alert("internal error heat map: palette has incorrect length");
    };

    this.calcRectBoundaries= function() {
        /* calculate the row and column sizes. They're not all the same, due to half pixels */
        var rowCount = self.rowLabels.length;
        var colCount = self.colLabels.length;
        self.rowStartsSizes = makeIntRanges(self.height-self.exprStartY, rowCount);
        self.colStartsSizes = makeIntRanges(self.width-self.exprStartX, colCount);
    }

    this.setSize = function(width, height) {
        /* change size of canvas and div and keep in object */

        self.width = width;
        self.height = height;
        self.canvas.width = width;
        self.canvas.height = height;
        //self.canvas.style.width = width+"px";
        //self.canvas.style.height = height+"px";

        if (self.rowLabels)
            self.calcRectBoundaries();

    };

    this.reload = function() {
        /* tear down the old canvas and re-run loadData with the original data */
        var saved = self._origArgs;
        var onHover = self.onCellHover;
        var onClk = self.onClick;
        if (self.canvas) {
            self.canvas.remove();
            self.canvas = null;
        }
        if (self.selEl) {
            self.selEl.remove();
            self.selEl = null;
        }
        self.loadData(saved.geneNames, saved.metaNames, saved.palette,
            saved.exprBins, saved.exprValues, saved.geneExtraInfo, self.conf, saved.metaMatrix, saved.geneAnnotMatrix);
        self.onCellHover = onHover;
        self.onClick = onClk;
        self.draw();
    };

    this.loadData = function(geneNames, metaNames, palette, exprBins, exprValues, geneExtraInfo, conf, metaMatrix, geneAnnotMatrix) {
        /* load data into object, geneOrder and colOrder are optional.
           exprBins is an array of array of integers, indices into palette.
           exprValues is array of array of floats, the actual values, shown on mouse over
        */
        // store original args so reload() can re-call loadData after flipping
        self._origArgs = {
            geneNames: geneNames, metaNames: metaNames, palette: palette,
            exprBins: exprBins, exprValues: exprValues, geneExtraInfo: geneExtraInfo,
            metaMatrix: metaMatrix, geneAnnotMatrix: geneAnnotMatrix
        };

        self.colLabels = metaNames;
        self.rowLabels = geneNames;
        self.metaMatrix = metaMatrix || null;
        self.geneAnnotMatrix = geneAnnotMatrix || null;

        if (conf)
            self.conf = conf;
        else
            self.conf = {};

        if (self.conf.doFlip) {
            var tmp = self.colLabels;
            self.colLabels = self.rowLabels;
            self.rowLabels = tmp;
            exprBins = transposeMatrix(exprBins);
            exprValues = transposeMatrix(exprValues);
            geneExtraInfo = null;
        }

        self.rowFontSize = ROW_FONT_SIZE;
        self.colFontSize = COL_FONT_SIZE;

        // include metadata/geneAnnot field names in label dimension calculations
        var colLabelsForDim = self.colLabels;
        var rowLabelsForDim = self.rowLabels;
        if (self.metaMatrix) {
            if (!self.conf.doFlip)
                colLabelsForDim = self.metaMatrix.fieldNames.concat(colLabelsForDim);
            else
                rowLabelsForDim = self.metaMatrix.fieldNames.concat(rowLabelsForDim);
        }
        if (self.geneAnnotMatrix) {
            // geneAnnot labels go on the opposite axis from metaMatrix:
            // normal mode: geneAnnot field names are horizontal row labels
            // flipped mode: geneAnnot field names are rotated column labels
            if (!self.conf.doFlip)
                rowLabelsForDim = self.geneAnnotMatrix.fieldNames.concat(rowLabelsForDim);
            else
                colLabelsForDim = self.geneAnnotMatrix.fieldNames.concat(colLabelsForDim);
        }

        // calc the size of the canvas, can be bigger than screen
        self.colLabelHeight = self.textBoxDim("height", LABEL_MAX_LEN, self.colFontSize, colLabelsForDim, true);
        self.rowLabelWidth = self.textBoxDim("width", LABEL_MAX_LEN, self.rowFontSize, rowLabelsForDim);

        // metadata layout dimensions (annotates groups axis)
        self.metaColTotalWidth = 0;
        self.metaRowTotalHeight = 0;
        self.metaColStartsSizes = null;
        self.metaRowStartsSizes = null;

        if (self.metaMatrix && !self.conf.doFlip) {
            var fieldCount = self.metaMatrix.fieldNames.length;
            var minColW = 8 + self.textBoxDim("width", LABEL_MAX_LEN, COL_FONT_SIZE, ["M"], true);
            self.metaSingleColWidth = minColW;
            self.metaColTotalWidth = fieldCount * minColW + META_GAP;
        } else if (self.metaMatrix && self.conf.doFlip) {
            var fieldCount = self.metaMatrix.fieldNames.length;
            var fontH = 3 + self.textBoxDim("height", LABEL_MAX_LEN, ROW_FONT_SIZE, ["M"]);
            self.metaSingleRowHeight = fontH;
            self.metaRowTotalHeight = fieldCount * fontH + META_GAP;
        }

        // gene annotation layout dimensions (annotates genes axis)
        self.geneAnnotColTotalWidth = 0;
        self.geneAnnotRowTotalHeight = 0;
        self.geneAnnotColStartsSizes = null;
        self.geneAnnotRowStartsSizes = null;

        if (self.geneAnnotMatrix && !self.conf.doFlip) {
            // normal mode: genes are columns, geneAnnot shown as rows
            var fieldCount = self.geneAnnotMatrix.fieldNames.length;
            var fontH = 3 + self.textBoxDim("height", LABEL_MAX_LEN, ROW_FONT_SIZE, ["M"]);
            self.geneAnnotSingleRowHeight = fontH;
            self.geneAnnotRowTotalHeight = fieldCount * fontH + META_GAP;
        } else if (self.geneAnnotMatrix && self.conf.doFlip) {
            // flipped mode: genes are rows, geneAnnot shown as columns
            var fieldCount = self.geneAnnotMatrix.fieldNames.length;
            var minColW = 8 + self.textBoxDim("width", LABEL_MAX_LEN, COL_FONT_SIZE, ["M"], true);
            self.geneAnnotSingleColWidth = minColW;
            self.geneAnnotColTotalWidth = fieldCount * minColW + META_GAP;
        }

        self.exprStartX = self.rowLabelWidth + self.metaColTotalWidth + self.geneAnnotColTotalWidth;
        self.exprStartY = self.colLabelHeight + self.metaRowTotalHeight + self.geneAnnotRowTotalHeight;

        var divRect = div.getBoundingClientRect();
        var screenWidth = divRect.width;
        var screenHeight = divRect.height;

        var canvWidth, canvHeight;

        let minColLabelWidth = 8 + self.textBoxDim("width", LABEL_MAX_LEN, COL_FONT_SIZE, ["M"], true);
        var needWidth = self.exprStartX + (minColLabelWidth * self.colLabels.length);
        if (needWidth < screenWidth)
            canvWidth = screenWidth;
        else
            canvWidth = needWidth;

        let fontHeightPx = 3 + self.textBoxDim("height", LABEL_MAX_LEN, ROW_FONT_SIZE, ["M"]);
        var needHeight = self.exprStartY + (fontHeightPx * self.rowLabels.length);
        if (needHeight < screenHeight)
            canvHeight = screenHeight;
        else
            canvHeight = needHeight;

        addCanvasToDom(self, div, "mhCanvas", conf, canvWidth, canvHeight);

        self.rowHeight = (canvHeight - self.exprStartY) / self.rowLabels.length;
        self.colWidth = (canvWidth - self.exprStartX) / self.colLabels.length;

        // load the data and check it
        self.maxVal = palette.length; // maximum value that ever appears in 'rows'. The minimum is 0.
        self.rows = exprBins;
        self.exprValues = exprValues;
        self.rowExtraInfo = geneExtraInfo;
        self.checkData();

        self.setPalette(palette);

        self.calcRectBoundaries();

        // metadata boundary arrays
        if (self.metaColTotalWidth > 0) {
            var fc = self.metaMatrix.fieldNames.length;
            self.metaColStartsSizes = makeIntRanges(self.metaColTotalWidth - META_GAP, fc);
        }
        if (self.metaRowTotalHeight > 0) {
            var fc = self.metaMatrix.fieldNames.length;
            self.metaRowStartsSizes = makeIntRanges(self.metaRowTotalHeight - META_GAP, fc);
        }

        // gene annotation boundary arrays
        if (self.geneAnnotRowTotalHeight > 0) {
            var fc = self.geneAnnotMatrix.fieldNames.length;
            self.geneAnnotRowStartsSizes = makeIntRanges(self.geneAnnotRowTotalHeight - META_GAP, fc);
        }
        if (self.geneAnnotColTotalWidth > 0) {
            var fc = self.geneAnnotMatrix.fieldNames.length;
            self.geneAnnotColStartsSizes = makeIntRanges(self.geneAnnotColTotalWidth - META_GAP, fc);
        }

        if (self.conf.order==="optLeaf")
            self.orderOptimalLeaf();
        else
            self.orderDefault();

        self.onCellHover = null; // called on cell hover, arg: rowIdx, colIdx, ev.
        // all other object variables are added by the "loadData(args)" function below
        self.canvas.addEventListener("mousemove", onMouseMove);
        self.canvas.addEventListener("click", onClick);

    };

    function makeIntRanges(max, count) {
        /* given a max and a count, create count roughly equally sized bins from 0 to max, but as integers */
        /* The sizes all sum up to max, but every bin is not exactly the same, due to fractions e.g. for
        /* (max=10, count=3) returns [3,7,9] */
        var binSize = max/count;
        var startSizes = [];
        for (var i=0; i<count; i++) {
            var start = Math.round(i*binSize);
            var end = Math.round((i+1)*binSize);
            startSizes.push(start);
            startSizes.push(end-start);
        }
        return startSizes;
    }

    function drawRectsOpt1(ctx, rowStartsSizes, colStartsSizes, exprData, pal, maxVal, geneOrder, metaOrder) {
        /* an implementation of the rectangle drawing that reduces context switches */
        // array index -> target array of x,y coords in heatmap
        // x,y positions are located at (i,i+1)
        var rowCount = rowStartsSizes.length/2;
        var colCount = colStartsSizes.length/2;
        
        // group all rectangles of the same color together
        var valToCoords = [];
        for (var i=0; i<maxVal+1; i++) // why +1 ? Because of float rounding edge cases. Easier like this than to understand the code. :-)
            valToCoords.push([]);
        
        // convert from exprData (array of arrays) to arrays of coords, one array per color
        for (var geneIdx=0; geneIdx<rowCount; geneIdx++) {
            var realGeneIdx = geneOrder[geneIdx];
            var metaBins = exprData[realGeneIdx];
            for (var metaIdx=0; metaIdx < colCount; metaIdx++) {
                var realMetaIdx = metaOrder[metaIdx];
                var val = metaBins[realMetaIdx];

                var valArr = valToCoords[val];
                valArr.push(geneIdx);
                valArr.push(metaIdx); 
            }
        }

        // plot the arrays, one color at a time
        for (var valI=0; valI < maxVal; valI++) {
            ctx.fillStyle = "#"+pal[valI];
            var coords = valToCoords[valI];
            for (i=0; i<coords.length/2; i++) {
                var startIdx = 2*i;
                var rowIdx = coords[startIdx];
                var colIdx = coords[startIdx+1];
                var rowStart = rowStartsSizes[rowIdx*2];
                var rowSize  = rowStartsSizes[rowIdx*2+1];
                var colStart = colStartsSizes[colIdx*2];
                var colSize = colStartsSizes[colIdx*2+1];
                ctx.fillRect(self.exprStartX+colStart, self.exprStartY+rowStart, colSize, rowSize);
            }
        }
    }

    function drawMetaCols(ctx) {
        /* draw metadata annotation columns (normal/not-flipped mode) */
        var mm = self.metaMatrix;
        if (!mm) return;

        var fieldNames = mm.fieldNames;
        var metaBins = mm.metaBins;
        var palettes = mm.palettes;
        var fieldCount = fieldNames.length;
        var rowOrder = self.rowOrder;
        var rowSS = self.rowStartsSizes;
        var metaColSS = self.metaColStartsSizes;
        var groupCount = self.rowLabels.length;

        // draw rotated column labels for metadata fields
        if (self.colLabelHeight > 5) {
            ctx.font = self.colFontSize + "px sans-serif";
            var colLabelRot = -colLabelAngle * Math.PI / 180;
            for (var fi = 0; fi < fieldCount; fi++) {
                var colStart = metaColSS[fi*2];
                var colW = metaColSS[fi*2+1];
                ctx.save();
                ctx.translate(self.rowLabelWidth + colStart + (0.3*colW), self.colLabelHeight);
                ctx.rotate(colLabelRot);
                ctx.fillText(truncLabel(fieldNames[fi], LABEL_MAX_LEN), 0, 0);
                ctx.restore();
            }
        }

        // draw colored rectangles, grouped by color per field
        for (var fi = 0; fi < fieldCount; fi++) {
            var fieldPal = palettes[fi];
            var colStart = metaColSS[fi*2];
            var colW = metaColSS[fi*2+1];

            var valToRows = {};
            for (var gi = 0; gi < groupCount; gi++) {
                var realGi = rowOrder[gi];
                var val = metaBins[realGi][fi];
                if (!(val in valToRows)) valToRows[val] = [];
                valToRows[val].push(gi);
            }

            for (var val in valToRows) {
                ctx.fillStyle = "#" + fieldPal[val];
                var rows = valToRows[val];
                for (var ri = 0; ri < rows.length; ri++) {
                    var gi = rows[ri];
                    ctx.fillRect(self.rowLabelWidth + colStart, self.exprStartY + rowSS[gi*2], colW, rowSS[gi*2+1]);
                }
            }
        }
    }

    function drawMetaRows(ctx) {
        /* draw metadata annotation rows (flipped mode) */
        var mm = self.metaMatrix;
        if (!mm) return;

        var fieldNames = mm.fieldNames;
        var metaBins = mm.metaBins;
        var palettes = mm.palettes;
        var fieldCount = fieldNames.length;
        var colOrder = self.colOrder;
        var colSS = self.colStartsSizes;
        var metaRowSS = self.metaRowStartsSizes;
        var groupCount = self.colLabels.length;

        // draw horizontal row labels for metadata fields
        ctx.font = self.rowFontSize + "px sans-serif";
        for (var fi = 0; fi < fieldCount; fi++) {
            var rowStart = metaRowSS[fi*2];
            var rowH = metaRowSS[fi*2+1];
            var textY = self.colLabelHeight + rowStart + (rowH + self.rowFontSize) / 2 - 2;
            ctx.fillText(truncLabel(fieldNames[fi], LABEL_MAX_LEN), 4, textY);
        }

        // draw colored rectangles, grouped by color per field
        for (var fi = 0; fi < fieldCount; fi++) {
            var fieldPal = palettes[fi];
            var rowStart = metaRowSS[fi*2];
            var rowH = metaRowSS[fi*2+1];

            var valToCols = {};
            for (var gi = 0; gi < groupCount; gi++) {
                var realGi = colOrder[gi];
                var val = metaBins[realGi][fi];
                if (!(val in valToCols)) valToCols[val] = [];
                valToCols[val].push(gi);
            }

            for (var val in valToCols) {
                ctx.fillStyle = "#" + fieldPal[val];
                var cols = valToCols[val];
                for (var ci = 0; ci < cols.length; ci++) {
                    var gi = cols[ci];
                    ctx.fillRect(self.exprStartX + colSS[gi*2], self.colLabelHeight + rowStart, colSS[gi*2+1], rowH);
                }
            }
        }
    }

    function drawGeneAnnotRows(ctx) {
        /* draw gene annotation rows (normal/not-flipped mode: genes are columns) */
        var gam = self.geneAnnotMatrix;
        if (!gam) return;

        var fieldNames = gam.fieldNames;
        var annotBins = gam.annotBins;
        var palettes = gam.palettes;
        var fieldCount = fieldNames.length;
        var colOrder = self.colOrder;
        var colSS = self.colStartsSizes;
        var gaRowSS = self.geneAnnotRowStartsSizes;
        var geneCount = self.colLabels.length;

        // draw horizontal row labels for annotation fields
        ctx.font = self.rowFontSize + "px sans-serif";
        for (var fi = 0; fi < fieldCount; fi++) {
            var rowStart = gaRowSS[fi*2];
            var rowH = gaRowSS[fi*2+1];
            var textY = self.colLabelHeight + rowStart + (rowH + self.rowFontSize) / 2 - 2;
            ctx.fillText(truncLabel(fieldNames[fi], LABEL_MAX_LEN), 4, textY);
        }

        // draw colored rectangles, grouped by color per field
        for (var fi = 0; fi < fieldCount; fi++) {
            var fieldPal = palettes[fi];
            var rowStart = gaRowSS[fi*2];
            var rowH = gaRowSS[fi*2+1];

            var valToCols = {};
            for (var gi = 0; gi < geneCount; gi++) {
                var realGi = colOrder[gi];
                var val = annotBins[realGi][fi];
                if (!(val in valToCols)) valToCols[val] = [];
                valToCols[val].push(gi);
            }

            for (var val in valToCols) {
                ctx.fillStyle = "#" + fieldPal[val];
                var cols = valToCols[val];
                for (var ci = 0; ci < cols.length; ci++) {
                    var gi = cols[ci];
                    ctx.fillRect(self.exprStartX + colSS[gi*2], self.colLabelHeight + rowStart, colSS[gi*2+1], rowH);
                }
            }
        }
    }

    function drawGeneAnnotCols(ctx) {
        /* draw gene annotation columns (flipped mode: genes are rows) */
        var gam = self.geneAnnotMatrix;
        if (!gam) return;

        var fieldNames = gam.fieldNames;
        var annotBins = gam.annotBins;
        var palettes = gam.palettes;
        var fieldCount = fieldNames.length;
        var rowOrder = self.rowOrder;
        var rowSS = self.rowStartsSizes;
        var gaColSS = self.geneAnnotColStartsSizes;
        var geneCount = self.rowLabels.length;

        // draw rotated column labels for annotation fields
        if (self.colLabelHeight > 5) {
            ctx.font = self.colFontSize + "px sans-serif";
            var colLabelRot = -colLabelAngle * Math.PI / 180;
            for (var fi = 0; fi < fieldCount; fi++) {
                var colStart = gaColSS[fi*2];
                var colW = gaColSS[fi*2+1];
                ctx.save();
                ctx.translate(self.rowLabelWidth + colStart + (0.3*colW), self.colLabelHeight);
                ctx.rotate(colLabelRot);
                ctx.fillText(truncLabel(fieldNames[fi], LABEL_MAX_LEN), 0, 0);
                ctx.restore();
            }
        }

        // draw colored rectangles, grouped by color per field
        for (var fi = 0; fi < fieldCount; fi++) {
            var fieldPal = palettes[fi];
            var colStart = gaColSS[fi*2];
            var colW = gaColSS[fi*2+1];

            var valToRows = {};
            for (var gi = 0; gi < geneCount; gi++) {
                var realGi = rowOrder[gi];
                var val = annotBins[realGi][fi];
                if (!(val in valToRows)) valToRows[val] = [];
                valToRows[val].push(gi);
            }

            for (var val in valToRows) {
                ctx.fillStyle = "#" + fieldPal[val];
                var rows = valToRows[val];
                for (var ri = 0; ri < rows.length; ri++) {
                    var gi = rows[ri];
                    ctx.fillRect(self.rowLabelWidth + colStart, self.exprStartY + rowSS[gi*2], colW, rowSS[gi*2+1]);
                }
            }
        }
    }

    this.textBoxDim = function(dimType, maxLen, fontHeight, labels, doAngle) {
        /* return width or height of text on canvas in pixels. return max width by default. 
         * if doHeightAngle is true, will return height at an angle. Cut off everything > maxLen chars */
        var canv = document.createElement("canvas");
        var ctx = canv.getContext("2d", {"alpha":false});
        ctx.font = fontHeight+"px sans-serif";
        
	let doHeight = true;
	if (dimType==="width")
	    doHeight = false;

        // determine the max size of the labels
        let maxVal = null;
        for (let label of labels) {
            const m = ctx.measureText(truncLabel(label, maxLen));
            if (doHeight) {
                if (doAngle) {
                    const w = m.width;
                    const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
                    const cos = Math.cos(colLabelAngle * Math.PI / 180);
                    const sin = Math.sin(colLabelAngle * Math.PI / 180);
                    const height = Math.abs(w * sin) + Math.abs(h * cos);
                    maxVal = Math.max(Math.ceil(height), maxVal || 0);
                } else {
                    const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
                    maxVal = Math.max(Math.ceil(h), maxVal || 0);
                }
            } else {// width
		if (doAngle) {
		    const w = m.width;
		    const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
		    const cos = Math.cos(colLabelAngle * Math.PI / 180);
		    const sin = Math.sin(colLabelAngle * Math.PI / 180);
		    const width = Math.abs(w * cos) + Math.abs(h * sin);
		    maxVal = Math.max(Math.ceil(width), maxVal || 0);
		} else {
		    maxVal = Math.max(Math.ceil(m.width), maxVal || 0);
		}
            }
        }
        return maxVal
    }

    this.draw = function() {
        /* draw the labels and expression rectangles */

        console.log("colLabelHeight=", self.colLabelHeight, "colLabels=", self.colLabels);

        this.clear();

        var pal = self.palette;
        var rows = self.rows;
        var rowHeight = self.rowHeight;
        var colWidth = self.colWidth;
        var rowCount = self.rowLabels.length;
        var colCount = self.colLabels.length;

        var colStartsSizes = self.colStartsSizes;
        var rowStartsSizes = self.rowStartsSizes;
        var rowOrder = self.rowOrder;
        var colOrder = self.colOrder;

        var ctx = self.ctx;
        ctx.save();

        // draw expression row labels
        if (rowHeight>4) {
            var rowFontSize = self.rowFontSize;
            let rowEndToTextBase = (rowHeight - rowFontSize)/2;
            ctx.font = rowFontSize+"px sans-serif";
            console.time("rowLabelsDraw");
            var rowLabels = self.rowLabels;
            for (var labelI=0; labelI < rowCount; labelI++) {
                var realLabelI = rowOrder[labelI];
                var textY = parseInt(self.exprStartY+(labelI*rowHeight) + rowEndToTextBase + rowFontSize - (0.2*rowHeight));
                ctx.fillText(rowLabels[realLabelI], 4, textY);
            }
            console.timeEnd("rowLabelsDraw");
        }

        // draw expression column labels
        if (self.colLabelHeight>5) {
            var colFontSize = self.colLabelFontSize;
            ctx.font = colFontSize+"px sans-serif";
            console.time("colLabelsDraw");
            let colLabels = self.colLabels;
            let colLabelRot = -colLabelAngle * Math.PI / 180;
            for (var labelI=0; labelI<colCount; labelI++) {
                let realLabelI = colOrder[labelI];
                let startIdx = 2*labelI;
                let textX = self.exprStartX+colStartsSizes[startIdx];
                let rowWidth = colStartsSizes[startIdx+1];
                ctx.save();
                ctx.translate(textX+(0.3*rowWidth), self.colLabelHeight);
                ctx.rotate(colLabelRot);
                ctx.fillText(truncLabel(colLabels[realLabelI], LABEL_MAX_LEN), 0, 0);
                ctx.restore();
            }
            console.timeEnd("colLabelsDraw");
        }

        // draw metadata annotations (annotates groups axis)
        if (self.metaMatrix) {
            if (self.metaColTotalWidth > 0)
                drawMetaCols(ctx);
            else if (self.metaRowTotalHeight > 0)
                drawMetaRows(ctx);
        }

        // draw gene annotations (annotates genes axis)
        if (self.geneAnnotMatrix) {
            if (self.geneAnnotRowTotalHeight > 0)
                drawGeneAnnotRows(ctx);
            else if (self.geneAnnotColTotalWidth > 0)
                drawGeneAnnotCols(ctx);
        }

        // draw expression rectangles
        var rowStartsSizes = self.rowStartsSizes;
        var colStartsSizes = self.colStartsSizes;

        console.time("draw rects");
        drawRectsOpt1(ctx, rowStartsSizes, colStartsSizes, rows, pal, self.maxVal,
                self.rowOrder, self.colOrder);
        console.timeEnd("draw rects");

        ctx.restore();
    };

    this.orderDefault = function () {
        /* set the order of rows to the default order from the file, just fill with 0...n */
        let metaCount = self.rows[0].length;
        let metaOrder = [];
        for (var metaIdx=0; metaIdx < metaCount; metaIdx++) {
            metaOrder[metaIdx] = metaIdx;
        }
        self.colOrder = metaOrder;

        let geneCount = self.rows.length;
        let geneOrder = [];
        for (var geneIdx=0; geneIdx < geneCount; geneIdx++) {
            geneOrder[geneIdx] = geneIdx;
        }
        self.rowOrder = geneOrder;
    }

    this.orderOptimalLeaf = function () {
        /* order rows and columns with the optimalLeaf algorithm */
        console.time("heatmap optimal leaf ordering");
         if (self.rows.length == 1) { // if there's just one row, fudge the ordering
        } else {
            let orderFunc = reorder.optimal_leaf_order();
            self.rowOrder = orderFunc(self.rows);
            let cols = reorder.transpose(self.rows);
            self.colOrder = orderFunc(cols);
        }

        console.timeEnd("heatmap optimal leaf ordering");
    };

    this.loadRandomData = function(rowCount, colCount, maxVal) {
        var rows = [];
        var rowLabels = [];
        for (var rowIdx=0; rowIdx < rowCount; rowIdx++) {
            var row = [];
            rowLabels.push( Math.random().toString(36).substring(7) );
            for (var colIdx=0; colIdx < colCount; colIdx++) {
                var val = Math.floor(Math.random() * Math.floor(maxVal));
                row.push(val);
            }
            rows.push(row);
        }

        var colLabels = [];
        for (var i=0; i < colCount; i++) {
            var rndString = Math.random().toString(36).substring(7);
            colLabels.push(rndString);
        }
        self.rows = rows;
        self.colLabels = colLabels;
        self.rowLabels = rowLabels;
        self.maxVal = maxVal;
        self.checkData();
    };

    this.checkData = function() {
        if (self.colLabels.length > self.width - self.exprStartX)
            alert("You are trying to show more columns on the heatmap than the window has pixels. "+
                "The heatmap will not be very useful until you reduce the number of columns that are shown.");
        if (self.rowLabels.length > self.height - self.exprStartY)
            alert("You are trying to show more rows on the heatmap than the window has pixels. "+
                "The heatmap will not be very useful until you reduce the number of rows that are shown.");

    };

    this.clear = function() {
        clearCanvas(self.ctx, self.width, self.height);
    };

    // constructor
    self.initDrawing(div, args);
}

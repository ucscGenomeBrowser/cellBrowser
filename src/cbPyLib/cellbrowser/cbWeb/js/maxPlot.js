'use strict';
// maxPlot: a fast scatter plot class
/*jshint globalstrict: true*/
/*jshint -W069 */
/*jshint -W104 */
/*jshint -W117 */

// TODO:
// fix mouseout into body -> marquee stays

function getAttr(obj, attrName, def) {
    var val = obj[attrName];
    if (val===undefined)
        return def;
    else
        return val;
}

function cloneObj(d) {
/* returns a deep copy of an object, wasteful and destroys old references */
    // see http://stackoverflow.com/questions/122102/what-is-the-most-efficient-way-to-deep-clone-an-object-in-javascript
    return JSON.parse(JSON.stringify(d));
}

function isValid(x) {
    /* x is not null nor undefined */
    return (x!==null && x!==undefined)
}

function cloneArray(a) {
/* returns a copy of an array */
    return a.slice();
}

function copyObj(src, trg) {
/* object copying: copies all values from src to trg */
    var key;
    for (key in src) {
        trg[key] = src[key]; // copies each property to the objCopy object
  }
}

function debug(msg) {
    if (window.doDebug)
        console.log(msg);
}

function MaxPlot(div, top, left, width, height, args) {
    // a class that draws circles onto a canvas, like a scatter plot
    // div is a div DOM element under which the canvas will be created
    // top, left: position in pixels, integers
    // width and height: integers, in pixels, includes the status line

    const HIDCOORD = 12345; // magic value for missing coordinates
      // In rare instances, coordinates are saved but should not be shown. This way of implementing hiding
      // may look hacky, but it simplifies the logic and improves performance.

    // export this special value so other part of the code can use it
    this.hiddenCoord = HIDCOORD;

    var self = this; // 'this' has two conflicting meanings in javascript.
    // I use 'self' to refer to object variables, so I can use 'this' to refer to the caller context

    const gTextSize = 16; // size of cluster labels
    const gTitleSize = 18; // size of title text
    const gStatusHeight = 14; // height of status bar
    const gSliderFromBottom = 45; // distance from buttom to top of slider div
    const gZoomButtonSize = 30; // size of zoom buttons
    const gZoomFromLeft = 10;  // position of zoom buttons from left
    const gZoomFromBottom = 140;  // position of zoom buttons from bottom
    const gButtonBackground = "rgb(230, 230, 230, 0.85)" // grey level of buttons
    const gButtonBackgroundClicked = "rgb(180, 180, 180, 0.6)"; // grey of buttons when clicked
    const gCloseButtonFromRight = 60; // distance of "close" button from right edge

    const nonFatColor = "F9F9F9"; // color used in fattening mode for all non-fat cells
    const nonFatColorRect = "DDDDDD"; // rectangle mode: color used in fattening mode for all non-fat cells
    const nonFatColorCircles = "BBBBBB"; // color used in fattening mode for all non-fat cell circles

    // the rest of the initialization is done at the end of this file,
    // because the init involves many functions that are not defined yet here

    this.initCanvas = function (div, top, left, width, height, args) {
        /* initialize a new Canvas */

        div.style.top = top+"px";
        div.style.left = left+"px";
        div.style.position = "absolute";
        div.style.display = "block";
        self.div = div;

        self.gSampleDescription = "cell";
        self.ctx = null; // the canvas context
        self.canvas = addCanvasToDiv(div, top, left, width, height-gStatusHeight );

        self.interact = false;

        if (args && args.showClose===true) {
            self.closeButton = addChildControls(10, width-gCloseButtonFromRight);
        }

        if (args===undefined || (args["interact"]!==false)) {
            self.interact = true;

            addZoomButtons(height-gZoomFromBottom, gZoomFromLeft, self);
            addModeButtons(10, 10, self);
            addStatusLine(height-gStatusHeight, left, width, gStatusHeight);
            addTitleDiv(height-gTitleSize-gStatusHeight-4, 8);

            /* add the div used for the mouse selection/zoom rectangle to the DOM */
            var selectDiv = document.createElement('div');
            selectDiv.id = "mpSelectBox";
            selectDiv.style.border = "1px dotted black";
            selectDiv.style.position = "absolute";
            selectDiv.style.display  = "none";
            selectDiv.style.pointerEvents = "none";
            self.div.appendChild(selectDiv);

            // callbacks when user clicks or hovers over label or cell
            self.onLabelClick = null; // called on label click, args: text of label and event
            self.onCellClick = null; // called on cell click, args: array of cellIds and event
            self.onCellHover = null; // called on cell hover, arg: array of cellIds
            self.onNoCellHover = null; // called on hover over empty background
            self.onSelChange = null; // called when the selection has been changed, arg: array of cell Ids
            self.onLabelHover = null; // called when mouse hovers over a label
            self.onNoLabelHover = null; // called when mouse does not hover over a label
            self.onLineHover = null; // called when mouse over a trajectory line
            self.onRadiusAlphaChange = null; // called when user changes radius or alpha
            // self.onZoom100Click: called when user clicks the zoom100 button. Implemented below.
            self.selectBox = selectDiv; // we need this later
            self.setupMouse();

            // connected plots
            self.childPlot = null;    // plot that is syncing from us, see split()
            self.parentPlot = null;   // plot that syncs to us, see split()

        }

        addProgressBars(top+Math.round(height*0.3), left+30);
        if (!args || args.showSliders===undefined || args.showSliders===true)
            addSliders();

        // timer that is reset on every mouse move
        self.timer = null;
    }

    function isHidden(x, y) {
        /* special coords are used for circles that are off-screen or otherwise not visible */
       return ((x===HIDCOORD && y===HIDCOORD)) // not shown (e.g. no coordinate or off-screen)
    }

    function hexToGrey(hexColors) {
        let greyArray = []
        for (let i = 0; i < hexColors.length; i++) {
            // Extract red, green, and blue components
            let hexColor = hexColors[i];
            const maxCol = 200;
            const addCol = 20;
            const red = Math.min(maxCol, addCol+parseInt(hexColor.slice(1, 3), 16));
            const green = Math.min(maxCol, addCol+parseInt(hexColor.slice(3, 5), 16));
            const blue = Math.min(maxCol, addCol+parseInt(hexColor.slice(5, 7), 16));

            // Calculate the grayscale value using the luminosity method
            const gray = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);

            // Convert the grayscale value to a two-character hex string
            const grayHex = gray.toString(16).padStart(2, '0');

            // Return the grayscale hex color
            const greySixHex = `${grayHex}${grayHex}${grayHex}`;
            greyArray.push(greySixHex);
        }
        return greyArray;
    }


    this.initPort = function(args) {
        /* init all viewport related state (zoom, radius, alpha) */
        self.port = {};
        self.port.zoomRange = {}; // object with keys minX, , maxX, minY, maxY, in data units
        self.port.radius     = getAttr(args, "radius", null);    // current radius of the circles, 0=one pixel dots

        // we keep a copy of the 'initial' arguments at 100% zoom
        self.port.initZoom   = {};
        self.port.initRadius = self.port.radius;                      // circle radius at full zoom
        self.port.initAlpha   = getAttr(args, "alpha", 0.3);
    };

    this.initPlot = function(args) {
        /* create a new scatter plot on the canvas */
        if (args===undefined)
            args = {};

        self.scalingDone = false;

        self.globalOpts = args;

        self.mode = 1;   // drawing mode

        // everything related to circle coordinates
        self.coords = {};
        self.coords.orig = null;   // coordinates of cells in original coordinates
        self.coords.labels    = null;   // cluster label positions in pixels, array of [x,y,text]

        self.coords.px   = null;   // coordinates of cells and labels as screen pixels or (HIDCOORD,HIDCOORD) if not shown
        self.coords.labelBbox = null;   // cluster label bounding boxes, array of [x1,x2,x2,y2]

        self.col = {};
        self.col.pal = null;        // list of six-digit hex codes
        self.col.arr = null;        // length is coords.px/2, one byte per cell = index into self.col.pal

        self.selCells = new Set();  // IDs of cells that are selected (drawn in black)

        self.fatIdx = null;        // Index of value that is in "fat mode" (=cells bigger, all other cells in light-grey)

        self.doDrawLabels = true;  // should cluster labels be drawn?
        self.initPort(args);

        // mouse drag mode: can be "select", "move" or "zoom"
        self.dragMode = "select";

        // for zooming and panning
        self.mouseDownX = null;
        self.mouseDownY = null;
        self.panCopy    = null;

        // to detect if user just clicked on a dot
        self.dotClickX = null;
        self.dotClickY = null;

        // the background image for spatial mode
        self.background = null;

        self.activateMode(getAttr(args, "mode", "move"));

    };

    this.clear = function() {
        clearCanvas(self.ctx, self.canvas.width, self.canvas.height);
    };

    this.setTitle = function (text) {
        self.title = text;
        self.titleDiv.innerHTML = text;
    };

    this.activateSliders = function () {
        $(self.alphaSlider).slider({
            "value": 4,
            "min"  : 1,
            "max"  : 7,
            "step" : 1, 
            "slide": onChangeAlpha
        });
        $(self.radiusSlider).slider({
            "value": 4,
            "min"  : 1,
            "max"  : 7,
            "step" : 1, 
            "slide": onChangeRadius
        });
        
    }

    this.setWatermark = function (text) {
        if (text==="" && self.watermark) {
            self.watermark.parentNode.removeChild(self.watermark);
            self.watermark = undefined;
            return;
        }

        if (self.watermark)
            self.watermark.parentNode.removeChild(self.watermark);

        var elem = document.createElement('div');
        elem.id = "tpWatermark";
        elem.style.cssText = 'pointer-events: none;position: absolute; width: 1000px; opacity: 0.8; top: 10px; left: 45px; text-align: left; vertical-align: top; color: black; font-size: 20px; font-weight:bold; font-style:oblique';
        elem.textContent = text;
        self.div.appendChild(elem);
        self.watermark = elem;
    }

    // -- (private) helper functions
    // -- these are normal functions, not methods, they do not access "self"

    function gebi(idStr) {
        return document.getElementById(idStr);
    }

    function removeElById(idStr) {
        var el = gebi(idStr);
        if (el!==null) {
            el.parentNode.removeChild(el);
        }
    }

    function activateTooltip(selector) {
        /* uses bootstrap tooltip. Use noconflict in html, I had to rename BS's tooltip to avoid overwrite by jquery
         */
        if (window.jQuery && $.fn.bsTooltip!==undefined) {
            var ttOpt = {"html": true, "animation": false, "delay":{"show":400, "hide":100}, container:"body"};
            $(selector).bsTooltip(ttOpt);
        }
    }

    function guessRadius(coordCount) {
        /* a few rules to find a good initial radius, depending on the number of dots */
        if (coordCount > 50000)
            return 0;
        else if (coordCount > 10000)
            return 2;
        else if (coordCount > 4000)
            return 4;
        else
            return 5;
    }

    function createSliderSpan(id, width, height, left) {
        /* create div with given width and height */
        var div = document.createElement('span');
        div.id = id;
        div.style.position = "relative";
        div.style.width = width+"px";
        div.style.height = height+"px";
        div.style.left = left+"px";
        return div;
    }

    function createButton(width, height, id, title, text, imgFname, paddingTop, paddingBottom, addSep, addThickSep, fontSize) {
        /* make a light-grey div that behaves like a button, with text and/or an image on it
         * Images are hard to vertically center, so padding top can be specified.
         * */
        var div = document.createElement('div');
        div.id = id;
        div.className = "mpButton";
        div.style.backgroundColor = gButtonBackground;
        div.style.width = width+"px";
        div.style.height = height+"px";
        div.style["z-index"]="10";
        div.style["text-align"]="center";
        div.style["vertical-align"]="middle";
        div.style["line-height"]=height+"px";
        if (fontSize === undefined || fontSize=== null) {
            if (text!==null)
                if (text.length>3)
                    div.style["font-size"]="11px";
                else
                    div.style["font-size"]="14px";
        } else {
            div.style["font-size"]=fontSize+"px";
        }
        div.style["font-weight"]="bold";
        div.style["font-family"]="sans-serif";

        if (title!==null)
            div.title = title;
        if (text!==null)
            div.innerHTML = text;
        if (imgFname!==null && imgFname!==undefined) {
            var img = document.createElement('img');
            img.src = imgFname;
            if (paddingTop!==null && paddingTop!==undefined) {
                img.style.paddingTop = paddingTop+"px";
            if (paddingBottom)
                img.style.paddingBottom = paddingBottom+"px";
            }
            div.appendChild(img);
        }
        if (addSep===true)
            div.style["border-bottom"] = "1px solid #D7D7D7";
        if (addThickSep===true)
            div.style["border-bottom"] = "2px solid #C7C7C7";


        // make color dark grey when mouse is pressed
        div.addEventListener("mousedown", function() {
                this.style.backgroundColor = gButtonBackgroundClicked;
        });

        div.addEventListener("mouseup", function() {
                this.style.backgroundColor = gButtonBackground;
        });
        return div;
    }

    function makeCtrlContainer(top, left) {
        /* make a container for half-transprent ctrl buttons over the canvas */
        var ctrlDiv = document.createElement('div');
        ctrlDiv.id = "mpCtrls";
        ctrlDiv.style.position = "absolute";
        ctrlDiv.style.left = left+"px";
        ctrlDiv.style.top = top+"px";
        ctrlDiv.style["border-radius"]="2px";
        ctrlDiv.style["cursor"]="pointer";
        ctrlDiv.style["box-shadow"]="0px 2px 4px rgba(0,0,0,0.3)";
        ctrlDiv.style["border-top-left-radius"]="2px";
        ctrlDiv.style["border-top-right-radius"]="2px";
        ctrlDiv.style["user-select"]="none";
        return ctrlDiv;
    }

    function addZoomButtons(top, left, self) {
        /* add the plus/minus buttons to the DOM and place at position x,y on the screen */
        var width = gZoomButtonSize;
        var height = gZoomButtonSize;

        var plusDiv = createButton(width, height, "mpCtrlZoomPlus", "Zoom in. Keyboard: +", "+", null, null, null, true);
        //plusDiv.style["border-bottom"] = "1px solid #D7D7D7";

        var fullDiv = createButton(width, height, "mpCtrlZoom100", "Zoom in. Keyboard: space", "100%", null, null, null, true);
        //full.style["border-bottom"] = "1px solid #D7D7D7";

        var minusDiv = createButton(width, height, "mpCtrlZoomMinus", "Zoom out. Keyboard: -", "-");

        var ctrlDiv = makeCtrlContainer(top, left);
        ctrlDiv.appendChild(plusDiv);
        ctrlDiv.appendChild(fullDiv);
        ctrlDiv.appendChild(minusDiv);
        self.zoomDiv = ctrlDiv;

        self.div.appendChild(ctrlDiv);

        minusDiv.addEventListener('click', function() { self.zoomBy(0.75); self.drawDots(); });
        fullDiv.addEventListener('click', function() { self.zoom100(); self.drawDots()});
        plusDiv.addEventListener('click', function() { self.zoomBy(1.333); self.drawDots(); });
    }

    function addTitleDiv(top, left) {
        var div = document.createElement('div');
        div.className = "tpTitle";
        div.style.top = top+"px";
        div.style.left = left+"px";
        div.style.fontSize = gTitleSize;
        div.id = 'mpTitle';
        self.div.appendChild(div);
        self.titleDiv = div;
    }

    function onChangeAlpha(ev, ui) {
        console.log("alpha: "+ui.value);
        var sliderVal = ui.value; // 1-7
        var multMap = {
            7 : 0.15,
            6 : 0.4,
            5 : 0.8,
            4 : 1.0,
            3 : 1.2,
            2 : 1.5,
            1 : 1.8
        }
        self.port.alphaMult = multMap[sliderVal];
        console.log("alphaMult: "+self.port.alphaMult);
        self.calcRadius();
        self.drawDots();
    }

    function onChangeRadius(ev, ui) {
        //console.log("radius: "+ui.value);
        var sliderVal = ui.value; // 1-7
        var multMap = {
            1 : 1/3,
            2 : 1/2,
            3 : 1/1.5,
            4 : 1.0,
            5 : 1.5,
            6 : 2.0,
            7 : 3.0
        }
        self.port.radiusMult = multMap[sliderVal];
        self.calcRadius();
        self.drawDots();
    }

    function addSliders() {
        /* add sliders for transparency and radius */
        // alpha reset slider: a label, a slider + a reset button
        var sliderWidth = 90;
        //var fromLeft = canvWidth - sliderWidth - 2*45 - 50;

        var alphaSlider = createSliderSpan("mpAlphaSlider", sliderWidth, 10, 35);
        self.alphaSlider = alphaSlider; // see activateSliders() for the jquery UI part of the code, executed later
        alphaSlider.style.float = "left";
        //alphaSlider.style.top = "3px";

        // container for label + control elements
        var alphaCont = document.createElement('div');
        alphaCont.id = "mpAlphaCont";
        //alphaCont.style.left = "150px"; // cellbrowser.css defines grid widths: 45
        alphaCont.className = "sliderContainer";
        alphaCont.style.top = "15px"; 
        alphaCont.style.left = "0px";

        var alphaLabel = document.createElement('div'); // contains the slider and the reset button, floats right
        alphaLabel.id = "alphaSliderLabel";
        alphaLabel.textContent = "Transparency";
        alphaLabel.className = "sliderLabel";

        // reset button
        var undoSvg = '<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 512 512"><!--! Font Awesome Free 6.4.2 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2023 Fonticons, Inc. --><path d="M212.333 224.333H12c-6.627 0-12-5.373-12-12V12C0 5.373 5.373 0 12 0h48c6.627 0 12 5.373 12 12v78.112C117.773 39.279 184.26 7.47 258.175 8.007c136.906.994 246.448 111.623 246.157 248.532C504.041 393.258 393.12 504 256.333 504c-64.089 0-122.496-24.313-166.51-64.215-5.099-4.622-5.334-12.554-.467-17.42l33.967-33.967c4.474-4.474 11.662-4.717 16.401-.525C170.76 415.336 211.58 432 256.333 432c97.268 0 176-78.716 176-176 0-97.267-78.716-176-176-176-58.496 0-110.28 28.476-142.274 72.333h98.274c6.627 0 12 5.373 12 12v48c0 6.627-5.373 12-12 12z"/></svg>';

        //var alphaReset = createButton(15, 15, "mpAlphaReset", "Reset transparency", undoSvg, null, null, null, false, false, 10);
        //alphaReset.style.float = "right";
        //alphaReset.style.marginLeft = "2px";
        //alphaReset.addEventListener ('click',  function() { self.resetAlpha(); self.drawDots();}, false);

        var sliderReset = createButton(15, 15, "mpSliderReset", "Reset transparency and circle size", undoSvg, null, null, null, false, false, 10);
        sliderReset.style.backgroundColor = "transparent";
        sliderReset.style.float = "right";
        //sliderReset.style.lineHeight = "16px";
        sliderReset.style.marginLeft = "10px";
        sliderReset.style.top = "0px";
        sliderReset.style.top = "0px";
        sliderReset.style.position = "relative";
        sliderReset["z-index"] = "10"; // ? why ?
        sliderReset.addEventListener ('click',  function() { self.resetAlpha(); self.resetRadius(); self.drawDots()}, false);

        alphaCont.appendChild(alphaLabel);
        alphaCont.appendChild(alphaSlider);
        //alphaCont.appendChild(alphaReset);
        alphaCont.appendChild(sliderReset);

        // Radius reset slider: label, slider and reset button
        var radiusSlider = createSliderSpan("mpRadiusSlider", sliderWidth, 10, 35);
        radiusSlider.style.float = "left";
        self.radiusSlider = radiusSlider; // see activateSliders() for the jquery UI part of the code, executed later

        // container for label + slider and reset button

        var radiusCont = document.createElement('span');
        radiusCont.className = "sliderContainer";
        radiusCont.id = "mpRadiusDiv";
        radiusCont.style.left = "0px"; 
        radiusCont.style.top = "0px";
        radiusCont.appendChild(radiusSlider)


        var radiusLabel = document.createElement('span'); // contains the slider and the reset button, floats right
        radiusLabel.id = "radiusSliderLabel";
        radiusLabel.textContent = "Circle Size";
        radiusLabel.style.width = "110px";
        radiusLabel.className = "sliderLabel";

        radiusCont.appendChild(radiusLabel);
        radiusCont.appendChild(radiusSlider);
        //radiusCont.appendChild(sliderReset);
        var brEl = document.createElement('br');
        radiusCont.appendChild(brEl);

        // add both to the big container div that holds all three slider elements
        var sliderDiv = document.createElement('span');
        //sliderDiv.style.top = fromTop+"px";
        //sliderDiv.style.left = fromLeft+"px";
        sliderDiv.style.bottom = "28px";
        sliderDiv.style.right = "200px";
        sliderDiv.style.position = "absolute";
        sliderDiv.style.zIndex = "10";
        sliderDiv.id = "mpSliderDiv";
        sliderDiv.appendChild(radiusCont);
        sliderDiv.appendChild(alphaCont);
        self.div.appendChild(sliderDiv);
        //self.canvasDiv.appendChild(sliderDiv);
        self.sliderDiv = sliderDiv; // for quickResize()
    }

    function addCloseButton(top, left) {
        /* add close button and sync checkbox */
        var div = document.createElement('div');
        div.style.cursor = "default";
        div.style.left = left+"px";
        div.style.top = top+"px";
        div.style.display = "block";
        div.style.position = "absolute";
        div.style.fontSize = gTitleSize;
        div.style.padding = "3px";
        div.style.borderRadius = "3px";
        div.style.border = "1px solid #c5c5c5";
        div.style.backgroundColor = "#f6f6f6";
        div.style.color = "#454545";
        div.id = 'mpCloseButton';
        div.textContent = "Close";
        self.div.appendChild(div);
        return div;
    }

    function addChildControls(top, left) {
        addCloseButton(top, left);
    }

    function appendButton(parentDiv, id, title, imgName) {
        /* add a div styled like a button under div */
        var div = document.createElement('div');
        div.title = title;
        div.id = id;

    }

    function addModeButtons(top, left, self) {
        /* add the zoom/move/select control buttons to the DOM */
        var ctrlDiv = makeCtrlContainer(top, left);

        var bSize = gZoomButtonSize;

        var selectButton = createButton(bSize, bSize, "mpIconModeSelect", "Select mode. Keyboard: shift or s", null, "img/select.png", 0, 4, true, true);
        selectButton.addEventListener ('click',  function() { self.activateMode("select")}, false);

        var zoomButton = createButton(bSize, bSize, "mpIconModeZoom", "Zoom-to-rectangle mode. Keyboard: Windows/Command or z", null, "img/zoom.png", 4, 4, true);
        zoomButton.addEventListener ('click', function() { self.activateMode("zoom")}, false);

        var moveButton = createButton(bSize, bSize, "mpIconModeMove", "Move mode. Keyboard: Alt or m", null, "img/move.png", 4, 4);
        moveButton.addEventListener('click', function() { self.activateMode("move");}, false);

        self.icons = {};
        self.icons["move"] = moveButton;
        self.icons["select"] = selectButton;
        self.icons["zoom"] = zoomButton;

        //ctrlDiv.innerHTML = htmls.join("");
        ctrlDiv.appendChild(moveButton);
        ctrlDiv.appendChild(selectButton);
        ctrlDiv.appendChild(zoomButton);

        self.div.appendChild(ctrlDiv);
        self.toolDiv = ctrlDiv;

        activateTooltip('.mpIconButton');
    }

    function setStatus(text) {
        self.statusLine.innerHTML = text;
    }

    function addStatusLine(top, left, width, height) {
        /* add a status line div */
        var div = document.createElement('div');
        div.id = "mpStatus";
        div.style.backgroundColor = "rgb(240, 240, 240)";
        div.style.position = "absolute";
        div.style.top = top+"px";
        //div.style.left = left+"px";
        div.style.width = width+"px";
        div.style.height = height+"px";
        div.style["border-left"]="1px solid #DDD";
        div.style["border-right"]="1px solid #DDD";
        div.style["border-top"]="1px solid #DDD";
        div.style["font-size"]=(gStatusHeight-1)+"px";
        div.style["cursor"]="pointer";
        div.style["font-family"] = "sans-serif";
        self.div.appendChild(div);
        self.statusLine = div;
    }

    function addProgressBars(top, left) {
       /* add the progress bar DIVs to the DOM */
       var div = document.createElement('div');
       div.id = "mpProgressBars";
       div.style.top = top+"px";
       div.style.left = left+"px";
       div.style.position = "absolute";

       var htmls = [];
       for (var i=0; i<3; i++) {
           htmls.push('<div id="mpProgressDiv'+i+'" style="display:none; height:17px; width:300px; background-color: rgba(180, 180, 180, 0.3)" style="">');
           htmls.push('<div id="mpProgress'+i+'" style="background-color:#666; height:17px; width:10%"></div>');
           htmls.push('<div id="mpProgressLabel'+i+'" style="color:black; line-height:17px; position:absolute; top:'+(i*17)+'px;left:100px">Loading...</div>');
           htmls.push('</div>');
       }

       div.innerHTML = htmls.join("");
       self.div.appendChild(div);
    }

    function addCanvasToDiv(div, top, left, width, height) {
        /* add a canvas element to the body element of the current page and keep left/top/width/eight in self */
        var canv = document.createElement('canvas');
        self.canvasDiv = canv;
        canv.id = 'mpCanvas';
        //canv.style.border = "1px solid #AAAAAA";
        canv.style.backgroundColor = "white";
        canv.style.position = "relative";
        canv.style.display = "block";
        canv.style.width = width+"px";
        canv.style.height = height+"px";
        //canv.style.top = top+"px";
        //canv.style.left = left+"px";
        // No scaling = one unit on screen is one pixel. Essential for speed.
        canv.width = width;
        canv.height = height;

        // need to keep these as ints, need them all the time
        self.width = width;
        self.height = height;
        self.top = top; // location of the canvas in pixels
        self.left = left;

        div.appendChild(canv); // adds the canvas to the div element
        self.canvas = canv;
        // alpha:false recommended by https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
        self.ctx = self.canvas.getContext("2d", { alpha: false });
        // by default, the canvas background is transparent+black
        // we use alpha=false, so we need to initialize the canvas with white pixels
        clearCanvas(self.ctx, width, height);

        return canv;
    }

    function scaleLabels(labels, zoomRange, borderSize, winWidth, winHeight) {
        /* scale cluster label position to pixel coordinates */
        if (labels===undefined)
            return undefined;

        winWidth = winWidth-(2*borderSize);
        winHeight = winHeight-(2*borderSize);

        var minX = zoomRange.minX;
        var maxX = zoomRange.maxX;
        var minY = zoomRange.minY;
        var maxY = zoomRange.maxY;

        var spanX = maxX - minX;
        var spanY = maxY - minY;
        var xMult = winWidth / spanX;
        var yMult = winHeight / spanY;

        // scale the label coords
        var pxLabels = [];
        for (var i = 0; i < labels.length; i++) {
            var annot = labels[i];
            var x = annot[0];
            var y = annot[1];
            var text = annot[2];
            // XX ignore anything outside of current zoom range. Performance?
            if (isHidden(x,y) || (x < minX) || (x > maxX) || (y < minY) || (y > maxY)) {
                pxLabels.push(null);
            }
            else {
                var xPx = Math.round((x-minX)*xMult)+borderSize;
                var yPx = winHeight - Math.round((y-minY)*yMult)+borderSize;
                pxLabels.push([xPx, yPx, text]);
            }
        }
        return pxLabels;
    }

    function constrainVal(x, min, max) {
        /* if x is not in range min, max, limit to min or max */
        if (x < min)
            return min;
        if (x > max)
            return max;
        return x;
    }

    function scaleLines(lines, zoomRange, winWidth, winHeight) {
        /* scale an array of (x1, y1, x2, y2), cutting lines at the screen edges */
        var minX = zoomRange.minX;
        var maxX = zoomRange.maxX;
        var minY = zoomRange.minY;
        var maxY = zoomRange.maxY;

        var spanX = maxX - minX;
        var spanY = maxY - minY;
        var xMult = winWidth / spanX;
        var yMult = winHeight / spanY;

        // transform from data floats to screen pixel coordinates
        var pxLines = [];
        for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            var line = lines[lineIdx];
            var x1 = line[0];
            var y1 = line[1];
            var x2 = line[2];
            var y2 = line[3];

            var startInvis = ((x1 < minX) || (x1 > maxX) || (y1 < minY) || (y1 > maxY));
            var endInvis = ((x2 < minX) || (x2 > maxX) || (y2 < minY) || (y2 > maxY));

            // line is entirely hidden
            if (startInvis && endInvis)
                continue;

            if (startInvis) {
                x1 = constrainVal(x1, minX, maxX);
                y1 = constrainVal(y1, minY, maxY);
            }
            if (endInvis) {
                x2 = constrainVal(x2, minX, maxX);
                y2 = constrainVal(y2, minY, maxY);
            }

            var x1Px = Math.round((x1-minX)*xMult);
            var y1Px = winHeight - Math.round((y1-minY)*yMult);
            var x2Px = Math.round((x2-minX)*xMult);
            var y2Px = winHeight - Math.round((y2-minY)*yMult);
            pxLines.push( [x1Px, y1Px, x2Px, y2Px] );
        }
        return pxLines;
    }

    function scaleCoords(coords, borderSize, zoomRange, winWidth, winHeight, annots, aspectRatio) {
    /* scale list of [x (float),y (float)] to integer pixels on screen and
     * annots is an array with on-screen annotations in the format (x, y,
     * otherInfo) that is also scaled.  return [array of (x (int), y (int)),
     * scaled annots array]. Take into account the current zoom range.      *
     * Canvas origin is top-left, but usually plotting origin is bottom-left,
     * so also flip the Y axis. sets invisible coords to HIDCOORD
     * */
        if (coords===null)
            return;
        console.time("scale");
        var minX = zoomRange.minX;
        var maxX = zoomRange.maxX;
        var minY = zoomRange.minY;
        var maxY = zoomRange.maxY;

        var spanX = maxX - minX;
        var spanY = maxY - minY;

        //if (aspectRatio) {
            //xMult = Math.min(xMult, yMult);
            //yMult = Math.min(xMult, yMult);
            //let ratio = spanX / spanY;
            //spanY = spanY*0.5;
        //}

        winWidth = winWidth-(2*borderSize);
        winHeight = winHeight-(2*borderSize);

        var xMult = winWidth / spanX;
        var yMult = winHeight / spanY;


        // transform from data floats to screen pixel coordinates
        var pixelCoords = new Uint16Array(coords.length);
        for (var i = 0; i < coords.length/2; i++) {
            var x = coords[i*2];
            var y = coords[i*2+1];
            // set everything outside of current zoom range to hidden
            if ((x < minX) || (x > maxX) || (y < minY) || (y > maxY)) {
                pixelCoords[2*i] = HIDCOORD; // see isHidden()
                pixelCoords[2*i+1] = HIDCOORD;
            }
            else {
                var xPx = Math.round((x-minX)*xMult)+borderSize;
                // our y-axis is flipped compared to matplotlib/R, so we do winHeight - pixel value
                // to make sure that our plot looks like the figures in the papers
                var yPx = winHeight - Math.round((y-minY)*yMult)+borderSize;
                pixelCoords[2*i] = xPx;
                pixelCoords[2*i+1] = yPx;
            }
        }

        console.timeEnd("scale");
        return pixelCoords;
    }

    function drawRect(ctx, pxCoords, coordColors, colors, radius, alpha, selCells, fatIdx) {
        /* draw not circles but tiny rectangles. Maybe good enough for 2pixels sizes */
       debug("Drawing "+coordColors.length+" rectangles, with fillRect");
       ctx.save();
       ctx.globalAlpha = alpha;
       var dblSize = 2*radius;
       var count = 0;

       if (selCells.size!==0 || fatIdx!==null)
           //colors = makeAllGreyHex(colors.length);
           colors = hexToGrey(colors);

       var fatCells = [];

       // first draw all the cells with value 0. Poor mans approximation of a z index. 
       // (Should be faster than sorting by z and drawing afterwards.)
       for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;

           var valIdx = coordColors[i];
           // only plot color 0
           if (valIdx!==0)
               continue;

           var col = colors[valIdx];
           if (fatIdx!==null) {
               if (valIdx===fatIdx) {
                   // fattened cells must be overdrawn later, so just save their coords now
                   fatCells.push(pxX);
                   fatCells.push(pxY);
                   continue
               }
           }
           ctx.fillStyle="#"+col;
           ctx.fillRect(pxX-radius, pxY-radius, dblSize, dblSize);
           count++;
       }

       // then draw all the cells with value <> 0. 
       for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;

           var valIdx = coordColors[i];
           // only plot color != 0
           if (valIdx===0)
               continue;

           var col = colors[valIdx];
           if (fatIdx!==null) {
               if (valIdx===fatIdx) {
                   // fattened cells must be overdrawn later, so just save their coords now
                   fatCells.push(pxX);
                   fatCells.push(pxY);
                   continue
               }
               //else
                   //col = "DDDDDD";
                   //col = nonFatColorRect;
           }

           ctx.fillStyle="#"+col;
           ctx.fillRect(pxX-radius, pxY-radius, dblSize, dblSize);
           count++;
       }

       // overdraw the selection as black rectangles on top
       //if (fatIdx===null) {
           ctx.globalAlpha = 0.7;
           ctx.fillStyle="black";
            selCells.forEach(function(cellId) {
               let pxX = pxCoords[2*cellId];
               let pxY = pxCoords[2*cellId+1];
               ctx.fillRect(pxX-radius, pxY-radius, dblSize, dblSize);
               count += 1;
            })
       //}
       // overdraw the fattened cells as blue rectangles on top
       if (fatCells.length!==0) {
           ctx.globalAlpha = 0.7;
           ctx.fillStyle="blue";
           for (var i = 0; i < fatCells.length/2; i++) {
               var pxX = fatCells[2*i];
               var pxY = fatCells[2*i+1];
               ctx.fillRect(pxX-radius, pxY-radius, dblSize, dblSize);
               count++;
           }
       }
       debug(count+" rectangles drawn (including selection+fattening)");
       ctx.restore();
       return count;
    }

    function drawCirclesStupid(ctx, pxCoords, coordColors, colors, radius, alpha, selCells, fatIdx) {
    /* TOO SLOW - Only used in testing/for demos. Not used anywhere else. Draw circles onto canvas with very slow functions.. */
       debug("Drawing "+coordColors.length+" circles with stupid renderer");
       ctx.globalAlpha = alpha;
       var dblSize = 2*radius;
       var count = 0;
       for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;
           var valIdx = coordColors[i];
           var col = colors[valIdx];
           if (fatIdx!==null && valIdx!==fatIdx)
               col = nonFatColor;

           ctx.fillStyle="#"+col;
           ctx.beginPath();
           ctx.arc(pxX, pxY, radius, 0, 2 * Math.PI);
           ctx.closePath();
           ctx.fill();
           count++;
       }
       return count;
    }

    function intersectRect(r1left, r1right, r1top, r1bottom, r2left, r2right, r2top, r2bottom) {
      /* return true if two rectangles overlap,
       https://stackoverflow.com/questions/2752349/fast-rectangle-to-rectangle-intersection
	*/
      return !(r2left > r1right || r2right < r1left || r2top > r1bottom || r2bottom < r1top);
    }

    function drawLines(ctx, pxLines, width, height, attrs) {
        /* draw lines defined by array with (x1, y1, x2, y2) arrays.
         * color is a CSS name, so usually prefixed by # if a hexcode
         * width is the width in pixels.
         * */
        ctx.save();
        //ctx.globalAlpha = 1.0;

        ctx.strokeStyle = attrs.lineColor || "#888888";
        ctx.lineWidth = attrs.lineWidth || 3;
        ctx.globalAlpha = attrs.lineAlpha || 0.5;
        //ctx.miterLimit =2;
        //ctx.strokeStyle = "rgba(200, 200, 200, 0.3)";

        for (var i=0; i < pxLines.length; i++) {
            var line = pxLines[i];
            var x1 = line[0];
            var y1 = line[1];
            var x2 = line[2];
            var y2 = line[3];

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.restore();
    }

    function drawLabelsSvg(svgLines, labelCoords, winWidth, winHeight, zoomFact) {
        /* given an array of [x, y, text], draw the text. returns bounding
         * boxes as array of [x1, y1, x2, y2]  */

        if (labelCoords===undefined)
            return undefined;

        for (var i=0; i < labelCoords.length; i++) {
            var coord = labelCoords[i];
            if (coord===null) { // outside of view range, push a null to avoid messing up the order of bboxArr
                continue;
            }

            var x = coord[0];
            var y = coord[1];
            var text = coord[2];

            // don't draw labels where the midpoint is off-screen
            if (x<0 || y<0 || x>winWidth || y>winHeight) {
                continue;
            }

            svgLines.push("<text font-family='sans-serif' font-size='"+(gTextSize+2)+"' fill='black' text-anchor='middle' x='"+x+"' y='"+y+"'>"+text+"</text>");
        }

    }

    self.drawLegendSvg = function (legend) {
        /* draw a legend onto the SVG given a legend object. */
        var legWidth = self.svgLabelWidth;
        var svgLines = self.svgLines;

        var rows = legend.rows;

        var legTitle = legend.title;
        var subTitle = legend.subTitle;

        var left = self.canvas.width; // x position where legend starts

        var lineHeight = gTextSize;

        var x = left + 11;
        var y = lineHeight;
        svgLines.push("<text font-family='sans-serif' font-size='"+gTextSize+"' fill='black' x='"+x+"' y='"+y+"'>"+legTitle+"</text>");
        y += lineHeight;

        if (subTitle) {
            svgLines.push("<text font-family='sans-serif' font-size='"+gTextSize+"' fill='black' text-anchor='middle' x='"+x+"' y='"+y+"'>"+subTitle+"</text>");
            y += lineHeight;
        }

        y += lineHeight;

        // get the sum of all rows, to calculate frequency
        // this code was copied from buildLegend -> refactor one day
        var sum = 0;
        for (var i = 0; i < rows.length; i++) {
            let count = rows[i].count;
            sum += count;
        }

        for (i = 0; i < rows.length; i++) {
            // a lot was copied from cellBrowser:buildLegend(), could use some refactoring to reduce duplication
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

            // this was copied from cellbrowser:buildLegend - refactor soon
            label = label.replace(/_/g, " ").replace(/'/g, "&#39;").trim();
            if (label==="") {
                label = "(empty)";
            }
            label = label.replace("&ndash;", "-");

            // draw colored rectangle first

            var textSize = gTextSize-3;

            svgLines.push("<rect width='15' height='15' fill='#"+colorHex+"' x='"+x+"' y='"+y+"'></rect>");

            var prec = 1;
            if (freq<1)
                prec = 2;

            //var lineCount = 0;
            //svgLines.push("<text font-family='sans-serif' font-size='"+textSize+"' fill='black' text-anchor='start' x='"+(x+18)+"' y='"+((y-4)+lineCount*textSize)+"'>"+label+"</text>");
            svgLines.push("<text font-family='sans-serif' font-size='"+textSize+"' fill='black' text-anchor='start' x='"+(x+18)+"' y='"+(y+8)+"'>"+label+"</text>");
            //}
            svgLines.push("<text font-family='sans-serif' font-size='"+textSize+"' fill='black' text-anchor='end' x='"+(left+legWidth-3)+"' y='"+(y+15)+"'>"+freq.toFixed(prec)+"%</text>");
            y+= textSize;

        }
        // cannot draw violin plots in SVG - no library for it
    };

    function drawLabels(ctx, labelCoords, winWidth, winHeight, zoomFact, doGrey) {
        /* given an array of [x, y, text], draw the text. returns bounding
         * boxes as array of [x1, y1, x2, y2]  */
        if (labelCoords===undefined)
            return undefined;

        console.time("labels");
        ctx.save();
        ctx.font = "bold "+gTextSize+"px Sans-serif"
        ctx.globalAlpha = 1.0;

        //ctx.strokeStyle = '#EEEEEE';
        if (doGrey===undefined) {
            ctx.strokeStyle = "rgba(200, 200, 200, 0.3)";
            ctx.lineWidth = 5;
            ctx.miterLimit =2;
        }
        //else
            //ctx.strokeStyle = "rgba(20, 20, 20, 0.3)";

        ctx.textBaseline = "top";

        if (doGrey===undefined) {
            ctx.fillStyle = "rgba(0,0,0,0.8)";
            ctx.shadowBlur=6;
            ctx.shadowColor="white";
        }
        else
            ctx.fillStyle = "rgba(0,0,0,1.0)";

        ctx.textAlign = "left";

        var addMargin = 1; // how many pixels to extend the bbox around the text, make clicking easier
        var bboxArr = []; // array of click hit boxes

        for (var i=0; i < labelCoords.length; i++) {
            var coord = labelCoords[i];
            if (coord===null) { // outside of view range, push a null to avoid messing up the order of bboxArr
                bboxArr.push( null );
                continue;
            }

            var x = coord[0];
            var y = coord[1];
            var text = coord[2];

            var textWidth = Math.round(ctx.measureText(text).width);
            // move x to the left, so text is centered on x
            x = x - Math.round(textWidth*0.5);

            var textX1 = x;
            var textY1 = y;
            var textX2 = Math.round(x+textWidth);
            var textY2 = y+gTextSize;

            // don't draw labels where the midpoint is off-screen
            if (x<0 || y<0 || x>winWidth || y>winHeight) {
                bboxArr.push( null );
                continue;
            }


            ctx.strokeText(text,x,y);
            ctx.fillText(text,x,y);

            bboxArr.push( [textX1-addMargin, textY1-addMargin, textX2+addMargin, textY2+addMargin] );
        }
        ctx.restore();
        console.timeEnd("labels");
        return bboxArr;
    }

    // function drawLabels_dom(ctx, labelCoords, isFull) {
    //     /* given an array of [x, y, text], draw the text. returns bounding boxes as array of [x1, y1, x2, y2]  */
    //     for (var i=0; i < labelCoords.length; i++) {
    //         var coord = labelCoords[i];
    //         var x = coord[0];
    //         var y = coord[1];
    //         var text = coord[2];

    //         var div = document.createElement('div');
    //         div.id = id;
    //         //div.style.border = "1px solid #DDDDDD";
    //         div.style.backgroundColor = "rgb(230, 230, 230, 0.6)";
    //         div.style.width = width+"px";
    //         div.style.height = height+"px";
    //         div.style["text-align"]="center";
    //         div.style["vertical-align"]="middle";
    //         div.style["line-height"]=height+"px";
    //     }
    //     ctx.restore();
    //     return bboxArr;
    // }

    // https://stackoverflow.com/questions/5560248/programmatically-lighten-or-darken-a-hex-color-or-rgb-and-blend-colors
    function shadeColor(color, percent) {
        var f=parseInt(color,16),t=percent<0?0:255,p=percent<0?percent*-1:percent,R=f>>16,G=f>>8&0x00FF,B=f&0x0000FF;
        return (0x1000000+(Math.round((t-R)*p)+R)*0x10000+(Math.round((t-G)*p)+G)*0x100+(Math.round((t-B)*p)+B)).toString(16).slice(1);
    }

    function makeCircleTemplates(radius, tileWidth, tileHeight, colors, fatIdx) {
    /* create an off-screen-canvas with the circle-templates that will be stamped later onto the bigger canvas 
     * Returns the canvas. This feels very much like sprites on the AMIGA in the 1980s.
     *
     * returns an object with these attributes:
     *   .off       = off-screen canvas
     *   .selImgIdx = index on off with circle with a black outline only, for the selection
     *   .greyImgIdx= index on off with grey circle for the non-selected cells
     *   .nonFatImgIdx (only when fatIdx is != null) = index on off with grey circle(?) for the non-fattened cells
     */
       var off = document.createElement('canvas'); // not added to DOM, will be gc'ed at some point

       var nonFatImgIdx = 0;

       if (fatIdx!==null) {
           //colCount = 2;
           //colors = [colors[fatIdx], nonFatColorCircles];
            nonFatImgIdx = colors.length;
            colors.push(nonFatColorCircles);
       }

       var colCount = colors.length;

       off.width = (colCount+2) * tileWidth; // "+2" because we have three additional circles at the end
       off.height = tileHeight;
       var ctxOff = off.getContext('2d');

       //pre-render circles into the off-screen canvas.
       for (var i = 0; i < colors.length; ++i) {
           ctxOff.fillStyle = "#"+colors[i];
           ctxOff.beginPath();
           // parameters are: arc(x, y, r, 0, 2*pi)
           ctxOff.arc(i * tileWidth + radius + 1, radius + 1, radius, 0, 2 * Math.PI);
           ctxOff.closePath();
           ctxOff.fill();

           // only draw a pretty shaded outline for very big circles, at extremely high zoom levels
           if (radius > 6) {
               ctxOff.lineWidth=1.0;
               var strokeCol = "#"+shadeColor(colors[i], 0.9);
               //if (fatIdx!==null)
                   //strokeCol = "#000000";
               //else
               ctxOff.strokeStyle=strokeCol;

               ctxOff.beginPath();
               ctxOff.arc(i * tileWidth + radius + 1, radius + 1, radius, 0, 2 * Math.PI);
               ctxOff.closePath();
               ctxOff.stroke();
           }

       }

       // pre-render a black circle outline for the selection, quality of anti-aliasing?
       var selImgId = colors.length;
       ctxOff.lineWidth=2;
       ctxOff.strokeStyle="black";
       ctxOff.beginPath();
       // args: arc(x, y, r, 0, 2*pi)
       ctxOff.arc((selImgId * tileWidth) + radius + 1, radius + 1, radius - 1, 0, 2 * Math.PI);
       ctxOff.closePath();
       ctxOff.stroke();

       // pre-render a grey circle for the non-selection, when something is selected, all the rest is drawn in grey
       let greyImgId = colors.length + 1;
       ctxOff.lineWidth = 1;
       ctxOff.fillStyle = "#b2b2b2";
       ctxOff.beginPath();
       ctxOff.arc((greyImgId * tileWidth) + radius + 1, radius + 1, radius, 0, 2 * Math.PI);
       ctxOff.closePath();
       ctxOff.fill();

    let ret = {};
    ret.off = off;
    ret.selImgIdx = selImgId;
    ret.greyImgIdx = greyImgId;
    ret.nonFatImgIdx = nonFatImgIdx;
    return ret;
    }

    //function blitTwo(ctx, off, pxCoords, coordColors, tileWidth, tileHeight, radius, fatIdx, selImgId) {
    /* blit only the fatIdx circle in color, and all the rest in grey. Also draw selection circles. */
       //var count = 0;
       //for (let i = 0; i < pxCoords.length/2; i++) {
           //var pxX = pxCoords[2*i];
           //var pxY = pxCoords[2*i+1];
           //if (isHidden(pxX, pxY))
               //continue;
           //var col = coordColors[i];
           //if (col===fatIdx)
                //col = 0;
           //else 
                //col = 1;
           //count++;
           //ctx.drawImage(off, col * tileWidth, 0, tileWidth, tileHeight, pxX - radius - 1, pxY - radius - 1, tileWidth, tileHeight);
//
           //if (radius>=5)
               //ctx.drawImage(off, selImgId * tileWidth, 0, tileWidth, tileHeight, pxX - radius -1, pxY - radius-1, tileWidth, tileHeight);
       //}
       //return count;
    //}

    function blitAll(ctx, off, pxCoords, coordColors, tileWidth, tileHeight, radius, selCells, greyIdx, fatIdx, colors) {
   /* blit the circles onto the main canvas, using all colors */
       var count = 0;
       var hasSelection = false;
       if (selCells.size!==0)
           hasSelection = true;

       var col = 0;
       // first draw all the cells of the color 0
       for (let i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;

           // when a selection is active, draw everything in grey. This only works because the selection is overdrawn afterwards
           // (The selection must be overdrawn later, because otherwise circles shine through the selection)
           col = coordColors[i];
           count++;
           // only draw the cells of entry 0 of the palette first.
           // This is a poor approximation of a z-index, but a real z-index would take way too long.
           // So we're just drawing twice.
           if (col!==0)
               continue
           if (fatIdx===null) {
               if (hasSelection)
                   col = greyIdx;
            }
            else if (!hasSelection && !(fatIdx!=null && fatIdx===col))
                   col = greyIdx;

           ctx.drawImage(off, col * tileWidth, 0, tileWidth, tileHeight, pxX - radius - 1, pxY - radius - 1, tileWidth, tileHeight);
       }

       // then draw all the cells with the colors != 0
       for (let i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;

           col = coordColors[i];
           if (col===0)
               continue
           if (fatIdx===null) {
               if (hasSelection)
                   col = greyIdx;
            }
            else if (!hasSelection && !(fatIdx!=null && fatIdx===col))
                   col = greyIdx;

           ctx.drawImage(off, col * tileWidth, 0, tileWidth, tileHeight, pxX - radius - 1, pxY - radius - 1, tileWidth, tileHeight);
       }

       if (fatIdx!==null) {
           // do not fatten
           //radius = radius * 2;
           //let templates = makeCircleTemplates(radius, tileWidth, tileHeight, colors, fatIdx);
           //let off = templates.off;
           radius *= 1.5;
           for (let i = 0; i < pxCoords.length/2; i++) {
               col = coordColors[i];
               if (fatIdx!==col)
                   continue;
               var pxX = pxCoords[2*i];
               var pxY = pxCoords[2*i+1];
               if (isHidden(pxX, pxY))
                   continue;
               count++;
               ctx.drawImage(off, col * tileWidth, 0, tileWidth, tileHeight, pxX - radius - 1, pxY - radius - 1, tileWidth, tileHeight);
           }
        }
       return count;
    }

    function copyColorsOnly(coordColors, fatIdx, nonFatImgIdx)
    /* copy numbers in coordColors array to a new array of the same size and keep only fatIdx, set, all others to nonFatImgIdx */
    {
        let newArr = new Array(coordColors.length);
        for (let i=0; i<coordColors.length; i++) {
            let colIdx = coordColors[i];
            if (colIdx===fatIdx)
                newArr[i] = fatIdx;
            else
                newArr[i] = nonFatImgIdx;
        }
        return newArr;
    }


    function drawCirclesDrawImage(ctx, pxCoords, coordColors, colors, radius, alpha, selCells, fatIdx) {
    /* predraw and copy circles into canvas. pxCoords are the centers.  */
       // almost copied from by https://stackoverflow.com/questions/13916066/speed-up-the-drawing-of-many-points-on-a-html5-canvas-element
       // around 2x faster than drawing full circles by using an off-screen canvas

       debug("Drawing "+coordColors.length+" coords with drawImg renderer, radius="+radius);

       var diam = Math.round(2 * radius);
       var tileWidth = diam + 2; // must add one pixel on each side, space for antialising
       var tileHeight = tileWidth; // otherwise circles look cut off

       let templates = makeCircleTemplates(radius, tileWidth, tileHeight, colors, fatIdx);

       let off = templates.off;

       ctx.save();
       if (alpha!==undefined)
           ctx.globalAlpha = alpha;

       let count = 0;
       let origCoordColors = null;
       if (fatIdx!==null) {
           origCoordColors = coordColors;
           coordColors = copyColorsOnly(origCoordColors, fatIdx, templates.nonFatImgIdx);
       }
       
       count = blitAll(ctx, off, pxCoords, coordColors, tileWidth, tileHeight, radius, selCells, templates.greyImgIdx, fatIdx, colors);
       if (origCoordColors)
            coordColors = origCoordColors;

       // overdraw the selection on top: as circles with black outlines
       ctx.globalAlpha = 0.7;
       var selImgIdx = templates.selImgIdx; // second-to last template is the black outline, see makeCircleTemplates()
       selCells.forEach(function(cellId) {
           let pxX = pxCoords[2*cellId];
           let pxY = pxCoords[2*cellId+1];
           if (isHidden(pxX, pxY))
                return;
           // make sure that old leftover overlapping black circles don't shine through and redraw the circle
           // slow, but not sure what else I can do...
           let col = coordColors[cellId];
           ctx.drawImage(off, col * tileWidth, 0, tileWidth, tileHeight, pxX - radius -1, pxY - radius-1, tileWidth, tileHeight);

           // and draw the black outline
           ctx.drawImage(off, selImgIdx * tileWidth, 0, tileWidth, tileHeight, pxX - radius -1, pxY - radius-1, tileWidth, tileHeight);
        });

       ctx.restore();
       return count;
    }

    function hexToInt(colors) {
    /* convert a list of hex values to ints */
        var intList = [];
        for (var i = 0; i < colors.length; i++) {
            var colHex = colors[i];
            var colInt = parseInt(colHex, 16);
            if (colInt===undefined) {
                alert("Illegal color value, not a six-digit hex code: "+colHex);
                intList.push(0);
            }
            else
                intList.push(colInt);
        }
        return intList;
    }

    function makeAllGreyHex(num) {
    /* return a list of num grey hex strings */
        var hexList = [];
        for (var i = 0; i < num; i++) {
            hexList.push("b2b2b2");
        }
        return hexList;
    }

    function drawRectBuffer(ctx, width, height, pxCoords, colorArr, colors, alpha, selCells) {
        /* Draw little rectangles with size 3 using a memory buffer*/
       var canvasData = ctx.getImageData(0, 0, width, height);
       var cData = canvasData.data;

       var rgbColors = null;
       if (selCells.length===0)
           rgbColors = hexToInt(colors);
       else
           rgbColors = makeAllGrey(colors.length);

       var invAlpha = 1.0 - alpha;

       // alpha-blend pixels into array
       for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;

           var p = 4 * (pxY*width+pxX); // pointer to red value of pixel at x,y

           var oldR = cData[p];
           var oldG = cData[p+1];
           var oldB = cData[p+2];

           var newRgb = rgbColors[colorArr[i]];
           var newR = (newRgb >>> 16) & 0xff;
           var newG = (newRgb >>> 8)  & 0xff;
           var newB = (newRgb)        & 0xff;

           var mixR = ~~(oldR * invAlpha + newR * alpha);
           var mixG = ~~(oldG * invAlpha + newG * alpha);
           var mixB = ~~(oldB * invAlpha + newB * alpha);

           cData[p] = mixR;
           cData[p+1] = mixG;
           cData[p+2] = mixB;
           cData[p+3] = 255; // no transparency... ever?
       }
    }

    function drawBackground(ctx, back) {
        /* draw the background image onto the canvas ctx */
        if (!back)
            return;
        console.time("image");
        //var ctxWidth = ctx.canvas.width; // size of the canvas on the screen in pixels
        //var ctxHeight = ctx.canvas.height;

        //var clipWidth = backuwidth;
        //var clipHeight = back.height;

        // arguments are: (imgObject, x/y coord on image for clipping, width / height of clipped image, where to place the image, width/height of image)
        //var a = getSafeRect(back.image.width, back.image.height, back.clipX, back.clipY, back.image.width, back.image.height, 0, 0, ctxWidth, ctxHeight);
        //console.log("drawing fixed coords", a.sx, a.sy, a.sw, a.sh, a.dx, a.dy, a.dw, a.dh);
        //self.ctx.drawImage(back.image, a.sx, a.sy, a.sw, a.sh, a.dx, a.dy, a.dw, a.dh);
        //self.ctx.drawImage(back.image, a.sx, a.sy, back.width, back.height, a.dx, a.dy, a.dw, a.dh);
        console.log("drawImage sx, sy, sw, sh, dx, dy, dw, dh", back.sx, back.sy, back.sw, back.sh, back.dx,back.dy, back.dw, back.dh);
        //self.ctx.drawImage(back.image, back.sx, back.sy, back.width, back.height, 0, 0, ctxWidth, ctxHeight);
        self.ctx.drawImage(back.image, back.sx, back.sy, back.sw, back.sh, back.dx, back.dy, back.dw, back.dh);

        console.timeEnd("image");
    }


    function drawPixels(ctx, width, height, pxCoords, coordColors, colors, alpha, selCells, fatIdx) {
        /* draw single pixels into a pixel buffer and copy the buffer into a canvas */

       // by default the canvas has black pixels
       // so not doing: var canvasData = ctx.createImageData(width, height);
       // XX is this really faster than manually zero'ing the array?
       var canvasData = ctx.getImageData(0, 0, width, height);
       var cData = canvasData.data;

       var rgbColors = null;
       if (selCells.size===0)
           rgbColors = hexToInt(colors);
       else
           rgbColors = hexToInt(makeAllGreyHex(colors.length)); // selection is active, all cells are grey, except the selection

       var invAlpha = 1.0 - alpha;

       var count = 0;

       // alpha-blend pixels into array
       for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;
           var p = 4 * (pxY*width+pxX); // pointer to red value of pixel at x,y

           var valIdx = coordColors[i];

           if (fatIdx!==null) {
               // fattening mode: fat cluster is black, all the rest is blue
               let grey;
               if (valIdx!==fatIdx) {
                   grey = 0xDD;
                   cData[p] = grey;
                   cData[p+1] = grey;
                   cData[p+2] = grey;
               }
               else {
                   // stop all transparency, just overdraw fat blue here
                   cData[p] = 0;
                   cData[p+1] = 0;
                   cData[p+2] = 255;
               }
               cData[p+3] = 255; // no transparency... ever?

           } else {
               // normal colors
               var oldR = cData[p];
               var oldG = cData[p+1];
               var oldB = cData[p+2];

               var newRgb = rgbColors[valIdx];
               var newR = (newRgb >>> 16) & 0xff;
               var newG = (newRgb >>> 8)  & 0xff;
               var newB = (newRgb)        & 0xff;

               var mixR = ~~(oldR * invAlpha + newR * alpha);
               var mixG = ~~(oldG * invAlpha + newG * alpha);
               var mixB = ~~(oldB * invAlpha + newB * alpha);

               cData[p] = mixR;
               cData[p+1] = mixG;
               cData[p+2] = mixB;
               cData[p+3] = 255; // no transparency... ever?
            }
               count++;
       }

       // overdraw the selection as black pixels
        if (fatIdx===null) {
            selCells.forEach(function(cellId) {
               let pxX = pxCoords[2*cellId];
               let pxY = pxCoords[2*cellId+1];
               if (isHidden(pxX, pxY))
                    return;
               let p = 4 * (pxY*width+pxX); // pointer to red value of pixel at x,y
               cData[p] = 0;
               cData[p+1] = 0;
               cData[p+2] = 0;
            })
        }

       self.ctx.putImageData(canvasData, 0, 0);
       return count;
    }

    function findRange(coords) {
    /* find range of pairs-array and return obj with attributes minX/maxX/minY/maxY */
        var minX = 9999999;
        var maxX = -9999999;
        var minY = 9999999;
        var maxY = -9999999;

        for (var i = 0; i < coords.length/2; i++) {
            var x = coords[i*2];
            var y = coords[i*2+1];

            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);

            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }

        var obj = {};
        obj.minX = minX;
        obj.maxX = maxX;
        obj.minY = minY;
        obj.maxY = maxY;
        return obj; // not needed, but more explicit
    }

    function clearCanvas(ctx, width, height) {
    /* clear with a white background */
        // jsperf says this is fastest on Chrome, and still OK-ish in FF
        //console.time("clear");
        ctx.save();
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
        //console.timeEnd("clear");
    }

    // -- object methods (=access the self object)

    this.onZoom100Click = function(ev) {
        self.zoom100();
        self.drawDots();
    };

    this.setBackground = function(img) {
        /* */
        if (self.background===undefined || self.background===null)
            self.background = {};
        self.background.image = img;
        self.scaleBackground(self.background, self.port.initZoom, self.port.zoomRange);
        if (self.childPlot)
            self.childPlot.setBackground(img);
    };

    function getSafeRect(width, height, sx, sy, sw, sh, dx, dy, dw, dh)  {
        if( sw < 0 ) {
          sx += sw;
          sw = Math.abs( sw );
        }
        if( sh < 0 ) {
          sy += sh;
          sh = Math.abs( sh );
        }
        if( dw < 0 ) {
          dx += dw;
          dw = Math.abs( dw );
        }
        if( dh < 0 ) {
          dy += dh;
          dh = Math.abs( dh );
        }
        const x1 = Math.max( sx, 0 );
        const x2 = Math.min( sx + sw, width );
        const y1 = Math.max( sy, 0 );
        const y2 = Math.min( sy + sh, height );
        const w_ratio = dw / sw;
        const h_ratio = dh / sh;

    }

    this.scaleBackground = function(background, dataRange, zoomRange) {
        /* determine the (x,y,width,height) in pixels of the current rectangle of the background bitmap on the canvas */
        if (!background) 
            return;

        var width = background.image.width; // source image width
        var height = background.image.height; // source image height
 
        var ctxWidth  = self.canvas.width;
        var ctxHeight = self.canvas.height;

        var coordHeight = dataRange.maxY-dataRange.minY;
        var coordWidth = dataRange.maxX-dataRange.minX;

        var scaleX = width / coordWidth; // this is px/dataUnit to convert background image pixels to canvas pixels
        var scaleY = height / coordHeight;

        var sx1 = zoomRange.minX * scaleX; // sx = x position on source image
        var sx2 = zoomRange.maxX * scaleX;

        var sy1 = (coordHeight - zoomRange.maxY) * scaleY; // Y-positions must be subtracted from coordHeight - y axis is flipped!
        var sy2 = (coordHeight - zoomRange.minY) * scaleY; // Our y-axis is always flipped!

        var sw = sx2 - sx1; // size of slice of background image that is currently shown, in source pixels
        var sh = sy2 - sy1;

        // lame: since I wasn't able to figure out how to transform negative sx, sy to corrected dx, dy, coords - safari doesn't 
        // understand negative sx/sy - I simply use the scaleData function
        // somehow https://gist.github.com/Kaiido/ca9c837382d89b9d0061e96181d1d862 didn't work for me
        //var coords = [0.0, 0.0, dataRange.maxX, dataRange.maxY];
        //var newCoords = scaleCoords(coords, 0, zoomRange, ctxWidth, ctxHeight, [])

        var dx = 0;
        var dy = 0;
        var dw = ctxWidth;
        var dh = ctxHeight;

        //if (sx1 < 0) {
            //sx1 = 0;
            //sw = width;
            //dx = newCoords[0];
            //dw = newCoords[2] - dx;
        //}

        //if (sy1 < 0) {
            //sy1 = 0;
            //sh = height;
            //dy = newCoords[1];
            //dh = newCoords[3] - dy;
        //}

        background.sx = sx1;
        background.sy = sy1;
        background.sw = sw;
        background.sh = sh;

        background.dx = dx;
        background.dy = dy;
        background.dw = dw;
        background.dh = dh;
    }

    this.scaleData = function() {
       /* scale coords and labels to current zoom range, write results to pxCoords and pxLabels */
       if (!self.coords) // window resize can call this before coordinates are loaded.
           return;

       var borderMargin = self.port.radius;
       self.calcRadius();

       let w = self.canvas.width;
       let h = self.canvas.height;
       self.coords.px = scaleCoords(self.coords.orig, borderMargin, self.port.zoomRange, w, h, self.coords.aspectRatio);
       if (self.coords.lines)
           self.coords.pxLines = scaleLines(self.coords.lines, self.port.zoomRange, self.canvas.width, self.canvas.height);
       self.scaleBackground(self.background, self.port.initZoom, self.port.zoomRange);
       self.scalingDone = true;
    }

    this.readyToDraw = function() {
        return (self.scalingDone)
    }

    this.setTopLeft = function(top, left) {
        /* set top and left position in pixels of the canvas */
        self.top = top;
        self.left = left; // keep an integer version of these numbers
        self.div.style.top = top+"px";
        self.div.style.left = left+"px";

        self.setSize(self.width, self.height, false); // resize the various buttons
    }

    this.quickResize = function(width, height) {
       /* resize the canvas and move the status line, don't rescale or draw  */
       self.div.style.width = width+"px";
       self.div.style.height = height+"px";

       // if in split screen mode, pass on the message to the second window
       if (self.childPlot) {
           width = width/2;
           //self.childPlot.left = self.left+width;
           //self.childPlot.canvas.style.left = self.childPlot.left+"px";
           self.childPlot.setPos(null, self.left+width);
           self.childPlot.setSize(width, height, true);
       }

       if (self.closeButton) {
           self.closeButton.style.left = width - gCloseButtonFromRight;
       }

       // css and actual canvas sizes: these must be identical, otherwise canvas gets super slow
       self.canvas.style.width = width+"px";
       self.width = width;
       self.height = height;
       //let canvHeight = height - gStatusHeight;

       let canvHeight = height - gStatusHeight;
       self.canvas.height = canvHeight;
       self.canvas.width = width;
       self.canvas.style.height = canvHeight+"px";
       self.zoomDiv.style.top = (height-gZoomFromBottom)+"px";
       self.zoomDiv.style.left = (gZoomFromLeft)+"px";

       // move status line, dataset name and radius/transparency sliders
       var statusDiv = self.statusLine;
       statusDiv.style.top = (height-gStatusHeight)+"px";
       statusDiv.style.width = width+"px";

       self.titleDiv.style.top = (height-gStatusHeight-gTitleSize)+"px";

       if (self.sliderDiv)
           self.sliderDiv.style.top = (height-gStatusHeight-gSliderFromBottom)+"px";

    }

    this.setPos = function(top, left) {
       /* position canvas. Does not affect child  */
       if (top) {
          self.top = top;
          self.div.style.top = top+"px";
       }
       if (left) {
          self.left = left;
          self.div.style.left = left+"px";
       }
    }

    this.setSize = function(width, height, doRedraw) {
       /* resize canvas on the page re-scale the data and re-draw, unless doRedraw is false */
       if (width===null)
           width = self.div.getBoundingClientRect().width;

       self.quickResize(width, height);

       if (self.coords)
           self.scaleData();

       if (doRedraw===undefined || doRedraw===true)
           self.drawDots();
    };

    this.setCoords = function(coords, clusterLabels, coordInfo, opts) {
       /* specify new coordinates of circles to draw, an array of (x,y) coordinates */
       /* Scale data to current screen dimensions */
       /* clusterLabels is optional: array of [x, y, labelString]*/
       /* minX, maxX, etc are optional
        * opts are optional arguments like radius, alpha etc, see initPlot/args */
       self.scalingDone = false;
       if (coords.length === 0)
           alert("cbDraw-setCoords called with no coordinates");

       var minX = coordInfo.minX;
       var maxX = coordInfo.maxX;
       var minY = coordInfo.minY;
       var maxY = coordInfo.maxY;
       var useRaw = coordInfo.useRaw;

       var coordOpts = cloneObj(self.globalOpts);
       copyObj(opts, coordOpts);

       var oldRadius = self.port.initRadius;
       var oldAlpha  = self.port.initAlpha;
       var oldLabels = self.coords.pxLabels;
       self.port = {};
       self.initPort(coordOpts);
       if (oldRadius)
           self.port.initRadius = oldRadius;
       if (oldAlpha)
           self.port.initAlpha = oldAlpha;
       self.coords = {};

       self.coords.origAll = undefined;

       var newZr = {};
       if (minX===undefined || maxX===undefined || minY===undefined || maxY===undefined)
           newZr = findRange(coords);
       else {
           newZr = {minX:minX, maxX:maxX, minY:minY, maxY:maxY};
       }

       // switch off any moving of the spots to the minimum position
       if (useRaw) {
           newZr.minX = 0.0;
           newZr.minY = 0.0;
       }

       // we need the maximal min-max ranges of the original coordinates for later
       copyObj(newZr, self.port.initZoom);
       // the current min-max ranges of the values are the maximal values, so copy them = zoom 100%
       copyObj(newZr, self.port.zoomRange);

       self.coords.orig = coords;
       self.coords.coordInfo = coordInfo; // we need to find out the label of the coords
       self.coords.labels = clusterLabels;
       if (coordInfo.aspectRatio)
           self.coords.aspectRatio = coordInfo.aspectRatio;

       var count = 0;
       for (var i = 0; i < coords.length/2; i++) {
           var cellX = coords[i*2];
           var cellY = coords[i*2+1];
           if (!(isHidden(cellX, cellY)))
               count++;
       }

       setStatus(count+ " visible " + self.gSampleDescription+"s loaded");

       if (opts.lines)
           self._setLines(opts["lines"], opts);
       self.scaleData();
    };

    this.setLabelCoords = function(labelCoords) {
        /* set the label coords and return true if there were any labels before */
        var hadLabelsBefore = (self.coords.labels && self.coords.labels.length > 0);
        self.coords.labels = labelCoords;
        return hadLabelsBefore;
    };

    this.setColorArr = function(colorArr) {
    /* set the color array, one array with one index per coordinate */
       self.col.arr = colorArr;
    };

    this.setColors = function(colors) {
    /* set the colors, one for each value of a in setColorArr(a). colors is an
     * array of six-digit hex strings. Not #-prefixed! */
       self.col.pal = colors;
    };

    this.calcRadius = function() {
        /* calculate the radius from current zoom factor and set radius, alpha and zoomFact in self.port */
        // make the circles a bit smaller than expected
        var zr = self.port.zoomRange;
        var iz = self.port.initZoom;
        var initAlpha = self.port.initAlpha;
        var initSpan = iz.maxX-iz.minX;
        var currentSpan = zr.maxX-zr.minX;
        var zoomFact = initSpan/currentSpan;

        // both radius and alpha can be change by a 'multiplier'
        var alphaMult = self.port.alphaMult || 1.0;
        var radiusMult = self.port.radiusMult || 1.0;

        var baseRadius = self.port.initRadius;
        if (baseRadius===0)
            baseRadius = 0.7;
        var radius = Math.floor(baseRadius * Math.sqrt(zoomFact) * radiusMult);

        // the higher the zoom factor, the higher the alpha value
        var zoomFrac = Math.min(1.0, zoomFact/100.0); // zoom as fraction, max is 1.0
        var alpha = initAlpha + 3.0*zoomFrac*(1.0 - initAlpha);
        alpha = Math.min(0.8, alpha)*alphaMult;
        debug("Zoom factor: ", zoomFact, ", Radius: "+radius+", alpha: "+alpha);

        if (self.onRadiusAlphaChange)
            self.onRadiusAlphaChange(radiusMult, alphaMult);

        self.port.zoomFact = zoomFact;
        self.port.alpha = alpha;
        self.port.alphaMult = alphaMult;
        self.port.radius = radius;
        self.port.radiusMult = radiusMult;
    }

    this.drawSvg = function(alpha, radius, coords, colArr, pal) {
        self.svgLines = [];
        var plotHeight = self.canvas.height;
        var plotWidth = self.canvas.width;
        var width = plotWidth+self.svgLabelWidth;
        var height = 1500; // enough space for 100 lines in the legend
        self.svgLines.push("<svg  xmlns='http://www.w3.org/2000/svg' height='"+height+"' width='"+width+"'>\n");
        drawCirclesSvg(self.svgLines, coords, colArr, pal, radius, alpha, self.selCells);
        if (self.doDrawLabels===true && self.coords.labels!==null && self.coords.labels!==undefined)
            drawLabelsSvg(self.svgLines, self.coords.pxLabels, plotWidth, plotHeight, self.port.zoomFact);
        // axis lines
        self.svgLines.push('<line x1="2" y1="2" x2="2" y2="'+plotHeight+'" stroke="black" stroke-width="2"/>');
        self.svgLines.push('<line x1="2" y1="2" x2="'+plotWidth+'" y2="2" stroke="black" stroke-width="2"/>');

        // draw axis labels
        var initZoom = self.port.initZoom;
        // x axis
        self.svgLines.push("<text font-family='sans-serif' font-size='"+(gTextSize)+"' fill='black' text-anchor='left' x='"+10+"' y='"+(gTextSize+20)+"'>"+initZoom.minY+"</text>");
        self.svgLines.push("<text font-family='sans-serif' font-size='"+(gTextSize)+"' fill='black' text-anchor='left' x='"+10+"' y='"+(plotHeight-gTextSize-2)+"'>"+initZoom.maxY+"</text>");
        // y axis
        self.svgLines.push("<text font-family='sans-serif' font-size='"+(gTextSize)+"' fill='black' text-anchor='left' x='"+10+"' y='"+(gTextSize+3)+"'>"+initZoom.minX+"</text>");
        self.svgLines.push("<text font-family='sans-serif' font-size='"+(gTextSize)+"' fill='black' text-anchor='left' x='"+(plotWidth-40)+"' y='"+(gTextSize+3)+"'>"+initZoom.maxX+"</text>");
        return;
    }

    this.drawDots = function(doSvg) {
        /* draw coordinates to canvas with current colors */
        console.time("draw");

        self.clear();

        var radius = self.port.radius;
        var alpha = self.port.alpha;
        var zoomFact = self.port.zoomFact;
        var coords = self.coords.px;
        var pal = self.col.pal;
        var colArr = self.col.arr;
        var count = 0;

        if (alpha===undefined)
             alert("internal error: alpha is not defined");
        if (coords===null)
             alert("internal error: cannot draw if coordinates are not set yet");
        if (colArr && colArr.length !== (coords.length>>1))
            alert("internal error: cbDraw.drawDots - colorArr is not 1/2 of coords array. Got "+pal.length+" color values but coordinates for "+(coords.length/2)+" cells.");

        if (doSvg!==undefined) {
            self.drawSvg(alpha, radius, coords, colArr, pal);
            return;
        }

        drawBackground(self.ctx, self.background)

        // if the labels are not shown, fattening should not be active
        if (self.fatIdx && !self.doDrawLabels)
            self.fatIdx = null;

        if (radius===0) {
            count = drawPixels(self.ctx, self.canvas.width, self.canvas.height, coords,
                colArr, pal, alpha, self.selCells, self.fatIdx);
        }

        else if (radius===1 || radius===2) {
            count = drawRect(self.ctx, coords, colArr, pal, radius, alpha, self.selCells, self.fatIdx);
        }
        else {
            switch (self.mode) {
                case 0:
                    count = drawCirclesStupid   (self.ctx, coords, colArr, pal, radius, alpha, self.selCells, self.fatIdx);
                    break;
                case 1:
                    count = drawCirclesDrawImage(self.ctx, coords, colArr, pal, radius, alpha, self.selCells, self.fatIdx);
                    break;
                case 2:
                    break;
            }
        }

        self.count = count;

        console.timeEnd("draw");

        if (self.coords.pxLines) {
            console.time("draw lines");
            drawLines(self.ctx, self.coords.pxLines, self.canvas.width, self.canvas.height, self.coords.lineAttrs);
            console.timeEnd("draw lines");
        }

        if ((self.doDrawLabels===true && self.coords.labels!==null && self.coords.labels!==undefined)
            || self.coords.coordInfo.annots!==undefined) {
            self.drawLabels();
        }

        if (self.childPlot)
            self.childPlot.drawDots();
    };

    this.getSvgText = function() {
        /* close and return the accumulated svg lines and clear the svg line buffer */
        var svgLines = self.svgLines;
        svgLines.push("</svg>\n");
        self.svgLines = null;
        return svgLines;
    }

    this.drawLabels = function() {
        /* draw only the labels */
        self.coords.pxLabels = scaleLabels(
            self.coords.labels,
            self.port.zoomRange,
            self.port.radius,
            self.canvas.width,
            self.canvas.height
        );
        self.coords.labelBbox = drawLabels(
            self.ctx,
            self.coords.pxLabels,
            self.canvas.width,
            self.canvas.height,
            self.port.zoomFact
        );

        // draw annotations - look like labels, but cannot be clicked
        self.coords.pxAnnots = scaleLabels(
            self.coords.coordInfo.annots,
            self.port.zoomRange,
            self.port.radius,
            self.canvas.width,
            self.canvas.height
        );
        drawLabels(self.ctx, self.coords.pxAnnots, self.canvas.width, self.canvas.height, self.port.zoomFact, true);
    };

    this.cellsAtPixel = function(x, y) {
        /* return the Ids of all cells at a particular pixel */
        var res = [];
        var pxCoords = self.coords.px;
        for (var i = 0; i < pxCoords.length/2; i++) {
            var cellX = pxCoords[i*2];
            var cellY = pxCoords[i*2+1];
            if (cellX===x || cellY===y)
                res.push(i);
        }
        return res;
    };

    this.cellsInRect = function(x1, y1, x2, y2) {
        /* return the Ids of all cells within certain pixel boundaries */
        var res = [];
        var pxCoords = self.coords.px;
        for (var i = 0; i < pxCoords.length/2; i++) {
            var cellX = pxCoords[i*2];
            var cellY = pxCoords[i*2+1];
            if ((cellX >= x1) && (cellX <= x2) && (cellY >= y1) && (cellY <= y2))
                res.push(i);
        }
        return res;
    };

    this.resetAlpha = function() {
       self.port.alphaMult = 1.0;
       $('#mpAlphaSlider').slider({value:4});
       self.calcRadius();
    };

    this.resetRadius = function() {
       self.port.radiusMult = 1.0;
       $('#mpRadiusSlider').slider({value:4});
       self.calcRadius();
    };

    this.setRadiusAlpha = function(radius, alpha) {
       self.port.radiusMult = radius;
       self.port.alphaMult = alpha;
       self.calcRadius();
    };

    this.zoom100 = function() {
       /* zoom to 100% and redraw */
       copyObj(self.port.initZoom, self.port.zoomRange);
       self.resetAlpha();
       self.resetRadius();
       self.scaleData();
    };

    this.zoomToTest = function(x1, y1, x2, y2) {
       self.port.zoomRange = {"minX":x1, "minY":y1, "maxX":x2, "maxY":y2};
       self.scaleData();
    }

    this.zoomTo = function(x1, y1, x2, y2) {
       /* zoom to rectangle defined by two pixel points */
       // make sure that x1<x2 and y1<y2 - can happen if mouse movement was upwards
       debug("Zooming to pixels: ", x1, y1, x2, y2);
       var pxMinX = Math.min(x1, x2);
       var pxMaxX = Math.max(x1, x2);

       var pxMinY = Math.min(y1, y2);
       var pxMaxY = Math.max(y1, y2);

       var zoomRange = self.port.zoomRange;
       // window size in data coordinates
       var spanX = zoomRange.maxX - zoomRange.minX;
       var spanY = zoomRange.maxY - zoomRange.minY;

       // multiplier to convert from pixels to data coordinates
       var xMult = spanX / self.canvas.width; // multiplier dataRange/pixel
       var yMult = spanY / self.canvas.height;

       var oldMinX = zoomRange.minX;
       var oldMinY = zoomRange.minY;

       zoomRange.minX = oldMinX + (pxMinX * xMult);
       zoomRange.minY = oldMinY + (pxMinY * yMult);

       zoomRange.maxX = oldMinX + (pxMaxX * xMult);
       zoomRange.maxY = oldMinY + (pxMaxY * yMult);

       self.port.zoomRange = zoomRange;
       debug("Marquee zoom window: "+JSON.stringify(self.port.zoomRange));

       self.scaleData();
    };

    this.zoomBy = function(zoomFact, xPx, yPx) {
    /* zoom centered around xPx,yPx by a given factor. Returns new zoom range.
     * zoomFact = 1.2 means zoom +20%
     * zoomFact = 0.8 means zoom -20%
     * */
        var zr = self.port.zoomRange;
        var iz = self.port.initZoom;

        var xRange = Math.abs(zr.maxX-zr.minX);
        var yRange = Math.abs(zr.maxY-zr.minY);

        var minWeightX = 0.5; // how zooming should be distributed between min/max
        var minWeightY = 0.5;
        if (xPx!==undefined) {
            minWeightX = (xPx/self.width);
            minWeightY = (yPx/self.canvas.height);
        }
        var scale = (1.0-zoomFact);

        var newRange = {};
        newRange.minX = zr.minX - (xRange*scale*minWeightX);
        newRange.maxX = zr.maxX + (xRange*scale*(1-minWeightX));

        // inversed, because we flip the Y axis (flipY)
        newRange.minY = zr.minY - (yRange*scale*(1-minWeightY));
        newRange.maxY = zr.maxY + (yRange*scale*(minWeightY));

        // extreme zoom factors don't make sense, at some point we reach
        // the limit of the floating point numbers
        var newZoom = ((iz.maxX-iz.minX)/(newRange.maxX-newRange.minX));
        if (newZoom < 0.01 || newZoom > 1500)
            return zr;

        debug("x min max "+zr.minX+" "+zr.maxX);
        debug("y min max "+zr.minY+" "+zr.maxY);

        self.port.zoomRange = newRange;

        self.scaleData();

        // a special case for connected plots that are not sharing our pixel coordinates
        if (self.childPlot && self.coords===self.childPlot.coords) {
            self.childPlot.zoomBy(zoomFact, xPx, yPx);
        }

        return newRange;
    };

    this.movePerc = function(xDiffFrac, yDiffFrac) {
        /* move a certain percentage of current view. xDiff/yDiff are floats, e.g. 0.1 is 10% up */
        var zr = self.port.zoomRange;
        var xRange = Math.abs(zr.maxX-zr.minX);
        var yRange = Math.abs(zr.maxY-zr.minY);

        var xDiffAbs = xRange*xDiffFrac;
        var yDiffAbs = yRange*yDiffFrac;

        var newRange = {};
        newRange.minX = zr.minX + xDiffAbs;
        newRange.maxX = zr.maxX + xDiffAbs;
        newRange.minY = zr.minY + yDiffAbs;
        newRange.maxY = zr.maxY + yDiffAbs;

        copyObj(newRange, self.port.zoomRange);
        self.scaleData();
    };

    this.panStart = function() {
       /* called when starting a panning sequence, makes a snapshop of the current image */
       self.panCopy = document.createElement('canvas'); // not added to DOM, will be gc'ed
       self.panCopy.width = self.canvas.width;
       self.panCopy.height = self.canvas.height;
       var destCtx = self.panCopy.getContext("2d", { alpha: false });
       destCtx.drawImage(self.canvas, 0, 0);
    }

    this.panBy = function(xDiff, yDiff) {
        /* pan current image by x/y pixels */
        debug('panning by '+xDiff+' '+yDiff);

       //var srcCtx = self.panCopy.getContext("2d", { alpha: false });
       clearCanvas(self.ctx, self.canvas.width, self.canvas.height);
       self.ctx.drawImage(self.panCopy, -xDiff, -yDiff);
       // keep these for panEnd
       self.panDiffX = xDiff;
       self.panDiffY = yDiff;
    }

    this.panEnd = function() {
        /* end a sequence of panBy calls, called when the mouse is released */
        self.moveBy(self.panDiffX, -self.panDiffY); // -1 because of flipY
        self.panCopy = null;
        self.panDiffX = null;
        self.panDiffY = null;
    }

    // BEGIN SELECTION METHODS (could be an object?)

    this.selectClear = function(skipNotify) {
        /* clear selection */
        self.selCells.clear();
        setStatus("");
        if (self.onSelChange!==null && skipNotify!==true)
            self.onSelChange(self.selCells);
    };

    this.selectSet = function(cellIds) {
        /* set selection to an array of integer cellIds */
        self.selCells.clear();
        //self.selCells.push(...cellIds); // "extend" = array spread syntax, https://davidwalsh.name/spread-operator
        let selCells = self.selCells;
        for (let i=0; i<cellIds.length; i++)
            selCells.add(cellIds[i]);
        self._selUpdate();
    };

    this.selectAdd = function(cellIdx) {
        /* add a single cell to the selection. If it already exists, remove it. */
        console.time("selectAdd");
        if (self.selCells.has(cellIdx))
            self.selCells.delete(cellIdx);
        else
            self.selCells.add(cellIdx);
        console.time("selectAdd");
        self._selUpdate();
    };

    this.selectAll = function(cellIdx) {
        /* add all cells to selection */
        var selCells = self.selCells;
        var pxCoords = self.coords.px;
        for (var i = 0, I = pxCoords.length / 2; i < I; i++) {
            selCells.add(i);
        }
        self.selCells = selCells;
        self._selUpdate();
    };

    this.selectVisible = function() {
        /* add all visible cells to selection */
        var selCells = self.selCells;
        var pxCoords = self.coords.px;
        for (var i = 0; i < pxCoords.length/2; i++) {
            var pxX = pxCoords[2*i];
            var pxY = pxCoords[2*i+1];
            if (isHidden(pxX, pxY))
               continue;
            selCells.add(i);
        }
        self.selCells = selCells;
        self._selUpdate();
    }

    this.selectByColor = function(colIdx) {
        /* add all cells with a given color to the selection */
        var colArr = self.col.arr;
        var selCells = self.selCells;
        var cnt = 0;
        for (var i = 0; i < colArr.length; i++) {
            if (colArr[i]===colIdx) {
                selCells.add(i);
                cnt++;
            }
        }
        self.selCells = selCells;
        debug(cnt + " cells appended to selection, by color");
        self._selUpdate();
    };

    this.unselectByColor = function(colIdx) {
        /* remove all cells with a given color from the selection */
        var colArr = self.col.arr;
        var selCells = self.selCells;
        var cnt = 0;
        for (var i = 0; i < colArr.length; i++) {
            if (colArr[i]===colIdx) {
                selCells.delete(i);
                cnt++;
            }
        }

        self.selCells = selCells;
        debug(cnt + " cells removed from selection, by color");
        self._selUpdate();
    };

    this.selectInRect = function(x1, y1, x2, y2) {
        /* find all cells within a rectangle and add them to the selection. */
        var minX = Math.min(x1, x2);
        var maxX = Math.max(x1, x2);

        var minY = Math.min(y1, y2);
        var maxY = Math.max(y1, y2);

        console.time("select");
        var pxCoords = self.coords.px;
        for (var i = 0; i < pxCoords.length/2; i++) {
            var pxX = pxCoords[2*i];
            var pxY = pxCoords[2*i+1];
            if (isHidden(pxX, pxY))
               continue;
            if ((minX <= pxX) && (pxX <= maxX) && (minY <= pxY) && (pxY <= maxY)) {
                self.selCells.add(i);
            }

        }
        console.timeEnd("select");
        self._selUpdate();
    };

    this.hasSelected = function() {
        return (self.selCells.size!==0)
    }

    this.hasAllSelected = function() {
        return (self.selCells.length===self.getCount());
    }

    this.getSelection = function() {
        /* return selected cells as a list of ints */
        var cellIds = [];
        self.selCells.forEach(function(x) {cellIds.push(x)});
        return cellIds;
    };

    this.selectInvert = function() {
        /* invert selection */
        var selCells = self.selCells;
        var cellCount = self.getCount();
        for (let i = 0; i < cellCount; i++) {
            if (selCells.has(i)) {
                selCells.delete(i);
            } else {
                selCells.add(i);
            }
        }
        self.selCells = selCells;
        self._selUpdate();
    };

    this.selectOnlyShow = function() {
    /* the opposite of selectHide() = remove all coords that are not selected */
        var selCells = self.selCells;
        if (selCells.size===0)
            return;

        if (self.coords.origAll===undefined)
            self.coords.origAll = cloneArray(self.coords.orig);
        var coords = self.coords.orig;
        for (var i = 0; i < coords.length/2; i++) {
            if (!selCells.has(i)) {
                coords[2*i] = HIDCOORD;
                coords[2*i+1] = HIDCOORD;
            }
        }
        self.scaleData();
        self._selUpdate();
    }


    this.selectHide = function() {
    /* remove all coords that are selected */
        if (self.coords.origAll===undefined)
            self.coords.origAll = cloneArray(self.coords.orig);

        var selCells = self.selCells;
        var coords = self.coords.orig;

        for (var i = 0; i < coords.length/2; i++) {
            if (selCells.has(i)) {
                coords[2*i] = HIDCOORD;
                coords[2*i+1] = HIDCOORD;
            }
        }

        self.scaleData();
        self.selectSet([]);
        self._selUpdate();
    }   

    this.unhideAll = function() {
        /* undo the hide operation */
        if (self.coords.origAll!==undefined) {
            self.coords.orig = self.coords.origAll;
            self.coords.origAll = undefined;
        }
        self.scaleData();
    }

    this.getCount = function() {
        /* return maximum number of cells in dataset, may include hidden cells, see isHidden() */
        return self.coords.orig.length / 2;
    };

    this.getVisibleCount = function() {
        /* return number of cells that are visible */
        let count = 0;
        let coords = self.coords.orig;
        for (var i = 0; i < coords.length/2; i++) {
            if (!isHidden(coords[2*i], coords[2*i+1]))
                count++;
        }
        return count;
    };

    // END SELECTION METHODS (could be an object?)

    this._selUpdate = function() {
        /* called after the selection has been updated, calls the onSelChange callback */
        setStatus(self.selCells.size + " " + self.gSampleDescription + "s selected");
        if (self.onSelChange!==null)
            self.onSelChange(self.selCells);
    }

    this.moveBy = function(xDiff, yDiff) {
        /* update the pxCoords by a certain x/y distance and redraw */

        // convert pixel range to data scale range
        var zr = self.port.zoomRange;
        var xDiffData = xDiff * ((zr.maxX - zr.minX) / self.canvas.width);
        var yDiffData = yDiff * ((zr.maxY - zr.minY) / self.canvas.height);

        // move zoom range
        zr.minX = zr.minX + xDiffData;
        zr.maxX = zr.maxX + xDiffData;
        zr.minY = zr.minY + yDiffData;
        zr.maxY = zr.maxY + yDiffData;

        self.scaleData();

        // a special case for connected plots that are not sharing our pixel coordinates
        if (self.childPlot && self.coords===self.childPlot.coords) {
            self.childPlot.moveBy(xDiff, yDiff);
        }
    };

    this.labelAt = function(x, y) {
        /* return the index and the text of the label at position x,y or null if nothing there */
        //console.time("labelCheck");
        var clusterLabels = self.coords.labels;
        if (clusterLabels===null || clusterLabels===undefined)
            return null;
        var labelCoords = self.coords.labels;
        var boxes = self.coords.labelBbox;

        if (boxes==null) // no cluster labels
            return null;

        if (labelCoords.length!==clusterLabels.length)
            alert("internal error maxPLot.js: coordinates of labels are different from clusterLabels");

        for (var i=0; i < labelCoords.length; i++) {
            var box = boxes[i];
            if (box===null) // = outside of the screen
                continue;
            var x1 = box[0];
            var y1 = box[1];
            var x2 = box[2];
            var y2 = box[3];
            if ((x >= x1) && (x <= x2) && (y >= y1) && (y <= y2)) {
                //console.timeEnd("labelCheck");
                var labelText = clusterLabels[i][2];
                return [labelText, i];
            }
        }
        //console.timeEnd("labelCheck");
        return null;
    };

    this.lineAt = function(x, y) {
        /* check if there is a line at x,y and return its label if so or null if not */
            var pxLines = self.coords.pxLines;
            for (var i=0; i < pxLines.length; i++) {
                var line = pxLines[i];
                var x1 = line[0];
                var y1 = line[1];
                var x2 = line[2];
                var y2 = line[3];
                if (pDistance(x, y, x1, y1, x2, y2) <= 2) {
                    var lineLabel = self.coords.lineLabels[i];
                    return lineLabel;
                }
            }
            return null;
    };

    this.cellsAt = function(x, y) {
        /* check which cell's bounding boxes contain (x, y), return a list of the cell IDs, sorted by distance */
        //console.time("cellSearch");
        var pxCoords = self.coords.px;
        if (pxCoords===null)
            return null;
        var possIds = [];
        var radius = self.port.radius;
        for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
            if (isHidden(pxX, pxY))
               continue;
            var x1 = pxX - radius;
            var y1 = pxY - radius;
            var x2 = pxX + radius;
            var y2 = pxY + radius;
            if ((x >= x1) && (x <= x2) && (y >= y1) && (y <= y2)) {
                var dist = Math.sqrt(Math.pow(x-pxX, 2) + Math.pow(y-pxY, 2));
                possIds.push([dist, i]);
            }
        }

        //console.timeEnd("cellSearch");
        if (possIds.length===0)
            return null;
        else {
            possIds.sort(function(a,b) { return a[0]-b[0]} ); // sort by distance

            // strip the distance information
            var ret = [];
            for (let i=0; i < possIds.length; i++) {
                ret.push(possIds[i][1]);
            }
            return ret;
        }
    };

    this.resetMarquee = function() {
       /* make the marquee disappear and reset its internal status */
       if (!self.interact)
           return;

       self.mouseDownX = null;
       self.mouseDownY = null;
       self.lastPanX = null;
       self.lastPanY = null;
       self.selectBox.style.display = "none";
       self.selectBox.style.width = 0;
       self.selectBox.style.height = 0;
    };

    this.drawMarquee = function(x1, y1, x2, y2, forceAspect) {
        /* draw the selection or zooming marquee using the DIVs created by setupMouse */
        var selectWidth = Math.abs(x1 - x2);
        var selectHeight = 0;
        if (forceAspect) {
            var aspectRatio = self.width / self.canvas.height;
            selectHeight = selectWidth/aspectRatio;
        } else
            selectHeight = Math.abs(y1 - y2);

        var minX = Math.min(x1, x2);
        var minY = Math.min(y1, y2);
        var div = self.selectBox;
        div.style.left = (minX-self.left)+"px";
        div.style.top = (minY-self.top)+"px";
        div.style.width = selectWidth+"px";
        div.style.height = selectHeight+"px";
        div.style.display = "block";
    };

    this.activatePlot = function() {
        /* draw black border around plot, remove black border from all connected plots, call onActive */
        if (self.parentPlot===null)
            return false;

        // only need to do something if we're not already the active plot
        self.canvas.style["border"] = "2px solid black";
        self.parentPlot.canvas.style["border"] = "2px solid white";

        // flip the parent/child relationship
        self.childPlot = self.parentPlot;
        self.childPlot.parentPlot = self;
        self.parentPlot = null;
        self.childPlot.childPlot = null;

        // hide/show the tool and zoom buttons
        self.childPlot.zoomDiv.style.display = "none";
        self.childPlot.toolDiv.style.display = "none";
        self.zoomDiv.style.display = "block";
        self.toolDiv.style.display = "block";

        // notify the UI
        self.onActiveChange(self);
        return true;
    }

    this.isSplit = function() {
        /* return true if this renderer has either a parent or a child plot = is in split screen mode */
        return (isValid(self.parentPlot) || isValid(self.childPlot))
    }

    // https://stackoverflow.com/questions/73187456/canvas-determine-if-point-is-on-line
    //function distancePointFromLine(x0, y0, x1, y1, x2, y2) {
          //return Math.abs((x2 - x1) * (y1 - y0) - (x1 - x0) * (y2 - y1)) / Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
    //}
    function pDistance(x, y, x1, y1, x2, y2) {
      /* distance of point from line segment, copied from https://stackoverflow.com/questions/849211/shortest-distance-between-a-point-and-a-line-segment */
      var A = x - x1;
      var B = y - y1;
      var C = x2 - x1;
      var D = y2 - y1;

      var dot = A * C + B * D;
      var len_sq = C * C + D * D;
      var param = -1;
      if (len_sq != 0) //in case of 0 length line
          param = dot / len_sq;

      var xx, yy;

      if (param < 0) {
        xx = x1;
        yy = y1;
      }
      else if (param > 1) {
        xx = x2;
        yy = y2;
      }
      else {
        xx = x1 + param * C;
        yy = y1 + param * D;
      }

      var dx = x - xx;
      var dy = y - yy;
      return Math.sqrt(dx * dx + dy * dy);
    }

    this.onMouseMove = function(ev) {
        /* called when the mouse is moved over the Canvas */

        // set a timer so we can get "hover" functionality without too much CPU
        if (self.timer!==null)
            clearTimeout(self.timer);
        self.timer = setTimeout(self.onNoMouseMove, 130);
        // save mouse pos for onNoMouseMove timer handler
        self.lastMouseX = ev.clientX;
        self.lastMouseY = ev.clientY;

        // label hit check requires canvas coordinates x/y
        var clientX = ev.clientX;
        var clientY = ev.clientY;
        var canvasTop = self.top;
        var canvasLeft = self.left;
        var xCanvas = clientX - canvasLeft;
        var yCanvas = clientY - canvasTop;

        // is there just white space under the mouse, do nothing,
        // from https://stackoverflow.com/questions/15325283/how-to-detect-if-a-mouse-pointer-hits-a-line-already-drawn-on-an-html-5-canvas
        //var imageData = self.ctx.getImageData(0, 0, self.width, self.height);
        //var inputData = imageData.data;
        //var pData = (~~xCanvas + (~~yCanvas * self.width)) * 4;

        //if (!inputData[pData + 3]) {
            //console.log("just white space under mouse");
            //return;
        //}

        // when the cursor is over a label, change it to a hand, but only when there is no marquee
        if (self.coords.labelBbox!==null && self.mouseDownX === null) {
            var labelInfo = self.labelAt(xCanvas, yCanvas);
            if (labelInfo===null) {
                self.canvas.style.cursor = self.canvasCursor;
                self.onNoLabelHover(ev);
            } else {
                self.canvas.style.cursor = 'pointer'; // not 'hand' anymore ! and not 'grab' yet!
                if (self.onLabelHover!==null)
                    self.onLabelHover(labelInfo[0], labelInfo[1], ev);
                }
        }

        // when the cursor is over a line, trigger callback
        if (self.onLineHover && self.coords.lineLabels) {
            var lineLabel = self.lineAt(xCanvas, yCanvas);
            self.onLineHover(lineLabel, ev);
        }       

        if (self.mouseDownX!==null) {
            // we're panning
            if (((ev.altKey || self.dragMode==="move")) && self.panCopy!==null) {
                var xDiff = self.mouseDownX - clientX;
                var yDiff = self.mouseDownY - clientY;
                self.panBy(xDiff, yDiff);
            }
            else  {
               // zooming or selecting
               var forceAspect = false;
               var anyKey = (ev.metaKey || ev.altKey || ev.shiftKey);
               if ((self.dragMode==="zoom" && !anyKey) || ev.metaKey )
                   forceAspect = true;
               self.drawMarquee(self.mouseDownX, self.mouseDownY, clientX, clientY, forceAspect);
            }
        }
    };

    this.onNoMouseMove = function() {
        /* called after some time has elapsed and the mouse has not been moved */
        if (self.coords.px===null)
            return;
        var x = self.lastMouseX - self.left; // need canvas, not screen coordinates
        var y = self.lastMouseY - self.top;
        var cellIds = self.cellsAt(x, y);
        // only call onNoCellHover if callback exists and there is nothing selected
        if (cellIds===null && self.onNoCellHover!==null && self.selCells===null)
                self.onNoCellHover();
        else if (self.onCellHover!==null)
                self.onCellHover(cellIds);
    };


    this.onMouseDown = function(ev) {
    /* user clicks onto canvas */
       if (self.activatePlot())
           return; // ignore the first click into the plot, if it was the activating click
       debug("background mouse down");
       var clientX = ev.clientX;
       var clientY = ev.clientY;
       if ((ev.altKey || self.dragMode==="move") && !ev.shiftKey && !ev.metaKey) {
           debug("alt key or move mode: starting panning");
           self.panStart();
       }
       self.mouseDownX = clientX;
       self.mouseDownY = clientY;
    };

    this.onMouseUp = function(ev) {
       debug("background mouse up");
       // these are screen coordinates
       var clientX = ev.clientX;
       var clientY = ev.clientY;
       var mouseDidNotMove = (self.mouseDownX === clientX && self.mouseDownY === clientY);

       if (self.panCopy!==null && !mouseDidNotMove) {
           debug("ending panning operation");
           self.panEnd();
           self.mouseDownX = null;
           self.mouseDownY = null;
           self.drawDots();
           return;
       } else {
           // abort panning
           self.panCopy = null;
       }

       if (self.mouseDownX === null && self.lastPanX === null)  {
           // user started the click outside of the canvas: do nothing
           debug("first click must have been outside of canvas");
           return;
       }

       // the subsequent operations require canvas coordinates x/y
       var canvasTop = self.top;
       var canvasLeft = self.left;
       var x1 = self.mouseDownX - canvasLeft;
       var y1 = self.mouseDownY - canvasTop;
       var x2 = clientX - canvasLeft;
       var y2 = clientY - canvasTop;

       // user did not move the mouse, so this is a click
       if (mouseDidNotMove) {
            // recognize a double click -> zoom
            if (self.lastClick!==undefined && x2===self.lastClick[0] && y2===self.lastClick[1]) {
                self.zoomBy(1.33);
                self.lastClick = [-1,-1];
            } else {
                self.lastClick = [x2, y2];
            }

            var labelInfo = self.labelAt(x2, y2);
            if (labelInfo!==null && self.doDrawLabels)
                self.onLabelClick(labelInfo[0], labelInfo[1], ev);
            else {
                var clickedCellIds = self.cellsAt(x2, y2);
                // click on a cell -> update selection and redraw
                if (clickedCellIds!==null && self.onCellClick!==null) {
                    self.selectClear(true);
                    for (var i = 0; i < clickedCellIds.length; i++) {
                        self.selCells.add(clickedCellIds[i]);
                    }
                    self.drawDots();
                    self.onCellClick(clickedCellIds, ev);

                }
                else {
                // user clicked onto background:
                // reset selection and redraw
                    debug("not moved at all: reset "+clientX+" "+self.mouseDownX+" "+self.mouseDownY+" "+clientY);
                    self.selectClear();

                    self.drawDots();
                }

                self.lastPanX = null;
                self.lastPanY = null;
            }
            self.mouseDownX = null;
            self.mouseDownY = null;
            return;
       }
       //debug("moved: reset "+x+" "+mouseDownX+" "+mouseDownY+" "+y);

       // it wasn't a click, so it was a drag
       var anyKey = (ev.metaKey || ev.altKey || ev.shiftKey);

       // zooming
       if ((self.dragMode==="zoom" && !anyKey) || ev.metaKey ) {
            // get current coords of the marquee in canvas pixels
            var div = self.selectBox;
            let zoomX1 = parseInt(div.style.left.replace("px",""));
            let zoomY1 = parseInt(div.style.top.replace("px",""));
            let zoomX2 = zoomX1+parseInt(div.style.width.replace("px",""));
            let zoomY2 = zoomY1+parseInt(div.style.height.replace("px",""));
            zoomY1 = self.canvas.height - zoomY1;
            zoomY2 = self.canvas.height - zoomY2;
            self.zoomTo(zoomX1, zoomY1, zoomX2, zoomY2);
            // switch back to the mode before zoom was clicked
            if (self.prevMode) {
                self.activateMode(self.prevMode);
                self.prevMode = null;
            }


       }
       // marquee select
       else if ((self.dragMode==="select" && !anyKey) || ev.shiftKey ) {
           if (! ev.shiftKey)
               self.selectClear(true);
           self.selectInRect(x1, y1, x2, y2);
       }
       else {
           debug("Internal error: no mode?");
       }

       self.resetMarquee();

       self.drawDots();
    };

    function drawCirclesSvg(svgLines, pxCoords, coordColors, colors, radius, alpha, selCells) {
    /* add SVG text to the array svgLines */
       debug("Drawing "+coordColors.length+" circles with SVG renderer");
       var count = 0;
       for (var i = 0; i < pxCoords.length/2; i++) {
           var pxX = pxCoords[2*i];
           var pxY = pxCoords[2*i+1];
           if (isHidden(pxX, pxY))
               continue;
           var col = colors[coordColors[i]];

           svgLines.push("<circle cx='"+pxX+"' cy='"+pxY+"' r='"+radius+"' fill-opacity='"+alpha+"' fill='#"+col+"' />");
           count++;
       }
       return count;
    }

    this.onWheel = function(ev) {
        /* called when the user moves the mouse wheel */
        if (self.parentPlot!==null)
            return;
        debug(ev);
        var normWheel = normalizeWheel(ev);
        debug(normWheel);
        var pxX = ev.clientX - self.left;
        var pxY = ev.clientY - self.top;
        var spinFact = 0.1;
       if (ev.ctrlKey) // = OSX pinch and zoom gesture (and no other OS/mouse combination?)
            spinFact = 0.08;  // is too fast, so slow it down a little
        var zoomFact = 1-(spinFact*normWheel.spinY);
        debug("Wheel Zoom by "+zoomFact);
        self.zoomBy(zoomFact, pxX, pxY);
        self.drawDots();
        ev.preventDefault();
        ev.stopPropagation();
    };

    this.setupMouse = function() {
       // setup the mouse callbacks
       self.canvas.addEventListener('mousedown', self.onMouseDown);
       self.canvas.addEventListener("mousemove", self.onMouseMove);
       self.canvas.addEventListener("mouseup", self.onMouseUp);
       // when the user moves the mouse, the mouse is often NOT on the canvas,
       // but on the marquee box, so connect this one, too.
       self.selectBox.addEventListener("mouseup", self.onMouseUp);

       self.canvas.addEventListener("wheel", self.onWheel);
    };

    this.setShowLabels = function(trueOrFalse) {
        /* this is separate from setLabelField, so you can switch it off and on quickly */
        self.doDrawLabels = trueOrFalse;
    }
        
    this.setLabelField = function(fieldName) {
        /* this is only to keep track of what the current label field is. 
           Switches off label drawing if fieldName is null */
        self.activeLabelField = fieldName;
        self.setShowLabels( fieldName!==null )
    };

    this.getLabelField = function(fieldName) {
        return self.activeLabelField;
    };

    this.getLabels = function() {
        /* get current labels */
        var ret = [];
        var labels = self.coords.labels;
        for (var i = 0; i<labels.length; i++)
            ret.push(labels[i][2]);
        return ret;
    }

    this.setLabels = function(newLabels) {
        /* set new label text */
        if (newLabels.length!==self.coords.labels.length) {
            debug("maxPlot:setLabels error: new labels have wrong length.");
            return;
        }

        for (var i = 0; i<newLabels.length; i++)
            self.coords.labels[i][2] = newLabels[i];

        self.coords.pxLabels = scaleLabels(self.coords.labels, self.port.zoomRange, self.port.radius,
                                           self.canvas.width, self.canvas.height);

        if (self.coords.annots) {
            let pxAnnots = scaleLabels(self.coords.annots, self.port.zoomRange, self.port.radius,
                                           self.canvas.width, self.canvas.height);
            for (let pxa of pxAnnots)
                self.coords.labels.push(pxa);
        }

        // a special case for connected plots that are not sharing our pixel coordinates
        if (self.childPlot && self.coords!==self.childPlot.coords) {
           self.childPlot.setLabels(newLabels);
        }
    };

    this._setLines = function(lines, attrs) {
        /* set the line attributes */
        if (lines===undefined)
            return;
        self.coords.lines = lines;

        if (!attrs)
            self.coords.lineAttrs = {};
        else
            self.coords.lineAttrs = attrs;

        // save the labels elsewhere. Labels are optional.
        if (lines[0].length > 4) {
            var lineLabels = []
            for (var i=0; i<lines.length; i++) {
                lineLabels.push(lines[i][4]);
            }
            self.coords.lineLabels = lineLabels;
        }
    }

    this.activateMode = function(modeName) {
    /* switch to one of the mouse drag modes: zoom, select or move */
        if (modeName==="zoom")
            self.prevMode = self.dragMode;
        else
            self.prevMode = null;

        self.dragMode=modeName;

        var cursor = null;

        if (modeName==="move")
            cursor = 'all-scroll';
        else if (modeName==="zoom")
            cursor = "zoom-in"
        else if (modeName=="select")
            cursor = 'crosshair';
        //else
            //cursor= 'default';

        self.canvas.style.cursor = cursor;
        self.canvasCursor = cursor;

        self.resetMarquee();

        if (self.interact) {
            self.icons["move"].style.backgroundColor = gButtonBackground;
            self.icons["zoom"].style.backgroundColor = gButtonBackground;
            self.icons["select"].style.backgroundColor = gButtonBackground;
            self.icons[modeName].style.backgroundColor = gButtonBackgroundClicked;
        }
        if (self.childPlot)
            self.childPlot.activateMode(modeName);
    }

    this.randomDots = function(n, radius, mode) {
        /* draw x random dots with x random colors*/
	function randomArray(ArrType, length, max) {
            /* make Array and fill it with random numbers up to max */
            var arr = new ArrType(length);
            for (var i = 0; i<length; i++) {
                arr[i] = Math.round(Math.random() * max);
            }
            return arr;
	}

        if (mode!==undefined)
            self.mode = mode;
        self.port.radius = radius;
	self.setCoords(randomArray(Uint16Array, 2*n, 65535));
	self.setColors(["FF0000", "00FF00", "0000FF", "CC00CC", "008800"]);
	self.setColorArr(randomArray(Uint8Array, n, 4));

        console.time("draw");
        self.drawDots();
        console.timeEnd("draw");
        return self;
    };

    this.split = function() {
        /* reduce width of renderer, create new renderer and place both side-by-side.
         * They initially share the .coords but setCoords() can break that relationship.
         * */
        var canvHeight  = self.canvas.height;
        var canvLeft    = self.left;
        var newWidth = self.width/2;
        var newTop   = self.top;
        var newLeft  = self.left+newWidth;
        var newHeight = canvHeight+gStatusHeight;

        var newDiv = document.createElement('div');
        newDiv.id = "mpPlot2";
        document.body.appendChild(newDiv);

        var opts = cloneObj(self.globalOpts);
        opts.showClose = true;

        var plot2 = new MaxPlot(newDiv, newTop, newLeft, newWidth, newHeight, {"showClose" : true, "showSliders" : false});

        plot2.statusLine.style.display = "none";

        plot2.port = self.port;
        plot2.selCells = self.selCells;

        plot2.coords = self.coords;

        plot2.col = {};
        plot2.col.pal = self.col.pal;
        plot2.col.arr = self.col.arr;

        if (self.background)
            plot2.setBackground (self.background.image);

        self.setSize(newWidth, newHeight, false); // will call scaleData(), but not redraw.

        plot2.onLabelClick = self.onLabelClick;
        plot2.onCellClick = self.onCellClick;
        plot2.onCellHover = self.onCellHover;
        plot2.onNoCellHover = self.onNoCellHover;
        plot2.onSelChange = self.onSelChange;
        plot2.onLabelHover = self.onLabelHover;
        plot2.onNoLabelHover = self.onNoLabelHover;
        plot2.onActiveChange = self.onActiveChange;

        plot2.drawDots();

        self.childPlot = plot2;
        plot2.parentPlot = self;

        // add a thick border and hide the menus in the child
        self.canvas.style["border"] = "2px solid black";
        self.childPlot.zoomDiv.style.display = "none";
        self.childPlot.toolDiv.style.display = "none";

        return plot2;
    };

    this.unsplit = function() {
        /* remove the connected non-active renderer */
        //var canvWidth = window.innerWidth - canvLeft - legendBarWidth;
        var otherRend = self.childPlot;
        self.childPlot = undefined;
        if (!otherRend) {
            otherRend = self.parentPlot;
            self.parentPlot = undefined;
        }
        self.setSize(self.width*2, self.height, false);

        otherRend.div.remove();
        self.canvas.style["border"] = "none";
        return;
    }

    this.getWidth = function() {
        /* return total size of renderer, including any split child renderers */
        if (self.childPlot)
            return self.width + self.childPlot.width;
        else
            return self.width;
    }

    this.calcMedian = function(coords, values, names, numNames) {
        /* given an array of coordinates (x at even positions, y at odd positions) and an array of names for each of them
         * return the median for each name as an object name -> array of [x, y, count]
         * if names is undefined, will use numNames and convert to two decimals 
         * */
        var calc = {};
        for (var i = 0, I = values.length; i < I; i++) {
            var label = null;
            if (names) {
                label = names[values[i]];
            } else {
                label = numNames[i].toFixed(2);
            }
            if (calc[label] === undefined) {
                calc[label] = [[], [], 0]; // all X, all Y, count
            }
            var x = coords[i * 2];
            var y = coords[i * 2 + 1];

            if (isHidden(x, y))
                continue;

            calc[label][0].push(x);
            calc[label][1].push(y);
            calc[label][2] += 1;
        }
        return calc;
    }

    // object constructor code
    self.initCanvas(div, top, left, width, height, args);
    self.initPlot(args);
}

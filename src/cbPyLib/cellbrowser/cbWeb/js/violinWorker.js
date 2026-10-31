/*
 * violinWorker.js - Web Worker for violin plot statistics computation.
 *
 * Receives Float32Array expression vectors from the main thread via zero-copy
 * Transferable, computes violin statistics off the main thread, and posts back
 * compact summary data (quantiles + KDE density curve) for rendering.
 *
 * Message in:  { arrays: [Float32Array, ...], labels: [...], doLog2: bool, reqId: int }
 * Message out: { results: [{...stats...}, ...], labels: [...], reqId: int }
 */

"use strict";

self.onmessage = function(e) {
    var arrays  = e.data.arrays;
    var labels  = e.data.labels;
    var doLog2  = e.data.doLog2;
    var reqId   = e.data.reqId;

    var results = [];
    for (var i = 0; i < arrays.length; i++) {
        results.push(computeViolinStats(arrays[i], doLog2));
    }

    self.postMessage({ results: results, labels: labels, reqId: reqId });
};

function log2Transform(arr) {
    /* apply log2(x + 1) in-place */
    for (var i = 0; i < arr.length; i++) {
        arr[i] = Math.log2(arr[i] + 1);
    }
}

function computeViolinStats(arr, doLog2) {
    var n = arr.length;
    if (n === 0) {
        return { q1:0, q3:0, median:0, whiskerLow:0, whiskerHigh:0,
                 minVal:0, maxVal:0, densityX:new Float32Array(0),
                 densityY:new Float32Array(0), n:0 };
    }

    if (doLog2) {
        log2Transform(arr);
    }

    /* Sort in-place. TypedArray.sort() uses a native comparison (no toString
     * overhead), and runs off the main thread so the UI stays responsive. */
    arr.sort();

    var minVal = arr[0];
    var maxVal = arr[n - 1];

    /* Quantiles via index into the sorted array */
    var q1     = arr[Math.floor(n * 0.25)];
    var median = arr[Math.floor(n * 0.50)];
    var q3     = arr[Math.floor(n * 0.75)];
    var iqr    = q3 - q1;

    /* Tukey fences for whiskers */
    var fenceLow  = q1 - 1.5 * iqr;
    var fenceHigh = q3 + 1.5 * iqr;

    /* Walk sorted array to find actual data points within fences */
    var whiskerLow  = minVal;
    var whiskerHigh = maxVal;
    for (var i = 0; i < n; i++) {
        if (arr[i] >= fenceLow)  { whiskerLow  = arr[i]; break; }
    }
    for (var i = n - 1; i >= 0; i--) {
        if (arr[i] <= fenceHigh) { whiskerHigh = arr[i]; break; }
    }

    /* Edge case: all values are identical */
    var range = maxVal - minVal;
    if (range === 0) {
        var dX = new Float32Array([minVal]);
        var dY = new Float32Array([1]);
        return { q1, q3, median, whiskerLow, whiskerHigh, minVal, maxVal,
                 densityX: dX, densityY: dY, n };
    }

    /* ---- Histogram-based KDE ------------------------------------------ *
     * One O(n) pass to fill 512 bins, then convolve with a Gaussian kernel.
     * This gives a smooth density estimate without evaluating a kernel n
     * times per query point (which would be O(n * nPoints)).
     * -------------------------------------------------------------------- */
    var nBins = 512;
    var hist  = new Float64Array(nBins);
    var scale = nBins / range;

    for (var i = 0; i < n; i++) {
        var bin = Math.min(nBins - 1, Math.floor((arr[i] - minVal) * scale));
        hist[bin]++;
    }

    /* Gaussian kernel: sigma chosen so the smooth bandwidth is ~3% of range */
    var sigma   = nBins / 30;
    var kRadius = Math.ceil(3 * sigma);
    var kernel  = new Float64Array(2 * kRadius + 1);
    var kSum    = 0;
    for (var k = -kRadius; k <= kRadius; k++) {
        var kv = Math.exp(-0.5 * k * k / (sigma * sigma));
        kernel[k + kRadius] = kv;
        kSum += kv;
    }
    for (var k = 0; k < kernel.length; k++) kernel[k] /= kSum;

    var smoothed = new Float64Array(nBins);
    for (var i = 0; i < nBins; i++) {
        var val = 0;
        for (var k = -kRadius; k <= kRadius; k++) {
            var bi = i + k;
            if (bi >= 0 && bi < nBins) val += hist[bi] * kernel[k + kRadius];
        }
        smoothed[i] = val;
    }

    /* Normalise density to [0, 1] */
    var smoothMax = 0;
    for (var i = 0; i < nBins; i++) {
        if (smoothed[i] > smoothMax) smoothMax = smoothed[i];
    }

    var densityX = new Float32Array(nBins);
    var densityY = new Float32Array(nBins);
    for (var i = 0; i < nBins; i++) {
        densityX[i] = minVal + (i / (nBins - 1)) * range;
        densityY[i] = smoothed[i] / smoothMax;
    }

    return { q1, q3, median, whiskerLow, whiskerHigh, minVal, maxVal,
             densityX, densityY, n };
}

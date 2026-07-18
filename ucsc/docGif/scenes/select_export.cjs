// Select and export: switch to marquee-select mode, drag a rectangle over a
// group of cells, then Edit > Export selected opens a dialog listing their cell
// IDs (a downloadable cohort). -> docs/ui/analysis.rst
module.exports = {
    name: 'select_export',
    url: 'https://cells-test.gi.ucsc.edu/?ds=cortex-dev',
    steps: [
        { do: 'wait', ms: 1400 },
        { do: 'click', sel: '#mpIconModeSelect', pause: 700 },             // marquee-select mode
        // drag a rectangle over a central group of cells (canvas is x250-1160, y60-846)
        { do: 'drag', from: [470, 300], to: [700, 520], pause: 900 },
        { do: 'wait', ms: 900 },                                           // cells now selected + dimmed rest
        { do: 'click', sel: 'a.dropdown-toggle:has-text("Edit")', pause: 500 },
        { do: 'click', sel: '#tpExportIds', pause: 900 },                  // open the export dialog
        { do: 'cursor', x: 705, y: 430 },
        { do: 'hold', ms: 3500 },                                          // hold on the ID list dialog
    ],
};

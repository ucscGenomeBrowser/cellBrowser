// Find cells: Edit > Find cells opens a query dialog; pick a cell-type value and
// the matching cells are selected and highlighted (the rest dim). -> docs/ui/analysis.rst
const CLUSTER = 'RG-div1'; // a coherent radial-glia population, top of the tSNE
module.exports = {
    name: 'find_cells',
    url: 'https://cells-test.gi.ucsc.edu/?ds=cortex-dev',
    steps: [
        { do: 'wait', ms: 1400 },
        { do: 'click', sel: 'a.dropdown-toggle:has-text("Edit")', pause: 500 },
        { do: 'click', sel: '#tpSelectComplex', pause: 700 },              // open Find cells dialog
        { do: 'wait', ms: 1400 },                                          // let the dialog register
        // choose a cell-type value in the (default) annotation-field query row
        { do: 'eval', fn: (name) => {
            const s = document.getElementById('tpSelectMetaValueEnum_0');
            for (const o of s.options) { if (o.textContent.trim() === name) { s.value = o.value; break; } }
        }, arg: CLUSTER, pause: 900 },
        { do: 'clickText', sel: '.ui-dialog-buttonpane button', text: 'OK', pause: 900 }, // run the query
        { do: 'cursor', x: 705, y: 430 },
        { do: 'hold', ms: 3500 },                                          // hold on the highlighted cells
    ],
};

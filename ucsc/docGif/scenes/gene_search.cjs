// Live gene coloring: on the Gene tab, clicking a gene in the "Dataset Genes"
// quick table instantly recolors the plot by that gene's expression. Shows two
// markers in a row (SOX2 progenitors, then NEUROD6 neurons). -> docs/ui/visualization.rst
module.exports = {
    name: 'gene_search',
    url: 'https://cells-test.gi.ucsc.edu/?ds=cortex-dev',
    steps: [
        { do: 'wait', ms: 1400 },                                          // default coloring (cell type)
        { do: 'eval', fn: () => { $('#tpLeftTabs').tabs('option', 'active', 1); }, pause: 900 }, // Gene tab
        { do: 'wait', ms: 500 },
        { do: 'clickText', sel: '.tpGeneBarCell', text: 'SOX2', pause: 2000 },   // recolor by SOX2
        { do: 'clickText', sel: '.tpGeneBarCell', text: 'NEUROD6', pause: 2000 }, // recolor by NEUROD6
        { do: 'hold', ms: 1500 },
    ],
};

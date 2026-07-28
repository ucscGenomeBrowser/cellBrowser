// Background cells (on-the-fly differential expression): with a gene active,
// select one group and mark it as the background, then select a second group —
// the violin plot now compares the second group against the background instead
// of against all cells. Colored by NEUROD2 (high in neurons, low in
// progenitors) so the comparison is dramatic. -> docs/ui/analysis.rst
module.exports = {
    name: 'background_cells',
    url: 'https://cells-test.gi.ucsc.edu/?ds=cortex-dev&gene=NEUROD2',
    steps: [
        { do: 'wait', ms: 1400 },
        { do: 'click', sel: '#mpIconModeSelect', pause: 600 },             // marquee-select mode
        // 1. select the progenitor region (top, low NEUROD2) -> violin vs rest
        { do: 'drag', from: [470, 250], to: [660, 410], pause: 1600 },
        // 2. mark that group as the background
        { do: 'click', sel: 'a.dropdown-toggle:has-text("Tools")', pause: 500 },
        { do: 'click', sel: '#tpSetBackground', pause: 1000 },
        // 3. select the neuron region (bottom, high NEUROD2) -> violin vs background
        { do: 'drag', from: [500, 560], to: [760, 720], pause: 1600 },
        { do: 'cursor', x: 705, y: 460 },
        { do: 'hold', ms: 3500 },
    ],
};

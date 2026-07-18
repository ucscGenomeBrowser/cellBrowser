// Split-screen as a two-gene comparison: open on PAX6 (progenitors), split the
// view (both panes show PAX6), then set the active/left pane to NEUROD2 (neurons)
// so the two markers sit side by side. -> docs/ui/analysis.rst
module.exports = {
    name: 'split_screen_demo',
    url: 'https://cells-test.gi.ucsc.edu/?ds=cortex-dev&gene=PAX6',
    steps: [
        { do: 'wait', ms: 1400 },                                          // hold on single PAX6 plot
        { do: 'click', sel: 'a.dropdown-toggle:has-text("View")', pause: 600 },
        { do: 'click', sel: '#tpSplitMenu', pause: 700 },                  // -> two panes, both PAX6
        { do: 'wait', ms: 2600 },
        { do: 'click', sel: '#tpGeneCombo-selectized', pause: 300 },       // move to the gene box
        { do: 'eval', fn: () => { const e = document.getElementById('tpGeneCombo'); if (e && e.selectize) e.selectize.focus(); }, pause: 500 },
        // Commit the comparison gene. Synthetic typing does not populate the
        // selectize autocomplete, so set the value firing change (0) instead;
        // this recolors the active (left) pane, leaving PAX6 in the right pane.
        { do: 'eval', fn: (g) => { const e = document.getElementById('tpGeneCombo'); e.selectize.addOption({ id: g, text: g }); e.selectize.setValue(g, 0); }, arg: 'NEUROD2', pause: 700 },
        { do: 'cursor', x: 700, y: 430 },                                  // move cursor off the panel
        { do: 'hold', ms: 3800 },                                          // hold on the PAX6-vs-NEUROD2 payoff
    ],
};

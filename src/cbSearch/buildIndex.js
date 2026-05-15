const MiniSearch = require('minisearch');
const fs = require('fs');
const path = require('path');

const HTDOCS = process.env.HTDOCS_CELLS || '/usr/local/apache/htdocs-cells';

// normalize any desc.json field that might be stored as array or non-string
function asString(val) {
    if (!val) return '';
    if (Array.isArray(val)) return val.join(' ');
    return String(val);
}

function loadDatasets(rootConf) {
    var docs = [];
    for (var ds of (rootConf.datasets || [])) {
        var dsPath = path.join(HTDOCS, ds.name);
        var confPath = path.join(dsPath, 'dataset.json');
        var descPath = path.join(dsPath, 'desc.json');
        if (!fs.existsSync(confPath)) continue;
        var conf;
        try { conf = JSON.parse(fs.readFileSync(confPath)); }
        catch(e) { console.warn('Skipping ' + ds.name + ': ' + e.message); continue; }
        // recurse into collections and also index the collection itself
        if (conf.datasets && conf.datasets.length > 0)
            docs = docs.concat(loadDatasets(conf));
        var desc = {};
        if (fs.existsSync(descPath)) {
            try { desc = JSON.parse(fs.readFileSync(descPath)); } catch(e) {}
        }
        // paper_url is "https://... Author et al. Journal. Year." — extract both parts
        var paperUrl = asString(desc.paper_url);
        var paperParts = paperUrl.split(' ');
        var paperLabel = paperParts.length > 1 ? paperParts.slice(1).join(' ') : '';
        // extract DOI from doi.org URLs as fallback when no explicit doi field
        var doi = asString(desc.doi);
        if (!doi && paperUrl.indexOf('doi.org/') !== -1)
            doi = paperUrl.split('doi.org/')[1].split(' ')[0];

        // pmcid sometimes has citation text appended — extract just the PMC id
        var pmcid = asString(desc.pmcid);
        var pmcMatch = pmcid.match(/PMC\d+/);
        pmcid = pmcMatch ? pmcMatch[0] : pmcid;

        docs.push({
            id:           ds.name,
            name:         ds.name,
            parent:       ds.name.indexOf('/') !== -1 ? ds.name.split('/')[0] : '',
            shortLabel:   ds.shortLabel || conf.shortLabel || '',
            md5:          ds.md5 || conf.md5 || '',
            // publication
            title:        desc.title || '',
            abstract:     desc.abstract || '',
            paper:        paperLabel,
            doi:          doi,
            pmid:         asString(desc.pmid),
            pmcid:        pmcid,
            // accessions
            geo_series:   asString(desc.geo_series),
            arrayexpress: asString(desc.arrayexpress),
            sra_study:    asString(desc.sra_study),
            bioproject:   asString(desc.bioproject),
            ega_study:    asString(desc.ega_study),
            ega_dataset:  asString(desc.ega_dataset),
            hca_dcp:      asString(desc.hca_dcp),
            zenodo:       asString(desc.zenodo),
            dbgap:        asString(desc.dbgap),
            // people / institution
            authors:      [desc.authors, desc.author].filter(Boolean).join(' '),
            institution:  [desc.institution, desc.institute].filter(Boolean).join(' '),
            lab:          desc.lab || conf.lab || '',
            submitter:    desc.submitter || conf.submitter || '',
            // facets
            organisms:    (conf.organisms || []).join(' '),
            body_parts:   (conf.body_parts || []).join(' '),
            diseases:     (conf.diseases || []).join(' '),
            tags:         (conf.tags || []).join(' '),
        });
    }
    return docs;
}

function buildIndex() {
    var rootConf;
    try {
        rootConf = JSON.parse(fs.readFileSync(path.join(HTDOCS, 'dataset.json')));
    } catch(e) {
        throw new Error('Could not read root dataset.json from ' + HTDOCS + ': ' + e.message);
    }
    var docs = loadDatasets(rootConf);
    console.log('Indexing ' + docs.length + ' datasets.');

    var ms = new MiniSearch({
        fields: ['shortLabel', 'title', 'abstract', 'paper', 'organisms', 'body_parts',
                 'diseases', 'lab', 'submitter', 'authors', 'institution',
                 'geo_series', 'arrayexpress', 'sra_study', 'bioproject',
                 'ega_study', 'ega_dataset', 'hca_dcp', 'zenodo', 'dbgap',
                 'pmid', 'pmcid', 'doi', 'tags'],
        storeFields: ['name', 'shortLabel', 'md5', 'parent'],
        searchOptions: {
            boost:  { title: 3, shortLabel: 3,
                      geo_series: 2, arrayexpress: 2, sra_study: 2, bioproject: 2,
                      ega_study: 2, ega_dataset: 2, hca_dcp: 2, zenodo: 2, dbgap: 2,
                      pmid: 2, pmcid: 2, doi: 2 },
            fuzzy:  0.2,
            prefix: true,
        }
    });
    ms.addAll(docs);
    return ms;
}

module.exports = { buildIndex };

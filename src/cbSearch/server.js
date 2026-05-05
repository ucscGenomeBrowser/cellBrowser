const express = require('express');
const cors    = require('cors');
const { buildIndex } = require('./buildIndex');

const PORT = parseInt(process.env.SEARCH_PORT || '3001');
const app = express();
app.use(cors());

console.log('Building search index...');
var index = buildIndex();
console.log('Index ready, ' + index.documentCount + ' datasets indexed.');

app.get('/search', function(req, res) {
    var q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    var results = index.search(q, { limit: 50 });
    res.json(results);  // each result: { name, shortLabel, md5, score }
});

// Rebuild the index after adding new datasets (e.g. from cbBuild post-hook)
app.post('/rebuild', function(req, res) {
    try {
        index = buildIndex();
        res.json({ ok: true, count: index.documentCount });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.listen(PORT, '127.0.0.1', function() {
    console.log('Search server listening on 127.0.0.1:' + PORT);
});

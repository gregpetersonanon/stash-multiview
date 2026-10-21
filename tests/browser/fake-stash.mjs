// Minimal fake Stash for headless tests of the plugin.
// Usage: node fake-stash.mjs <plugin_dir> <port> <media_dir>
//
// - Serves the plugin at /plugin/multiView/assets/.
// - Answers the GraphQL calls the plugin makes. configurePlugin replaces the
//   plugin's whole config map, as real Stash does.
// - Streams test videos for /scene/<id>/stream (odd ids landscape, even
//   portrait, 30 s each).
// - /scenes is a stand-in for a Stash scene list: a few scene cards
//   and the plugin's Stash-side script.
// - /__log returns the GraphQL calls seen so far and the current config.
//   Set QUEUE in the environment to choose the starting queue.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [pluginDir, port, mediaDir] = process.argv.slice(2);
const ASSETS = '/plugin/multiView/assets/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

const scene = id => ({
    title: `Scene ${id}`, o_counter: 0,
    files: [{ path: `/media/scene${id}.mp4`, duration: 30, width: id % 2 ? 640 : 360, height: id % 2 ? 360 : 640 }],
    sceneStreams: [{ url: `/scene/${id}/stream`, mime_type: 'video/mp4', label: 'Direct stream' }],
});
const config = { multiView: { queue: process.env.QUEUE || JSON.stringify(['1', '2', '3', { type: 'filter', filter: {} }]) } };
const log = [];

const STASH_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${ASSETS}multiView.css"></head><body>
<div class="filtered-list-toolbar btn-toolbar"><div class="btn-group"><button class="filter-button">Filter</button></div>
<div class="btn-group"><button>Grid</button></div><input type="range"></div>
${[1, 2, 3, 4].map(id => `<div class="scene-card"><a href="/scenes/${id}">Scene ${id}</a></div>`).join('')}
<script src="${ASSETS}multiView.js"></script></body></html>`;

function graphql(body) {
    const q = body.query;
    log.push(q.replace(/\s+/g, ' ').slice(0, 60));
    if (q.includes('configurePlugin')) { config.multiView = { ...body.variables.input }; return { configurePlugin: config.multiView }; }
    if (q.includes('configuration')) return { configuration: { plugins: config } };
    if (q.includes('findScene(')) return { findScene: scene(Number(body.variables.id)) };
    if (q.includes('findScenes')) {
        const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].sort(() => Math.random() - 0.5);
        const per = body.variables?.filter?.per_page ?? Number((q.match(/per_page: (\d+)/) || [])[1] || 1);
        return { findScenes: { scenes: ids.slice(0, per).map(id => ({ id })) } };
    }
    if (q.includes('sceneIncrementO')) return { sceneIncrementO: 1 };
    if (q.includes('sceneAddPlay')) return { sceneAddPlay: { count: 1 } };
    if (q.includes('sceneSaveActivity')) return { sceneSaveActivity: true };
    return {};
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/graphql') {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: graphql(JSON.parse(data)) }));
        });
        return;
    }
    if (url.pathname === '/__log') { res.end(JSON.stringify({ log, config })); return; }
    if (url.pathname === '/scenes') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(STASH_PAGE); return; }
    let file;
    const m = url.pathname.match(/^\/scene\/(\d+)\/stream/);
    if (m) file = path.join(mediaDir, Number(m[1]) % 2 ? 'land.mp4' : 'port.mp4');
    else if (url.pathname.startsWith(ASSETS)) {
        file = path.resolve(pluginDir, '.' + url.pathname.slice(ASSETS.length - 1));
        if (!file.startsWith(path.resolve(pluginDir) + path.sep)) { res.writeHead(403); res.end(); return; }
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
    if (range) {
        const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(file).pipe(res);
    }
}).listen(Number(port), '127.0.0.1');

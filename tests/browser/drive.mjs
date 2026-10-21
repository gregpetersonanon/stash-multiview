// Drive the plugin in headless Chrome over the DevTools protocol.
//
//   node tests/browser/drive.mjs <scenario.mjs> [plugin_dir] [port]
//
// Starts the fake Stash (fake-stash.mjs) serving plugin_dir (default: this
// repo), launches Chrome with a throwaway profile, opens the scenario's page
// (`url`, default the player), runs its steps in the page, and prints one
// JSON result: each step's return value, every uncaught exception and console
// error (`__problems`), and the fake Stash's final plugin config (`__config`).
// Needs google-chrome; ffmpeg generates the test videos on first run.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(new URL(import.meta.url).pathname);
const [scenarioPath, pluginDir = path.resolve(here, '../..'), port = '18081'] = process.argv.slice(2);
const debugPort = Number(port) + 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const media = path.join(here, '.media');
for (const [name, size] of [['land.mp4', '640x360'], ['port.mp4', '360x640']]) {
    if (fs.existsSync(path.join(media, name))) continue;
    fs.mkdirSync(media, { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25`,
        '-t', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(media, name)]);
}

const server = spawn('node', [path.join(here, 'fake-stash.mjs'), pluginDir, port, media], { stdio: 'inherit', env: process.env });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-chrome-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900',
    `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' });

try {
    let pages;
    for (let i = 0; i < 50 && !pages; i++) {
        await sleep(200);
        try { pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch {}
    }
    const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let seq = 0;
    const pending = new Map();
    const problems = [];
    ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            problems.push('exception: ' + (d.exception?.description || d.text).split('\n').slice(0, 2).join(' | '));
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            problems.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
        }
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && msg.params.entry.source !== 'network') {
            problems.push('log: ' + msg.params.entry.text);
        }
    });
    const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.result.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description?.split('\n')[0] };
        return r.result.result.value;
    };
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    const scenario = await import(path.resolve(scenarioPath));
    const page = scenario.url || '/plugin/multiView/assets/index.html?t=1';
    await send('Page.navigate', { url: `http://127.0.0.1:${port}${page}` });
    const results = {};
    for (const [name, fn, waitMs] of scenario.steps) {
        await sleep(waitMs ?? 300);
        results[name] = await evaluate(`(async () => { ${fn} })()`);
    }
    await sleep(500);
    results.__problems = problems;
    results.__config = (await (await fetch(`http://127.0.0.1:${port}/__log`)).json()).config.multiView;
    console.log(JSON.stringify(results, null, 1));
} finally {
    chrome.kill();
    server.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
}

// Generic scene-driven recorder for UCSC Cell Browser documentation GIFs.
//
// Reads a "scene" module (see scenes/*.cjs), drives cells-test.gi.ucsc.edu in a
// headless Chromium with a visible fake cursor, and saves a .webm. The webm is
// turned into an optimized GIF afterwards by ../makeDocGif.sh.
//
// This is a maintainer tool for regenerating the animated help figures, not an
// end-user script. It expects Playwright's browser cache to be present
// (chromium + the bundled ffmpeg) and playwright-core to be resolvable;
// makeDocGif.sh sets CHROME and NODE_PATH for both.
//
// A scene module exports:
//   {
//     name:     'split_screen_demo',                 // -> <name>.webm / <name>.gif
//     url:      'https://cells-test.gi.ucsc.edu/?ds=cortex-dev&gene=PAX6',
//     viewport: { width: 1360, height: 860 },        // optional, this is the default
//     initWait: 6000,                                // optional ms to wait for first render
//     steps:    [ <action>, ... ]                    // see the switch below
//   }
//
// Actions (each an object with a `do` field):
//   { do:'wait',   ms }                              // pause (alias: 'hold')
//   { do:'cursor', x, y }                            // move the fake cursor only
//   { do:'click',  sel, pause? , steps? }            // glide cursor to a selector, click it
//   { do:'clickText', sel, text, pause? }            // glide+click the element matching text
//   { do:'key',    key }                             // keyboard press (e.g. 'Escape', 's')
//   { do:'drag',   from:[x,y], to:[x,y] }            // marquee: mouse down->move->up over the canvas
//   { do:'eval',   fn , arg? }                       // run fn(arg) inside the page

const { chromium } = require('playwright-core');
const fs = require('fs');

const CHROME = process.env.CHROME;
const OUT = process.env.OUT || '/tmp/cbgif';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadScene() {
    const p = process.env.SCENE;
    if (!p) throw new Error('SCENE env (path to scene module) is required');
    return require(require('path').resolve(p));
}

(async () => {
    const scene = loadScene();
    const VP = scene.viewport || { width: 1360, height: 860 };
    const browser = await chromium.launch({ executablePath: CHROME });
    const context = await browser.newContext({
        viewport: VP,
        deviceScaleFactor: 1,
        recordVideo: { dir: OUT, size: VP },
    });
    await context.addInitScript(() => { try { localStorage.setItem('introShown', 'true'); } catch (e) {} });
    const page = await context.newPage();

    await page.goto(scene.url, { waitUntil: 'load' });
    // Wait until the plot has actually rendered (legend populated) before acting,
    // otherwise a slow load yields a blank recording that optimizes to an empty
    // GIF. Also always consume at least initWait so the fixed lead-in trim in
    // makeDocGif.sh stays aligned with when the first action begins.
    const minWait = scene.initWait || 6000;
    const t0 = Date.now();
    try {
        await page.waitForFunction(
            () => document.querySelectorAll('#tpLegendRows .tpLegend').length > 0,
            { timeout: minWait + 20000 });
    } catch (e) {
        console.error('WARN: plot did not signal ready within timeout; recording anyway');
    }
    const elapsed = Date.now() - t0;
    if (elapsed < minWait) await sleep(minWait - elapsed);

    // Visible fake cursor (Playwright's real cursor is not captured in the video).
    await page.evaluate(() => {
        const c = document.createElement('div');
        c.id = 'fakeCursor';
        c.style.cssText = [
            'position:fixed', 'width:22px', 'height:22px', 'z-index:99999',
            'left:0', 'top:0', 'pointer-events:none', 'transition:transform 0.02s linear',
            'background:no-repeat center/contain',
        ].join(';');
        c.style.backgroundImage = "url(\"data:image/svg+xml;utf8," +
            encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z" fill="black" stroke="white" stroke-width="1.2"/></svg>') + "\")";
        document.body.appendChild(c);
        window.__moveCursor = (x, y) => { c.style.transform = `translate(${x}px,${y}px)`; };
        window.__moveCursor(60, 60);
    });

    async function cursorPos() {
        return page.evaluate(() => {
            const c = document.getElementById('fakeCursor');
            const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(c.style.transform || '');
            return m ? [parseFloat(m[1]), parseFloat(m[2])] : [60, 60];
        });
    }

    async function glideXY(tx, ty, steps) {
        const start = await cursorPos();
        for (let i = 1; i <= steps; i++) {
            const x = start[0] + (tx - start[0]) * i / steps;
            const y = start[1] + (ty - start[1]) * i / steps;
            await page.evaluate(([x, y]) => window.__moveCursor(x, y), [x, y]);
            await page.mouse.move(x, y);
            await sleep(16);
        }
    }

    async function glideClick(locator, pause, steps) {
        const box = await locator.first().boundingBox();
        if (!box) throw new Error('no bounding box for target');
        const tx = box.x + box.width / 2, ty = box.y + box.height / 2;
        await glideXY(tx, ty, steps || 28);
        await sleep(250);
        await page.mouse.click(tx, ty);
        await sleep(pause == null ? 500 : pause);
    }

    for (const step of (scene.steps || [])) {
        switch (step.do) {
            case 'wait':
            case 'hold':
                await sleep(step.ms);
                break;
            case 'cursor':
                await page.evaluate(([x, y]) => window.__moveCursor(x, y), [step.x, step.y]);
                await sleep(step.pause || 200);
                break;
            case 'click':
                await glideClick(page.locator(step.sel), step.pause, step.steps);
                break;
            case 'clickText':
                await glideClick(page.locator(step.sel, { hasText: step.text }), step.pause, step.steps);
                break;
            case 'key':
                await page.keyboard.press(step.key);
                await sleep(step.pause || 400);
                break;
            case 'drag': {
                const [x1, y1] = step.from, [x2, y2] = step.to;
                await glideXY(x1, y1, step.steps || 20);
                await page.mouse.move(x1, y1);
                await page.mouse.down();
                // drag in a few increments so the marquee is visible while recording
                const n = 16;
                for (let i = 1; i <= n; i++) {
                    const x = x1 + (x2 - x1) * i / n, y = y1 + (y2 - y1) * i / n;
                    await page.evaluate(([x, y]) => window.__moveCursor(x, y), [x, y]);
                    await page.mouse.move(x, y);
                    await sleep(20);
                }
                await page.mouse.up();
                await sleep(step.pause || 600);
                break;
            }
            case 'eval':
                await page.evaluate(step.fn, step.arg);
                await sleep(step.pause || 400);
                break;
            default:
                throw new Error('unknown step: ' + JSON.stringify(step));
        }
    }

    await context.close(); // flush video
    await browser.close();

    const webm = fs.readdirSync(OUT).find(f => f.endsWith('.webm'));
    fs.renameSync(`${OUT}/${webm}`, `${OUT}/${scene.name}.webm`);
    // Sidecar with the encoding knobs so makeDocGif.sh can read them without
    // parsing the scene module. trim = seconds of render dead-time to drop.
    fs.writeFileSync(`${OUT}/${scene.name}.meta.json`, JSON.stringify({
        name: scene.name,
        trim: scene.trim == null ? 5.4 : scene.trim,
        width: scene.width || 1000,
        fuzz: scene.fuzz || 3,
        delay: scene.delay || 8,
    }));
    console.log('wrote', `${OUT}/${scene.name}.webm`);
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });

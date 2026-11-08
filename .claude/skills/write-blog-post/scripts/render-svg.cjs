// Render blog SVG figures to PNG so you can LOOK at them before shipping.
// Usage: node .claude/skills/write-blog-post/scripts/render-svg.cjs <out-dir> <file.svg>...
// Uses the preinstalled Playwright Chromium; the viewport is taken from each viewBox.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ deviceScaleFactor: 1 });
  for (const f of process.argv.slice(3)) {
    const svg = fs.readFileSync(f, 'utf8');
    const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    await p.setViewportSize({ width: +vb[1], height: +vb[2] });
    await p.setContent(`<body style="margin:0">${svg}</body>`);
    await p.screenshot({ path: path.join(process.argv[2], path.basename(f, '.svg') + '.png') });
  }
  await b.close();
})();

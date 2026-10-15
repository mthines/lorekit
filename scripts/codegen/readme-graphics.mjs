#!/usr/bin/env node
// Renders the root README's illustrations as light + dark SVG pairs into
// .github/assets/readme/. The README swaps them with <picture> on GitHub's own
// theme — an SVG's internal prefers-color-scheme follows the OS, not GitHub.
// SVGs loaded through <img> cannot fetch web fonts, so text uses system stacks
// and every line is sized to fit with room for the widest fallback font.
//
//   node scripts/codegen/readme-graphics.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../.github/assets/readme');

// Dark mirrors packages/web/src/app/globals.css; light is the same hues
// darkened until text clears WCAG AA on white.
const THEMES = {
  dark: {
    bg: '#0d0e11', card: '#13151a', border: '#2a2d36', text: '#f0f2f7', muted: '#9aa0ad',
    faint: '#5d6370', accent: '#f5a623', accentBg: '#2a2010',
    global: '#a78bfa', project: '#34d399', repo: '#60a5fa', branch: '#f59e0b',
  },
  light: {
    bg: '#ffffff', card: '#f7f7f9', border: '#e2e4e9', text: '#16181d', muted: '#565c69',
    faint: '#9aa0ad', accent: '#b86e00', accentBg: '#fff4e0',
    global: '#7c3aed', project: '#059669', repo: '#2563eb', branch: '#b45309',
  },
};

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (x, y, s, { size = 14, weight = 400, fill, font = SANS, anchor = 'start', spacing } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${
    spacing ? ` letter-spacing="${spacing}"` : ''
  }>${esc(s)}</text>`;

const svg = (w, h, t, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${w}" height="${h}" rx="16" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>
`;

// ── 1. The learning loop ────────────────────────────────────────────────────

const BEATS = [
  {
    day: 'DAY 1', verb: 'LEARNS', tries: '4 tries',
    lines: ['Your agent hits a wall and', 'works its way out — then', 'writes the lesson itself.'],
    code: 'memory.write',
  },
  {
    day: 'DAY 4', verb: 'RECALLS', tries: '1 try',
    lines: ['A teammate’s agent fails the', 'same way. The lesson arrives', 'with the error, before a retry.'],
    code: 'on the failing call',
  },
  {
    day: 'DAY 12', verb: 'PROMOTES', tries: '0 tries',
    lines: ['Seen three times in three', 'places, it earns a permanent', 'rule. Applied before the run.'],
    code: 'seen 3× → rule',
  },
  {
    day: 'DAY 90', verb: 'PRUNES', tries: 'restorable',
    lines: ['Lore nobody opens stops', 'riding along in every session.', 'Archived, never deleted.'],
    code: 'groom --unseen-days 90',
  },
];

function loop(t) {
  const W = 1000, H = 400, cardW = 214, gap = 30, x0 = 34, cardY = 92, cardH = 236;
  const parts = [
    text(x0, 44, 'A MONTH IN THE LIFE OF ONE LESSON', { size: 12, weight: 600, fill: t.accent, font: MONO, spacing: 2 }),
    text(x0, 68, 'Illustrative timeline — every step is a mechanic LoreKit ships today.', { size: 14, fill: t.muted }),
  ];
  BEATS.forEach((b, i) => {
    const x = x0 + i * (cardW + gap);
    const hot = i === 0;
    parts.push(
      `<rect x="${x}" y="${cardY}" width="${cardW}" height="${cardH}" rx="12" fill="${hot ? t.accentBg : t.card}" stroke="${hot ? t.accent : t.border}"/>`,
      text(x + 18, cardY + 30, b.day, { size: 11, weight: 600, fill: t.muted, font: MONO, spacing: 1.5 }),
      text(x + cardW - 18, cardY + 30, b.tries, { size: 11, weight: 600, fill: t.accent, font: MONO, anchor: 'end' }),
      text(x + 18, cardY + 62, b.verb, { size: 22, weight: 700, fill: t.text, spacing: 0.5 }),
      ...b.lines.map((l, j) => text(x + 18, cardY + 96 + j * 21, l, { size: 13.5, fill: t.muted })),
      `<rect x="${x + 14}" y="${cardY + cardH - 52}" width="${cardW - 28}" height="34" rx="7" fill="${t.bg}" stroke="${t.border}"/>`,
      text(x + 26, cardY + cardH - 30, b.code, { size: 12, fill: t.text, font: MONO }),
    );
    if (i < BEATS.length - 1) {
      const ax = x + cardW + 5, ay = cardY + cardH / 2;
      parts.push(
        `<path d="M${ax} ${ay} h${gap - 12}" stroke="${t.accent}" stroke-width="2" fill="none"/>`,
        `<path d="M${ax + gap - 14} ${ay - 5} l7 5 l-7 5" stroke="${t.accent}" stroke-width="2" fill="none" stroke-linejoin="round"/>`,
      );
    }
  });
  // The return path: from the last card back under the row to the first.
  const yB = cardY + cardH, yL = H - 34;
  const xs = x0 + cardW / 2, xe = x0 + 3 * (cardW + gap) + cardW / 2;
  parts.push(
    `<path d="M${xe} ${yB + 4} V${yL - 10} q0 10 -10 10 H${xs + 10} q-10 0 -10 -10 V${yB + 12}" stroke="${t.faint}" stroke-width="1.5" stroke-dasharray="5 5" fill="none"/>`,
    `<path d="M${xs - 5} ${yB + 13} l5 -7 l5 7" stroke="${t.faint}" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`,
    `<rect x="${W / 2 - 170}" y="${yL - 12}" width="340" height="24" fill="${t.bg}"/>`,
    text(W / 2, yL + 4, 'and round again — every session, every agent', { size: 13, fill: t.muted, anchor: 'middle' }),
  );
  return svg(W, H, t, parts.join('\n'), 'The LoreKit learning loop: learns, recalls, promotes, prunes');
}

// ── 2. One store, every agent ───────────────────────────────────────────────

const AGENTS = [
  ['Claude Code', 'plugin · hooks · MCP'],
  ['Cursor', 'rule · stop hook · MCP'],
  ['Codex', 'hooks · experimental'],
  ['Any MCP client', 'endpoint + token'],
  ['CI', 'read-only lk_ro_ token'],
];

const SCOPES = [
  ['branch::acme/api::feat/x', 'branch'],
  ['repo::acme/api', 'repo'],
  ['project::payments', 'project'],
  ['global', 'global'],
];

const STORES = [
  ['Local', 'markdown files · no account'],
  ['Hosted', 'shared across machines + team'],
  ['Self-hosted', 'your Supabase + Vercel · MIT'],
];

function store(t) {
  const W = 1000, H = 392;
  const parts = [
    text(34, 44, 'ONE STORE, EVERY AGENT', { size: 12, weight: 600, fill: t.accent, font: MONO, spacing: 2 }),
    text(34, 68, 'Connect each agent once. Lessons stay with the repo they’re about.', { size: 14, fill: t.muted }),
  ];

  // Left: the agents.
  const ax = 34, aw = 250, ah = 46, ay0 = 96, ag = 10;
  AGENTS.forEach(([name, how], i) => {
    const y = ay0 + i * (ah + ag);
    parts.push(
      `<rect x="${ax}" y="${y}" width="${aw}" height="${ah}" rx="9" fill="${t.card}" stroke="${t.border}"/>`,
      text(ax + 16, y + 20, name, { size: 14, weight: 600, fill: t.text }),
      text(ax + 16, y + 37, how, { size: 11.5, fill: t.muted, font: MONO }),
    );
  });

  // Centre: the store and its read order.
  const sx = 344, sw = 340, sy = 96, sh = 270;
  const midY = sy + sh / 2;
  AGENTS.forEach((_, i) => {
    const y = ay0 + i * (ah + ag) + ah / 2;
    parts.push(
      `<path d="M${ax + aw} ${y} C${ax + aw + 34} ${y}, ${sx - 34} ${midY}, ${sx} ${midY}" stroke="${t.faint}" stroke-width="1.5" fill="none"/>`,
    );
  });
  parts.push(
    `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="12" fill="${t.accentBg}" stroke="${t.accent}"/>`,
    text(sx + 20, sy + 32, 'LoreKit', { size: 18, weight: 700, fill: t.text }),
    text(sx + sw - 20, sy + 32, 'memory.*', { size: 12, fill: t.accent, font: MONO, anchor: 'end' }),
    text(sx + 20, sy + 60, 'READ ORDER · NARROW → BROAD', { size: 10.5, weight: 600, fill: t.muted, font: MONO, spacing: 1.2 }),
  );
  SCOPES.forEach(([label, kind], i) => {
    const y = sy + 76 + i * 44;
    const w = (sw - 40) * (0.76 + i * 0.08);
    parts.push(
      `<rect x="${sx + 20}" y="${y}" width="${w}" height="34" rx="7" fill="${t.bg}" stroke="${t[kind]}"/>`,
      `<rect x="${sx + 20}" y="${y}" width="5" height="34" rx="2" fill="${t[kind]}"/>`,
      text(sx + 36, y + 22, label, { size: 12.5, fill: t[kind], font: MONO }),
    );
  });

  // Right: where it lives.
  const rx = 744, rw = 222;
  parts.push(
    `<path d="M${sx + sw} ${sy + 143} H${rx - 20}" stroke="${t.faint}" stroke-width="1.5" fill="none"/>`,
    text(rx, sy + 14, 'LIVES WHERE YOU CHOOSE', { size: 10.5, weight: 600, fill: t.muted, font: MONO, spacing: 1.2 }),
  );
  STORES.forEach(([name, how], i) => {
    const y = sy + 30 + i * 80;
    const hot = i === 0;
    parts.push(
      `<rect x="${rx}" y="${y}" width="${rw}" height="66" rx="9" fill="${t.card}" stroke="${hot ? t.accent : t.border}"/>`,
      text(rx + 16, y + 27, name, { size: 15, weight: 600, fill: t.text }),
      text(rx + 16, y + 47, how, { size: 11, fill: t.muted, font: MONO }),
    );
  });
  // Bracket joining the three options to the store's connector.
  parts.push(
    `<path d="M${rx - 20} ${sy + 63} V${sy + 223} M${rx - 20} ${sy + 63} H${rx} M${rx - 20} ${sy + 143} H${rx} M${rx - 20} ${sy + 223} H${rx}" stroke="${t.faint}" stroke-width="1.5" fill="none"/>`,
  );
  return svg(W, H, t, parts.join('\n'), 'Every agent reads and writes one LoreKit store, scoped narrow to broad, kept locally, hosted, or self-hosted');
}

mkdirSync(OUT, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `loop-${name}.svg`), loop(theme));
  writeFileSync(join(OUT, `store-${name}.svg`), store(theme));
}
console.log(`wrote 4 SVGs to ${OUT}`);

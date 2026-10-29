#!/usr/bin/env node
// Generates the README artwork in docs/assets/ (light + dark variants). Run: node scripts/gen-assets.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');
mkdirSync(OUT, { recursive: true });

const PALETTES = {
  light: {
    text: '#1F2328', muted: '#59636E', card: '#F6F8FA', stroke: '#D0D7DE', accent: '#D97F06', accentSoft: '#FFF4DE',
    accentText: '#9A5B00', good: '#1A7F37', warn: '#9A6700', plan: '#8250DF', bad: '#CF222E', line: '#8C959F',
  },
  dark: {
    text: '#E6EDF3', muted: '#9198A1', card: '#161B22', stroke: '#30363D', accent: '#F5A524', accentSoft: '#2B2111',
    accentText: '#F8C46A', good: '#3FB950', warn: '#D29922', plan: '#A371F7', bad: '#F85149', line: '#6E7681',
  },
};
const SANS = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"`;
const MONO = `font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', monospace"`;

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const hexPoints = (cx, cy, r) =>
  [-90, -30, 30, 90, 150, 210].map((a) => `${(cx + r * Math.cos((a * Math.PI) / 180)).toFixed(1)},${(cy + r * Math.sin((a * Math.PI) / 180)).toFixed(1)}`).join(' ');

function svg(w, h, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
${body}
</svg>
`;
}

function arrowDefs(p, id = 'arr') {
  return `<defs><marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${p.line}"/></marker></defs>`;
}

// ---------- logo ----------
function hexIcon(p, x, y, s) {
  const k = s / 96;
  const c = (cx, cy) => [x + cx * k, y + cy * k];
  const [cx, cy] = c(48, 48);
  const nodes = [c(28, 33), c(68, 33), c(48, 72)];
  return `
  <polygon points="${hexPoints(cx, cy, 42 * k)}" fill="${p.accentSoft}" stroke="${p.accent}" stroke-width="${(5 * k).toFixed(1)}" stroke-linejoin="round"/>
  ${nodes.map(([nx, ny]) => `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${p.text}" stroke-width="${(3 * k).toFixed(1)}" stroke-linecap="round"/>`).join('')}
  <line x1="${nodes[0][0]}" y1="${nodes[0][1]}" x2="${nodes[1][0]}" y2="${nodes[1][1]}" stroke="${p.line}" stroke-width="${(2 * k).toFixed(1)}" stroke-dasharray="${(3 * k).toFixed(1)} ${(3 * k).toFixed(1)}"/>
  ${nodes.map(([nx, ny]) => `<circle cx="${nx}" cy="${ny}" r="${(6 * k).toFixed(1)}" fill="${p.text}"/>`).join('')}
  <circle cx="${cx}" cy="${cy}" r="${(9 * k).toFixed(1)}" fill="${p.accent}"/>`;
}

function logo(p) {
  return svg(
    380, 100,
    `${hexIcon(p, 2, 2, 96)}
  <text x="112" y="68" ${SANS} font-size="54" font-weight="700" letter-spacing="-1" fill="${p.text}">Hive<tspan fill="${p.accent}">Mem</tspan></text>`,
    'HiveMem logo',
  );
}

// ---------- hero: before / after ----------
function pill(p, x, y, w, h, label, opts = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${opts.fill ?? p.card}" stroke="${opts.stroke ?? p.stroke}" stroke-width="1.5"/>
  <text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" ${SANS} font-size="${opts.size ?? 15}" font-weight="600" fill="${opts.color ?? p.text}">${esc(label)}</text>`;
}

function hero(p) {
  const tools = [
    ['Claude Code', 'CLAUDE.md · MEMORY.md'],
    ['Codex', 'AGENTS.md · memories/'],
    ['CodeBuddy', 'CODEBUDDY.md · memories/'],
    ['Cursor', '.cursor/rules · Memories'],
  ];
  const left = tools
    .map(([t, f], i) => {
      const y = 78 + i * 66;
      return `${pill(p, 30, y, 150, 40, t)}
  <line x1="186" y1="${y + 20}" x2="222" y2="${y + 20}" stroke="${p.line}" stroke-width="1.5" marker-end="url(#arr)"/>
  <rect x="228" y="${y + 2}" width="196" height="36" rx="6" fill="none" stroke="${p.stroke}" stroke-dasharray="4 3"/>
  <text x="240" y="${y + 25}" ${MONO} font-size="12.5" fill="${p.muted}">${esc(f)}</text>`;
    })
    .join('\n');
  const issues = ['re-explain conventions every session', 'instruction files drift apart', 'no idea who wrote what, or why'];
  const cx = 735, cy = 222;
  const spots = [[555, 92], [785, 92], [555, 330], [785, 330]];
  const right = spots
    .map(([x, y], i) => {
      const tx = x + 65, ty = y + 20;
      const dx = cx - tx, dy = cy - ty, len = Math.hypot(dx, dy);
      const sx = tx + (dx / len) * 34, sy = ty + (dy / len) * 22, ex = cx - (dx / len) * 74, ey = cy - (dy / len) * 66;
      return `${pill(p, x, y, 130, 40, tools[i][0])}
  <line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${p.accent}" stroke-width="2" marker-start="url(#arrA)" marker-end="url(#arrA)"/>`;
    })
    .join('\n');
  return svg(
    960, 420,
    `${arrowDefs(p)}<defs><marker id="arrA" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${p.accent}"/></marker></defs>
  <text x="30" y="40" ${SANS} font-size="17" font-weight="700" fill="${p.muted}">TODAY · every tool remembers alone</text>
  ${left}
  ${issues.map((s, i) => `<text x="30" y="${356 + i * 22}" ${SANS} font-size="14" fill="${p.bad}">✕ <tspan fill="${p.muted}">${esc(s)}</tspan></text>`).join('\n  ')}
  <path d="M462 222 h34" stroke="${p.accent}" stroke-width="3" marker-end="url(#arrA)"/>
  <text x="540" y="40" ${SANS} font-size="17" font-weight="700" fill="${p.accentText}">WITH HIVEMEM · one memory, every agent</text>
  ${right}
  <polygon points="${hexPoints(cx, cy, 82)}" fill="${p.accentSoft}" stroke="${p.accent}" stroke-width="3" stroke-linejoin="round"/>
  <text x="${cx}" y="${cy - 14}" text-anchor="middle" ${SANS} font-size="22" font-weight="700" fill="${p.text}">HiveMem</text>
  <text x="${cx}" y="${cy + 10}" text-anchor="middle" ${SANS} font-size="13" fill="${p.muted}">versioned ledger</text>
  <text x="${cx}" y="${cy + 28}" text-anchor="middle" ${SANS} font-size="13" fill="${p.muted}">+ provenance</text>
  <text x="${cx}" y="${cy + 46}" text-anchor="middle" ${SANS} font-size="13" fill="${p.muted}">+ conflict inbox</text>
  <text x="540" y="400" ${SANS} font-size="14" fill="${p.good}">✓ <tspan fill="${p.muted}">learn once · provenance on every memory · conflicts wait for you</tspan></text>`,
    'Before: each agent tool keeps isolated memory files. After: all tools share one HiveMem ledger.',
  );
}

// ---------- architecture ----------
const STATUS = (p) => ({ done: p.good, wip: p.warn, plan: p.plan });

function chip(p, x, y, w, label, status, opts = {}) {
  const h = opts.h ?? 34;
  const dot = status ? `<circle cx="${x + 14}" cy="${y + h / 2}" r="4.5" fill="${STATUS(p)[status]}"/>` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${opts.fill ?? p.card}" stroke="${opts.stroke ?? p.stroke}" stroke-width="1.2"/>
  ${dot}<text x="${status ? x + 26 : x + w / 2}" y="${y + h / 2 + 4.5}" ${status ? '' : 'text-anchor="middle"'} ${SANS} font-size="${opts.size ?? 13}" font-weight="${opts.weight ?? 500}" fill="${opts.color ?? p.text}">${esc(label)}</text>`;
}

function band(p, y, h, title) {
  return `<rect x="20" y="${y}" width="920" height="${h}" rx="12" fill="none" stroke="${p.stroke}" stroke-width="1.2"/>
  <text x="36" y="${y + 22}" ${SANS} font-size="12" font-weight="700" letter-spacing="1.2" fill="${p.muted}">${esc(title)}</text>`;
}

function vArrow(p, x, y1, y2) {
  return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${p.line}" stroke-width="1.5" marker-start="url(#arr)" marker-end="url(#arr)"/>`;
}

function architecture(p) {
  const hosts = [
    ['Claude Code', 'done'], ['Codex', 'done'], ['CodeBuddy', 'done'], ['Cursor', 'done'], ['Gemini CLI', 'plan'],
    ['ChatGPT · Claude.ai', 'plan'], ['LangGraph · ADK · CrewAI', 'plan'],
  ];
  const widths = [112, 80, 106, 84, 104, 156, 184];
  let hx = 36;
  const hostChips = hosts.map(([l, s], i) => { const c = chip(p, hx, 46, widths[i], l, s); hx += widths[i] + 10; return c; }).join('\n  ');
  const access = [['hook shim', 'done', 200], ['CLI', 'done', 200], ['MCP server', 'wip', 200], ['REST · Python / TS SDK', 'plan', 270]];
  let ax = 36;
  const accessChips = access.map(([l, s, w]) => { const c = chip(p, ax, 148, w, l, s); ax += w + 12; return c; }).join('\n  ');
  const write = ['redact secrets', 'dedup · corroborate', 'claim-key conflicts', 'tentative → committed'];
  const recall = ['FTS (CJK bigram)', 'score · scope chain', 'token-budget packing', 'injection receipts'];
  const col = (x, title, items, status) =>
    `<text x="${x}" y="262" ${SANS} font-size="13" font-weight="700" fill="${p.text}">${esc(title)}</text>
  ${items.map((it, i) => chip(p, x, 272 + i * 40, 200, it, status, { h: 32, size: 12.5 })).join('\n  ')}`;
  const bottomCore = [['identity · scopes', 'done'], ['policy · ACL', 'wip'], ['memory experts (MoE)', 'plan'], ['dreamer · self-evolution', 'plan']];
  let bx = 36;
  const coreBottom = bottomCore.map(([l, s]) => { const c = chip(p, bx, 448, 214, l, s, { h: 32, size: 12.5 }); bx += 224; return c; }).join('\n  ');
  const storage = [['SQLite · WAL · FTS5', 'done', 250], ['git mode  .hivemem/', 'wip', 250], ['sync · Postgres · hosted', 'plan', 280]];
  let sx = 36;
  const storageChips = storage.map(([l, s, w]) => { const c = chip(p, sx, 554, w, l, s); sx += w + 14; return c; }).join('\n  ');

  return svg(
    960, 640,
    `${arrowDefs(p)}
  ${band(p, 12, 84, 'AGENTS & TOOLS')}
  ${hostChips}
  ${vArrow(p, 480, 100, 124)}
  ${band(p, 118, 76, 'ACCESS')}
  ${accessChips}
  ${vArrow(p, 480, 198, 222)}
  ${band(p, 216, 280, 'HIVEMEM CORE')}
  ${col(36, 'Write path', write, 'done')}
  <rect x="268" y="252" width="424" height="184" rx="12" fill="${p.accentSoft}" stroke="${p.accent}" stroke-width="2"/>
  <polygon points="${hexPoints(320, 300, 30)}" fill="none" stroke="${p.accent}" stroke-width="2.5"/>
  <circle cx="320" cy="300" r="7" fill="${p.accent}"/>
  <text x="364" y="292" ${SANS} font-size="20" font-weight="700" fill="${p.text}">Op ledger</text>
  <text x="364" y="314" ${SANS} font-size="12.5" fill="${p.muted}">the single source of truth</text>
  ${['append-only ops · HLC clock · sha256', 'deterministic fold → identical replicas', 'concurrent edits → sibling versions', 'every op carries runtime · agent · session'].map((s, i) => `<text x="290" y="${352 + i * 22}" ${SANS} font-size="13" fill="${p.text}"><tspan fill="${p.accent}">▸ </tspan>${esc(s)}</text>`).join('\n  ')}
  <line x1="240" y1="340" x2="266" y2="340" stroke="${p.accent}" stroke-width="2" marker-end="url(#arr)"/>
  <line x1="694" y1="340" x2="718" y2="340" stroke="${p.accent}" stroke-width="2" marker-end="url(#arr)"/>
  ${col(724, 'Recall path', recall, 'done')}
  ${coreBottom}
  ${vArrow(p, 480, 500, 524)}
  ${band(p, 518, 82, 'STORAGE & TRANSPORT')}
  ${storageChips}
  <circle cx="640" cy="622" r="4.5" fill="${p.good}"/><text x="650" y="626" ${SANS} font-size="12" fill="${p.muted}">shipped</text>
  <circle cx="722" cy="622" r="4.5" fill="${p.warn}"/><text x="732" y="626" ${SANS} font-size="12" fill="${p.muted}">in progress</text>
  <circle cx="820" cy="622" r="4.5" fill="${p.plan}"/><text x="830" y="626" ${SANS} font-size="12" fill="${p.muted}">planned</text>`,
    'HiveMem architecture: agents and tools, access layer, core (write path, op ledger, recall), storage and transport.',
  );
}

// ---------- animated terminal demo (theme-neutral dark terminal) ----------
function demo() {
  const T = { bg: '#0D1117', bar: '#161B22', stroke: '#30363D', text: '#E6EDF3', dim: '#7D8590', green: '#3FB950', amber: '#F5A524', blue: '#79C0FF', red: '#FF7B72', purple: '#D2A8FF' };
  const line = (x, y, t, color, delay, weight = 400) =>
    `<text class="l" style="animation-delay:${delay}s" x="${x}" y="${y}" ${MONO} font-size="13" font-weight="${weight}" fill="${color}" xml:space="preserve">${t}</text>`;
  const win = (x, title, subtitle) => `<rect x="${x}" y="16" width="458" height="270" rx="10" fill="${T.bg}" stroke="${T.stroke}"/>
  <path d="M${x} 26 a10 10 0 0 1 10 -10 h438 a10 10 0 0 1 10 10 v20 h-458 z" fill="${T.bar}"/>
  <circle cx="${x + 18}" cy="31" r="5" fill="#FF5F57"/><circle cx="${x + 34}" cy="31" r="5" fill="#FEBC2E"/><circle cx="${x + 50}" cy="31" r="5" fill="#28C840"/>
  <text x="${x + 229}" y="35" text-anchor="middle" ${SANS} font-size="12.5" font-weight="600" fill="${T.text}">${title} <tspan fill="${T.dim}" font-weight="400">${subtitle}</tspan></text>`;
  const L = 32, R = 518;
  const body = `<style>
  .l { opacity: 0; animation: in .35s ease-out forwards; }
  @keyframes in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .l { animation: none; opacity: 1; } }
  </style>
  ${win(14, 'claude-code', '· ~/acme-api')}
  ${win(488, 'codex', '· ~/acme-api-feature (worktree)')}
  ${line(L, 74, `<tspan fill="${T.purple}">you ›</tspan> 记住：后端 API 字段统一使用 snake_case`, T.text, 0.3)}
  ${line(L, 98, `<tspan fill="${T.green}">✓ hivemem</tspan> remembered <tspan fill="${T.blue}">410DW0</tspan> · user-stated`, T.dim, 1.0)}
  ${line(L, 116, `           → <tspan fill="${T.green}">committed</tspan> (shared with the project)`, T.dim, 1.2)}
  ${line(L, 150, `<tspan fill="${T.purple}">agent ›</tspan> remember: tests run with npm test`, T.text, 1.9)}
  ${line(L, 174, `<tspan fill="${T.amber}">○ hivemem</tspan> remembered <tspan fill="${T.blue}">PMZBGY</tspan> · agent-stated`, T.dim, 2.5)}
  ${line(L, 192, `           → <tspan fill="${T.amber}">tentative</tspan> until another tool agrees`, T.dim, 2.7)}
  ${line(L, 236, `# hooks: SessionStart + UserPromptSubmit`, T.dim, 3.0)}
  ${line(L, 254, `# no tool call needed, nothing to re-explain`, T.dim, 3.1)}
  ${line(R, 74, `<tspan fill="${T.dim}">session start · hook injects:</tspan>`, T.text, 3.6)}
  ${line(R, 96, `&lt;hivemem-memory&gt;`, T.dim, 4.0)}
  ${line(R, 114, `## Conventions &amp; facts`, T.blue, 4.2)}
  ${line(R, 132, `- 后端 API 字段统一使用 snake_case`, T.text, 4.4)}
  ${line(R, 150, `  ⟨410DW0 · user-stated via claude-code⟩`, T.dim, 4.5)}
  ${line(R, 168, `&lt;/hivemem-memory&gt;`, T.dim, 4.6)}
  ${line(R, 206, `<tspan fill="${T.purple}">agent ›</tspan> remember: tests run with npm test`, T.text, 5.3)}
  ${line(R, 230, `<tspan fill="${T.green}">✓ hivemem</tspan> corroborated <tspan fill="${T.blue}">PMZBGY</tspan>`, T.dim, 5.9)}
  ${line(R, 248, `           claude-code + codex → <tspan fill="${T.green}">committed</tspan>`, T.dim, 6.1)}
  <rect x="14" y="298" width="932" height="96" rx="10" fill="${T.bg}" stroke="${T.stroke}"/>
  ${line(L, 326, `<tspan fill="${T.purple}">$</tspan> hivemem inbox`, T.text, 6.9)}
  ${line(L, 350, `<tspan fill="${T.blue}">V90G9W</tspan>  <tspan fill="${T.red}">quarantined</tspan>  包管理器用 npm    <tspan fill="${T.dim}">(codex)</tspan>`, T.text, 7.4)}
  ${line(L, 372, `<tspan fill="${T.blue}">Z2VE58</tspan>  <tspan fill="${T.red}">quarantined</tspan>  包管理器用 pnpm   <tspan fill="${T.dim}">(claude-code)</tspan>   <tspan fill="${T.amber}">← agents disagree, you decide</tspan>`, T.text, 7.7)}`;
  return svg(960, 408, body, 'Demo: a convention remembered in Claude Code is injected into a Codex session; a fact confirmed by both tools is committed; a disagreement goes to the inbox.');
}

const files = {};
for (const [name, p] of Object.entries(PALETTES)) {
  files[`logo-${name}.svg`] = logo(p);
  files[`hero-${name}.svg`] = hero(p);
  files[`architecture-${name}.svg`] = architecture(p);
}
files['demo.svg'] = demo();
for (const [f, content] of Object.entries(files)) writeFileSync(join(OUT, f), content);
console.log(`wrote ${Object.keys(files).length} files to ${OUT}`);

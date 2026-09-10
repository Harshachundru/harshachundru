#!/usr/bin/env node
/**
 * Generates tech-stack-rings.svg from tech-stack.json.
 *
 * Why: hand-editing the SVG meant manually recomputing each ring's
 * stroke-dasharray (circumference * pct / 100) and hand-placing legend
 * dots/text every time a skill was added, removed, or re-scored. This
 * script does that math and layout instead — edit tech-stack.json and
 * re-run (or push, see .github/workflows/tech-stack-rings.yml).
 *
 * Layout rules (kept consistent across columns, regardless of skill count):
 *   - Columns are spaced 320px apart, each ring-stack centered at cy=182.
 *   - Rings span a fixed radius band (80 -> 20) subdivided evenly by skill
 *     count, ordered outermost -> innermost per the source array (put the
 *     most foundational skill first).
 *   - Ring stroke width shrinks automatically as a column gets more rings,
 *     so an 8-skill column stays legible without manual spacing tweaks.
 *   - Legend: <=3 skills -> single centered column; >3 -> split evenly into
 *     two columns (first half left, second half right). Canvas height grows
 *     automatically if a column's legend needs more rows than the default
 *     card fits.
 *
 * Usage: node scripts/generate-tech-stack-svg.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'tech-stack.json');
const OUT_PATH = path.join(ROOT, 'tech-stack-rings.svg');

const COLUMN_WIDTH = 320;
const OUTER_R = 80;
const INNER_R = 20;
const CY = 182;
const LABEL_Y = 88;
const LEGEND_TOP = 286; // y of first legend dot (cy + 104)
const LEGEND_ROW_H = 22;
const CARD_MIN_HEIGHT = 400;
const CARD_PAD_BOTTOM = 26;

const IDEAL_STEP = 14; // natural spacing for uncrowded columns (matches original hand-authored rings)

function ringGeometry(skills) {
  const n = skills.length;
  // Prefer a fixed, natural step so light columns don't stretch out and look
  // sparse; only fall back to spanning the full OUTER_R..INNER_R band (i.e.
  // shrinking the step) once a column has enough rings that the ideal step
  // would push the innermost ring below the legible minimum radius.
  let step = n > 1 ? IDEAL_STEP : 0;
  if (n > 1 && OUTER_R - (n - 1) * step < INNER_R) {
    step = (OUTER_R - INNER_R) / (n - 1);
  }
  const strokeWidth = n === 1 ? 14 : Math.max(4, Math.min(14, +(step * 0.75).toFixed(1)));
  return skills.map((skill, i) => {
    const r = OUTER_R - i * step;
    const circumference = 2 * Math.PI * r;
    const arcLength = (circumference * skill.pct) / 100;
    return { ...skill, r, strokeWidth, dasharray: `${arcLength.toFixed(2)} ${circumference.toFixed(2)}` };
  });
}

function legendLayout(skills, colCenter) {
  const n = skills.length;
  if (n <= 3) {
    const dotX = colCenter - 85;
    const textX = colCenter - 74;
    return skills.map((skill, i) => ({ skill, dotX, textX, y: LEGEND_TOP + i * LEGEND_ROW_H }));
  }
  const half = Math.ceil(n / 2);
  const left = skills.slice(0, half);
  const right = skills.slice(half);
  const leftDotX = colCenter - 122;
  const leftTextX = colCenter - 111;
  const rightDotX = colCenter + 18;
  const rightTextX = colCenter + 29;
  const entries = left.map((skill, i) => ({ skill, dotX: leftDotX, textX: leftTextX, y: LEGEND_TOP + i * LEGEND_ROW_H }));
  right.forEach((skill, i) => entries.push({ skill, dotX: rightDotX, textX: rightTextX, y: LEGEND_TOP + i * LEGEND_ROW_H }));
  return { entries, rows: Math.max(left.length, right.length) };
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildColumnSvg(column, index, colCenter) {
  const rings = ringGeometry(column.skills);
  const legend = legendLayout(column.skills, colCenter);
  const entries = Array.isArray(legend) ? legend : legend.entries;

  const ringMarkup = rings
    .map(
      (ring) => `      <!-- ${esc(ring.name)} ${ring.pct}% -->
      <circle class="ring-track track" cx="${colCenter}" cy="${CY}" r="${ring.r.toFixed(2)}" stroke-width="${ring.strokeWidth}"/>
      <circle class="ring-progress" cx="${colCenter}" cy="${CY}" r="${ring.r.toFixed(2)}" stroke-width="${ring.strokeWidth}"
              stroke="${ring.color}" stroke-dasharray="${ring.dasharray}"/>`
    )
    .join('\n');

  const legendMarkup = entries
    .map(
      (e) => `      <circle cx="${e.dotX}" cy="${e.y}" r="5" fill="${e.skill.color}"/>
      <text class="legend-text" x="${e.textX}" y="${e.y + 4}">${esc(e.skill.name)} <tspan class="legend-pct">${e.skill.pct}%</tspan></text>`
    )
    .join('\n');

  const rows = Array.isArray(legend) ? column.skills.length : legend.rows;

  return {
    rows,
    markup: `  <!-- ===================== ${esc(column.name)} ===================== -->
  <g>
    <text class="col-label" x="${colCenter}" y="${LABEL_Y}" text-anchor="middle">${esc(column.name)}</text>
    <g transform="rotate(-90 ${colCenter} ${CY})">
${ringMarkup}
    </g>
    <g>
${legendMarkup}
    </g>
  </g>`,
  };
}

function buildDesc(columns) {
  const parts = columns.map((col) => {
    const skills = col.skills.map((s) => `${s.name} ${s.pct}%`).join(', ');
    return `${col.name} (${skills})`;
  });
  return `Concentric ring chart: ${parts.join(', ')}`;
}

function generate(data) {
  const columns = data.columns;
  const width = columns.length * COLUMN_WIDTH;
  const maxRows = Math.max(0, ...columns.map((col, i) => buildColumnSvg(col, i, 0).rows));
  const height = Math.max(CARD_MIN_HEIGHT, LEGEND_TOP + maxRows * LEGEND_ROW_H + CARD_PAD_BOTTOM);

  const columnBlocks = columns.map((col, i) => buildColumnSvg(col, i, COLUMN_WIDTH / 2 + i * COLUMN_WIDTH).markup).join('\n\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">
  <title id="title">Tech Stack Proficiency Rings</title>
  <desc id="desc">${esc(buildDesc(columns))}</desc>
  <style>
    /* ---- default: light theme ---- */
    .bg   { fill: #ffffff; }
    .card-border { stroke: #d0d7de; }
    .title { fill: #1f2328; }
    .col-label { fill: #1f2328; }
    .track { stroke: #eaeef2; }
    .legend-text { fill: #1f2328; }
    .legend-pct { fill: #57606a; }

    /* ---- dark theme override ---- */
    @media (prefers-color-scheme: dark) {
      .bg   { fill: #0d1117; }
      .card-border { stroke: #30363d; }
      .title { fill: #e6edf3; }
      .col-label { fill: #c9d1d9; }
      .track { stroke: #21262d; }
      .legend-text { fill: #c9d1d9; }
      .legend-pct { fill: #8b949e; }
    }

    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .title { font-size: 26px; font-weight: 700; }
    .col-label { font-size: 15px; font-weight: 600; }
    .legend-text { font-size: 13.5px; font-weight: 600; }
    .legend-pct { font-size: 12.5px; font-weight: 500; }
    .ring-track { fill: none; }
    .ring-progress { fill: none; stroke-linecap: round; }
  </style>

  <rect class="bg card-border" x="1" y="1" width="${width - 2}" height="${height - 2}" rx="16" stroke-width="1.5"/>

  <text class="title" x="${width / 2}" y="42" text-anchor="middle">🛠️ Tech Stack Proficiency</text>

${columnBlocks}
</svg>
`;
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const svg = generate(data);
  fs.writeFileSync(OUT_PATH, svg);
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main();

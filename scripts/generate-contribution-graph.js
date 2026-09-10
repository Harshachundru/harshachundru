#!/usr/bin/env node
/**
 * Generates contribution-graph.svg: an isometric 3D city of the last year
 * of GitHub contributions, built entirely from scratch (no third-party
 * rendering action) so the whole pipeline is inspectable. Every day with
 * commits becomes a building — taller and brighter the busier the day —
 * and every quiet day stays open park ground, lightly scattered with
 * trees, a dog, a kid, or a cyclist (see decorationFor() below).
 *
 * Why this replaces .github/workflows/profile-3d-contrib.yml:
 * that workflow authenticated the yoshi389111/github-profile-3d-contrib
 * action with the default `secrets.GITHUB_TOKEN`. That token is an Actions
 * installation token scoped to this one repo — GitHub's GraphQL API
 * rejects account-wide `user(login:) { contributionsCollection }` queries
 * from it ("Resource not accessible by integration"), so the action fell
 * back to near-empty data (the rendered graph showed ~5 total
 * contributions and 0 stars/forks, nowhere close to reality). Every action
 * in this family documents the fix as the same thing: use a classic
 * Personal Access Token with `read:user` scope instead.
 *
 * This script makes that one GraphQL call itself and renders the SVG
 * itself — two steps you can read top to bottom instead of a compiled
 * third-party binary.
 *
 * Requires env vars:
 *   CONTRIB_TOKEN     - classic GitHub PAT, scope: read:user
 *   GITHUB_LOGIN       - the username to fetch (defaults to
 *                        GITHUB_REPOSITORY_OWNER, set automatically by
 *                        GitHub Actions)
 *
 * Usage: node scripts/generate-contribution-graph.js
 */
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { COLUMN_WIDTH } = require('./layout-config');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'contribution-graph.svg');
const TECH_STACK_DATA_PATH = path.join(ROOT, 'tech-stack.json');

const TOKEN = process.env.CONTRIB_TOKEN;
const LOGIN = process.env.GITHUB_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;

// ---------------------------------------------------------------------
// Step 1: fetch the real contribution calendar via GitHub's GraphQL API.
// This is the same public data shown on the profile page's calendar —
// no scopes beyond read:user are needed to read another account's public
// contribution history.
// ---------------------------------------------------------------------

const QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              weekday
              contributionCount
            }
          }
        }
      }
    }
  }
`;

function graphqlRequest(query, variables) {
  const body = JSON.stringify({ query, variables });
  const options = {
    hostname: 'api.github.com',
    path: '/graphql',
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'harshachundru-contribution-graph-script',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) {
            reject(new Error(`GraphQL error: ${JSON.stringify(parsed.errors)}`));
            return;
          }
          resolve(parsed.data);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Width this SVG should render at: the same width tech-stack-rings.svg
// would generate for its current column count, so the two cards match on
// the profile page. Falls back to a plain 3-column width if tech-stack.json
// is missing (e.g. this script gets reused in a repo without that file).
function targetWidth() {
  try {
    const data = JSON.parse(fs.readFileSync(TECH_STACK_DATA_PATH, 'utf8'));
    return data.columns.length * COLUMN_WIDTH;
  } catch {
    return 3 * COLUMN_WIDTH;
  }
}

// ---------------------------------------------------------------------
// Step 2: project each day onto an isometric grid and extrude it into a
// 3D bar whose height encodes contribution count. Pure geometry, no
// libraries — three visible faces per bar (top, left, right), each a
// hand-computed polygon.
// ---------------------------------------------------------------------

// Tile footprint (HALF_W/HALF_H) is derived at render time, not fixed here —
// see targetWidth() below. It's sized so this SVG always ends up exactly as
// wide as tech-stack-rings.svg, however many weeks or tech-stack columns
// either one has, so the two cards line up on the profile page.
// Half-height : half-width ratio for one tile — how much vertical "depth"
// each week/weekday step gets. Deliberately taller than the flattest
// version this script has had, because a city needs headroom: buildings
// have to read as buildings, and the park decorations need room to stand
// in front of them without getting crushed into a sliver.
const TILE_ASPECT = 0.45;
// Zero-contribution days sit perfectly flush with the ground (height 0) —
// that's the park, not a building lot — so empty stretches read as open
// green space instead of a field of small pillars. Only days with real
// activity rise up as buildings, stepping up from ACTIVE_MIN_H the moment a
// day has any contributions at all, up to a skyline-topping MAX_BAR_H for
// the single busiest day.
const ACTIVE_MIN_H = 14;
const MAX_BAR_H = 70; // height of the single highest-contribution day's building
const MARGIN = 24;
// No title is drawn inside the SVG — the README heading above the image is
// the only title — so the top margin only needs to clear the tallest bar.
const LEGEND_H = 58; // space reserved below the terrain for the legend row
const LEGEND_SWATCH = 22; // px, up from 16 — matches tech-stack-rings.svg's legend text scale better
const LEGEND_GAP = 34; // px between swatch starts
const LEGEND_FONT = 14; // px, up from 12

// Buildings are shades of glass-blue, not green — green is reserved for the
// park's trees, so the two never blur into each other. Same idea as
// GitHub's 5-level intensity scale (0 = no contributions .. 4 = highest
// bucket), as HSL so the two shaded cube faces per building can be derived
// algebraically instead of hand-picking 15 hexes.
const LEVEL_HUES = [
  { h: 210, s: 14, l: 22 }, // level 0 — empty lot, unused (park ground uses the .ground CSS class instead)
  { h: 205, s: 30, l: 35 },
  { h: 205, s: 45, l: 45 },
  { h: 205, s: 60, l: 55 },
  { h: 205, s: 75, l: 65 }, // level 4 — tallest, brightest tower
];

function levelFor(count, max) {
  if (count === 0) return 0;
  if (max <= 0) return 0;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function hsl(h, s, l) {
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
}

function isoPoint(origin, tile, col, row, z) {
  return {
    x: origin.x + (col - row) * tile.halfW,
    y: origin.y + (col + row) * tile.halfH - z,
  };
}

function pointsAttr(pts) {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

// ---------------------------------------------------------------------
// Park decorations: every empty (no-contribution) tile is open ground, and
// a minority of them get a tiny scattered tree, dog, kid, or cyclist —
// deterministically, seeded from the day's own date string. Same input
// data always produces the same little scene; it's not reshuffled every
// time the workflow reruns with unchanged contributions.
// ---------------------------------------------------------------------

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — a tiny, dependency-free seeded PRNG. Good enough for
// "scatter some trees," not for anything cryptographic.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function drawTree(p, rng) {
  const trunkH = 4 + rng() * 3;
  const canopyR = 4 + rng() * 2.5;
  const canopy = [hsl(142, 40, 28), hsl(140, 45, 33), hsl(150, 35, 30)][Math.floor(rng() * 3)];
  return (
    `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${(p.y - trunkH).toFixed(1)}" stroke="#8a5a34" stroke-width="1.6"/>` +
    `<circle cx="${p.x.toFixed(1)}" cy="${(p.y - trunkH - canopyR * 0.7).toFixed(1)}" r="${canopyR.toFixed(1)}" fill="${canopy}"/>`
  );
}

function drawDog(p, rng) {
  const dir = rng() < 0.5 ? -1 : 1;
  const body = [hsl(28, 45, 40), hsl(20, 30, 30), hsl(35, 25, 55)][Math.floor(rng() * 3)];
  return (
    `<ellipse cx="${p.x.toFixed(1)}" cy="${(p.y - 2.4).toFixed(1)}" rx="4.2" ry="2.2" fill="${body}"/>` +
    `<circle cx="${(p.x + dir * 4.6).toFixed(1)}" cy="${(p.y - 3.2).toFixed(1)}" r="1.6" fill="${body}"/>` +
    `<line x1="${(p.x - dir * 4.4).toFixed(1)}" y1="${(p.y - 1.6).toFixed(1)}" x2="${(p.x - dir * 6.6).toFixed(1)}" y2="${(p.y - 4).toFixed(1)}" stroke="${body}" stroke-width="1.2"/>`
  );
}

function drawKid(p, rng) {
  const shirt = [hsl(4, 70, 58), hsl(210, 70, 58), hsl(45, 80, 58), hsl(140, 45, 45)][Math.floor(rng() * 4)];
  const skin = '#e3ad80';
  const armSwing = rng() * 2 - 1; // -1..1, so a couple of kids look mid-motion instead of identical
  return (
    `<circle cx="${p.x.toFixed(1)}" cy="${(p.y - 8.2).toFixed(1)}" r="1.7" fill="${skin}"/>` +
    `<line x1="${p.x.toFixed(1)}" y1="${(p.y - 6.6).toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${(p.y - 2).toFixed(1)}" stroke="${shirt}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<line x1="${(p.x - 2.8 - armSwing).toFixed(1)}" y1="${(p.y - 5.6 + armSwing).toFixed(1)}" x2="${(p.x + 2.8 - armSwing).toFixed(1)}" y2="${(p.y - 5.6 - armSwing).toFixed(1)}" stroke="${shirt}" stroke-width="1.2" stroke-linecap="round"/>` +
    `<line x1="${(p.x - 1.1).toFixed(1)}" y1="${(p.y - 2).toFixed(1)}" x2="${(p.x - 2).toFixed(1)}" y2="${(p.y + 2.2).toFixed(1)}" stroke="${skin}" stroke-width="1.3" stroke-linecap="round"/>` +
    `<line x1="${(p.x + 1.1).toFixed(1)}" y1="${(p.y - 2).toFixed(1)}" x2="${(p.x + 2).toFixed(1)}" y2="${(p.y + 2.2).toFixed(1)}" stroke="${skin}" stroke-width="1.3" stroke-linecap="round"/>`
  );
}

function drawCyclist(p, rng) {
  const frame = [hsl(4, 70, 55), hsl(210, 70, 55), hsl(140, 45, 45)][Math.floor(rng() * 3)];
  const r = 2.6;
  const y = p.y - r;
  const x1 = p.x - 3.6;
  const x2 = p.x + 3.6;
  return (
    `<circle cx="${x1.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" stroke="${frame}" stroke-width="1"/>` +
    `<circle cx="${x2.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" stroke="${frame}" stroke-width="1"/>` +
    `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${(y - 3.2).toFixed(1)}" stroke="${frame}" stroke-width="1"/>` +
    `<line x1="${x2.toFixed(1)}" y1="${y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${(y - 3.2).toFixed(1)}" stroke="${frame}" stroke-width="1"/>` +
    `<circle cx="${p.x.toFixed(1)}" cy="${(y - 5.2).toFixed(1)}" r="1.4" fill="#e3ad80"/>`
  );
}

// Rolls whether an empty tile gets a decoration, and if so, which one and
// exactly where within the tile — all from one seeded RNG so the result is
// stable for a given day but varies naturally from tile to tile.
function decorationFor(origin, tile, col, row, seedKey) {
  const rng = mulberry32(hashSeed(seedKey));
  if (rng() > 0.22) return ''; // most of the park stays open lawn — a scattered few, not a crowd
  const fx = col + 0.25 + rng() * 0.5;
  const fy = row + 0.25 + rng() * 0.5;
  const p = isoPoint(origin, tile, fx, fy, 0);
  const roll = rng();
  if (roll < 0.5) return drawTree(p, rng);
  if (roll < 0.68) return drawDog(p, rng);
  if (roll < 0.86) return drawKid(p, rng);
  return drawCyclist(p, rng);
}

// How long one building takes to rise, and how much later each successive
// building (in back-to-front painter's order) starts — a small stagger
// across ~370 tiles reads as a wave sweeping across the skyline instead of
// the whole city popping up at once. Both are deliberately short: this is a
// one-time flourish on page load, not a looping animation, so it settles
// down quickly rather than lingering as a distraction.
const GROW_DURATION_S = 0.9;
const GROW_STAGGER_S = 0.012;

function barSvg(origin, tile, col, row, height, level, delaySec) {
  const top = LEVEL_HUES[level];
  const A = isoPoint(origin, tile, col, row, height);
  const B = isoPoint(origin, tile, col + 1, row, height);
  const C = isoPoint(origin, tile, col + 1, row + 1, height);
  const D = isoPoint(origin, tile, col, row + 1, height);
  const A0 = isoPoint(origin, tile, col, row, 0);
  const B0 = isoPoint(origin, tile, col + 1, row, 0);
  const C0 = isoPoint(origin, tile, col + 1, row + 1, 0);
  const D0 = isoPoint(origin, tile, col, row + 1, 0);

  // Level 0 (no contributions) uses the theme-aware "ground" class instead
  // of a hard-coded color, so the empty mat matches the viewer's light/dark
  // theme the same way tech-stack-rings.svg's track rings do. Park ground
  // doesn't grow — only buildings do.
  if (level === 0) {
    return `<polygon points="${pointsAttr([A0, B0, C0, D0])}" class="ground"/>`;
  }

  // Growth is animated by moving the actual polygon points, not a CSS
  // transform: each corner of an isometric diamond sits at a different
  // baseline screen-Y (the tile "wobbles" up and down across its 4
  // corners), so a single scaleY anchor can't reproduce it correctly. But
  // every point here is an affine (linear) function of height — isoPoint's
  // `y = ... - z` — so linearly interpolating the raw point coordinates
  // from their height=0 state to their final-height state via SMIL
  // reproduces the exact in-between shape at every animation frame, not an
  // approximation. SMIL <animate> (unlike CSS transitions) can animate an
  // SVG `points` attribute directly, and — like CSS animations — it
  // autoplays fine even when this SVG is loaded as a plain <img>, which is
  // how GitHub renders markdown images (no JS, no hover state, but
  // animations that start on their own do run).
  const fill = hsl(top.h, top.s, top.l);
  const leftFace = hsl(top.h, top.s, Math.max(6, top.l - 12));
  const rightFace = hsl(top.h, top.s, Math.max(4, top.l - 22));

  const grow = (fromPts, toPts) =>
    `<animate attributeName="points" from="${fromPts}" to="${toPts}" begin="${delaySec.toFixed(3)}s" dur="${GROW_DURATION_S}s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1"/>`;

  const flatTop = pointsAttr([A0, B0, C0, D0]);
  const fullTop = pointsAttr([A, B, C, D]);
  const flatLeft = pointsAttr([D0, C0, C0, D0]);
  const fullLeft = pointsAttr([D, C, C0, D0]);
  const flatRight = pointsAttr([B0, C0, C0, B0]);
  const fullRight = pointsAttr([B, C, C0, isoPoint(origin, tile, col + 1, row, 0)]);

  return (
    `<polygon points="${flatTop}" fill="${fill}">${grow(flatTop, fullTop)}</polygon>` +
    `<polygon points="${flatLeft}" fill="${leftFace}">${grow(flatLeft, fullLeft)}</polygon>` +
    `<polygon points="${flatRight}" fill="${rightFace}">${grow(flatRight, fullRight)}</polygon>`
  );
}

function render(weeks, totalContributions, login) {
  const days = weeks.flatMap((w) => w.contributionDays);
  const maxCount = Math.max(0, ...days.map((d) => d.contributionCount));
  const numCols = weeks.length;
  const numRows = 7;

  // Solve for a tile footprint that makes this SVG exactly as wide as
  // tech-stack-rings.svg currently renders (see targetWidth()), instead of
  // using a fixed pixel size — so the two cards always match, regardless of
  // how many weeks GitHub returns or how many tech-stack columns exist.
  const width = targetWidth();
  const halfW = (width - 2 * MARGIN) / (numCols + numRows);
  const tile = { halfW, halfH: halfW * TILE_ASPECT };

  // Canvas is sized to exactly fit the projected terrain — leftmost bar
  // corner lands at x=MARGIN, topmost (tallest) bar top lands at
  // y=MARGIN, and the deepest bottom-right corner lands right before the
  // legend row.
  const origin = { x: MARGIN + numRows * tile.halfW, y: MARGIN + MAX_BAR_H };
  const terrainBottom = origin.y + (numCols + numRows) * tile.halfH;
  const height = terrainBottom + LEGEND_H;

  // Draw back-to-front (by col+row) so nearer bars correctly occlude
  // farther ones — standard painter's algorithm for an isometric scene.
  const ordered = [...days].sort((a, b) => {
    const rankA = weeks.findIndex((w) => w.contributionDays.includes(a));
    const rankB = weeks.findIndex((w) => w.contributionDays.includes(b));
    return rankA + a.weekday - (rankB + b.weekday);
  });

  const bars = ordered
    .map((day, i) => {
      const week = weeks.find((w) => w.contributionDays.includes(day));
      const col = weeks.indexOf(week);
      const row = day.weekday;
      const level = levelFor(day.contributionCount, maxCount);
      const barHeight = day.contributionCount === 0 ? 0 : ACTIVE_MIN_H + (MAX_BAR_H - ACTIVE_MIN_H) * Math.sqrt(day.contributionCount / maxCount);
      // Stagger by painter's-order index (already back-to-front), so the
      // grow-in reads as a wave sweeping across the skyline in the same
      // direction the tiles are drawn, rather than random popcorn.
      const building = barSvg(origin, tile, col, row, barHeight, level, i * GROW_STAGGER_S);
      // Only empty lots (no contributions that day) are park ground — a
      // building day stays a building, never gets a tree growing out of it.
      const park = level === 0 ? decorationFor(origin, tile, col, row, day.date) : '';
      return `<g><title>${day.contributionCount} contribution${day.contributionCount === 1 ? '' : 's'} on ${day.date}</title>${building}${park}</g>`;
    })
    .join('\n    ');

  const legendY = terrainBottom + 22;
  const legendTextY = legendY + LEGEND_SWATCH / 2 + LEGEND_FONT * 0.35; // vertically centers the text against the swatch row
  const legendSwatchesX = MARGIN + 48;
  const legend = LEVEL_HUES.map((c, i) =>
    i === 0
      ? `<rect x="${legendSwatchesX}" y="${legendY}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" rx="4" class="ground"/>`
      : `<rect x="${legendSwatchesX + i * LEGEND_GAP}" y="${legendY}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" rx="4" fill="${hsl(c.h, c.s, c.l)}"/>`
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">
  <title id="title">My Contribution Terrain</title>
  <desc id="desc">Isometric 3D city of the last year of GitHub contributions for ${login}, ${totalContributions} total — commit days as buildings, quiet days as park ground with scattered trees, dogs, kids, and cyclists. Generated from scratch by scripts/generate-contribution-graph.js.</desc>
  <style>
    /* ---- default: light theme (same tokens as tech-stack-rings.svg) ---- */
    .bg { fill: #ffffff; }
    .card-border { stroke: #d0d7de; }
    .ground { fill: #eaeef2; }
    .legend-label { fill: #57606a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: ${LEGEND_FONT}px; font-weight: 500; }

    /* ---- dark theme override ---- */
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .card-border { stroke: #30363d; }
      .ground { fill: #21262d; }
      .legend-label { fill: #8b949e; }
    }
  </style>
  <rect class="bg card-border" x="1" y="1" width="${width - 2}" height="${height - 2}" rx="16" stroke-width="1.5"/>
  <g>
    ${bars}
  </g>
  <text class="legend-label" x="${MARGIN}" y="${legendTextY}">Less</text>
  ${legend}
  <text class="legend-label" x="${legendSwatchesX + LEVEL_HUES.length * LEGEND_GAP + 8}" y="${legendTextY}">More</text>
</svg>
`;
}

async function main() {
  if (!TOKEN) {
    console.error(
      'Missing CONTRIB_TOKEN. Create a classic PAT (scope: read:user) at ' +
        'github.com/settings/tokens, add it as a repo secret named CONTRIB_TOKEN ' +
        '(Settings -> Secrets and variables -> Actions), and re-run.'
    );
    process.exit(1);
  }
  if (!LOGIN) {
    console.error('Missing GITHUB_LOGIN (or GITHUB_REPOSITORY_OWNER) — who to fetch contributions for.');
    process.exit(1);
  }

  const data = await graphqlRequest(QUERY, { login: LOGIN });
  const user = data.user;
  if (!user) {
    throw new Error(`GitHub user "${LOGIN}" not found (or token lacks access).`);
  }
  const calendar = user.contributionsCollection.contributionCalendar;
  const svg = render(calendar.weeks, calendar.totalContributions, LOGIN);
  fs.writeFileSync(OUT_PATH, svg);
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${calendar.totalContributions} total contributions)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { render, levelFor, isoPoint };

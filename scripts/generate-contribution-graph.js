#!/usr/bin/env node
/**
 * Generates contribution-graph.svg: an isometric 3D terrain of the last
 * year of GitHub contributions, built entirely from scratch (no
 * third-party rendering action) so the whole pipeline is inspectable.
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
const TILE_ASPECT = 6.5 / 11; // half-height : half-width ratio to preserve whatever the absolute tile size ends up being
// Zero-contribution days sit perfectly flush with the ground (height 0) so
// empty stretches read as a calm, continuous flat mat instead of a field of
// small pillars — only days with real activity rise up as distinct blocks,
// stepping up from ACTIVE_MIN_H the moment a day has any contributions at
// all, so "something happened" is visually obvious even for a count of 1.
// Heights stay small relative to the tile footprint — low ridges on a mat,
// not skyscrapers — which is what keeps a dense, busy year from reading as
// a jagged mountain range.
const ACTIVE_MIN_H = 4;
const MAX_BAR_H = 15; // height of the single highest-contribution day
const MARGIN = 24;
// No title is drawn inside the SVG — the README heading above the image is
// the only title — so the top margin only needs to clear the tallest bar.
const LEGEND_H = 44; // space reserved below the terrain for the legend row

// Color ramp mirrors GitHub's own 5-level intensity scale (0 = no
// contributions .. 4 = highest bucket), but as HSL so we can algebraically
// darken it for the two shaded cube faces instead of hand-picking 15 hexes.
const LEVEL_HUES = [
  { h: 210, s: 14, l: 22 }, // level 0 — empty tile, dark neutral
  { h: 142, s: 45, l: 30 },
  { h: 142, s: 55, l: 40 },
  { h: 142, s: 65, l: 50 },
  { h: 142, s: 75, l: 60 }, // level 4 — most active days
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

function barSvg(origin, tile, col, row, height, level) {
  const top = LEVEL_HUES[level];
  const A = isoPoint(origin, tile, col, row, height);
  const B = isoPoint(origin, tile, col + 1, row, height);
  const C = isoPoint(origin, tile, col + 1, row + 1, height);
  const D = isoPoint(origin, tile, col, row + 1, height);
  // Level 0 (no contributions) uses the theme-aware "ground" class instead
  // of a hard-coded color, so the empty mat matches the viewer's light/dark
  // theme the same way tech-stack-rings.svg's track rings do.
  const topFace =
    level === 0
      ? `<polygon points="${pointsAttr([A, B, C, D])}" class="ground"/>`
      : `<polygon points="${pointsAttr([A, B, C, D])}" fill="${hsl(top.h, top.s, top.l)}"/>`;

  // A zero-contribution day is flush with the ground (height 0) — draw only
  // its flat top so it merges into the surrounding mat instead of getting a
  // visible pillar outline. Only days that actually rose above the ground
  // get side walls.
  if (height <= 0) return topFace;

  // Shade the two side faces relative to the top face so intensity level
  // still reads correctly, without hand-authoring 15 separate colors.
  const leftFace = hsl(top.h, top.s, Math.max(6, top.l - 12));
  const rightFace = hsl(top.h, top.s, Math.max(4, top.l - 22));
  const C0 = isoPoint(origin, tile, col + 1, row + 1, 0);
  const D0 = isoPoint(origin, tile, col, row + 1, 0);

  return (
    topFace +
    `<polygon points="${pointsAttr([D, C, C0, D0])}" fill="${leftFace}"/>` +
    `<polygon points="${pointsAttr([B, C, C0, isoPoint(origin, tile, col + 1, row, 0)])}" fill="${rightFace}"/>`
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
    .map((day) => {
      const week = weeks.find((w) => w.contributionDays.includes(day));
      const col = weeks.indexOf(week);
      const row = day.weekday;
      const level = levelFor(day.contributionCount, maxCount);
      const barHeight = day.contributionCount === 0 ? 0 : ACTIVE_MIN_H + (MAX_BAR_H - ACTIVE_MIN_H) * Math.sqrt(day.contributionCount / maxCount);
      return `<g><title>${day.contributionCount} contribution${day.contributionCount === 1 ? '' : 's'} on ${day.date}</title>${barSvg(origin, tile, col, row, barHeight, level)}</g>`;
    })
    .join('\n    ');

  const legendY = terrainBottom + 20;
  const legend = LEVEL_HUES.map((c, i) =>
    i === 0
      ? `<rect x="${MARGIN + 36}" y="${legendY}" width="16" height="16" rx="3" class="ground"/>`
      : `<rect x="${MARGIN + 36 + i * 26}" y="${legendY}" width="16" height="16" rx="3" fill="${hsl(c.h, c.s, c.l)}"/>`
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">
  <title id="title">My Contribution Terrain</title>
  <desc id="desc">Isometric 3D bar chart of the last year of GitHub contributions for ${login}, ${totalContributions} total. Generated from scratch by scripts/generate-contribution-graph.js.</desc>
  <style>
    /* ---- default: light theme (same tokens as tech-stack-rings.svg) ---- */
    .bg { fill: #ffffff; }
    .card-border { stroke: #d0d7de; }
    .ground { fill: #eaeef2; }
    .legend-label { fill: #57606a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12px; }

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
  <text class="legend-label" x="${MARGIN}" y="${legendY + 13}">Less</text>
  ${legend}
  <text class="legend-label" x="${MARGIN + 36 + LEVEL_HUES.length * 26 + 6}" y="${legendY + 13}">More</text>
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

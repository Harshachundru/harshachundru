// Shared layout constants so every generated profile SVG stays the same
// width, regardless of how many columns/weeks it happens to have. Both
// generate-tech-stack-svg.js and generate-contribution-graph.js import this
// instead of hard-coding their own copy of the number.
'use strict';

module.exports = {
  COLUMN_WIDTH: 320, // px per tech-stack column; also the unit the contribution terrain matches its total width against
};

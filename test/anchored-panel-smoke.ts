import assert from "node:assert/strict";
import { panelPlacement } from "../src/anchored-panel";

const topRight = panelPlacement({ left: 900, right: 960, top: 40, bottom: 70 }, { width: 1000, height: 800 }, 520);
assert.deepEqual(topRight, { width: 520, left: 440, top: 78, bottom: undefined, maxHeight: 710 });
const narrow = panelPlacement({ left: 300, right: 350, top: 40, bottom: 70 }, { width: 360, height: 640 }, 620);
assert.equal(narrow.width, 336);
assert.equal(narrow.left, 12);
assert(narrow.left + narrow.width <= 348);
const lower = panelPlacement({ left: 500, right: 560, top: 700, bottom: 730 }, { width: 1000, height: 800 }, 520);
assert.equal(lower.top, undefined);
assert.equal(lower.bottom, 108);
assert.equal(lower.maxHeight, 680);
const leftEdge = panelPlacement({ left: 0, right: 40, top: 20, bottom: 50 }, { width: 800, height: 600 }, 520);
assert.equal(leftEdge.left, 12);
console.log("anchored panel smoke: toolbar alignment, narrow-window bounds and bottom-edge placement passed");

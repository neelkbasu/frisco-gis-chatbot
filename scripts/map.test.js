const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const amenitiesHandler = require("../api/amenities");

const MAP_SOURCE = fs.readFileSync(path.join(__dirname, "../map.js"), "utf8");
const DEMO = { latitude: 33.15, longitude: -96.83 };

// Park outlines the fake park layer knows, keyed by park-layer spelling.
const OUTLINES = {
  "FRISCO COMMONS PARK": { type: "polygon", centroid: { type: "point", x: 1, y: 1 } },
  "GALLEGOS PARK": { type: "polygon", centroid: { type: "point", x: 2, y: 2 } },
  "WRANGER'S RANGE PARK": { type: "polygon", centroid: { type: "point", x: 3, y: 3 } },
};

// Run map.js in a sandbox with a fake ArcGIS SDK. `queryDelay(where)` can
// return a promise to hold a park query open; `sdkFails` simulates the SDK
// not loading.
function loadMap({ queryDelay, sdkFails = false } = {}) {
  const state = { layer: null, goTo: [], queries: [], status: { textContent: "" }, bodyClasses: new Set() };

  class GraphicsLayer {
    constructor() { this.graphics = []; state.layer = this; }
    removeAll() { this.graphics = []; }
    addMany(graphics) { this.graphics.push(...graphics); }
  }
  const modules = {
    "esri/WebMap": class { when(callback) { callback(); return Promise.resolve(); } add() {} },
    "esri/views/MapView": class {
      constructor() { this.spatialReference = { wkid: 2276 }; this.scale = 50000; }
      when() { return Promise.resolve(); }
      goTo(target) { state.goTo.push(target); return Promise.resolve(); }
    },
    "esri/layers/GraphicsLayer": GraphicsLayer,
    "esri/layers/FeatureLayer": class {
      async queryFeatures({ where }) {
        state.queries.push(where);
        await queryDelay?.(where);
        const names = [...where.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replaceAll("''", "'"));
        return {
          features: names.filter((name) => OUTLINES[name])
            .map((name) => ({ attributes: { ParkName: name }, geometry: OUTLINES[name] })),
        };
      }
    },
    "esri/Graphic": class { constructor(options) { Object.assign(this, options); } },
    "esri/geometry/Point": class { constructor(options) { Object.assign(this, options); } },
    "esri/geometry/projection": {
      load: () => Promise.resolve(),
      project: (point) => ({ type: "point", x: point.longitude, y: point.latitude }),
    },
  };

  const document = {
    querySelector: (selector) => (selector === "#map-status" ? state.status : null),
    createElement: () => ({}),
    head: {
      // Only reached when the SDK is missing: report the load failure.
      appendChild(element) { if (element.src) setTimeout(() => element.onerror()); },
    },
    body: {
      classList: {
        add: (name) => state.bodyClasses.add(name),
        contains: (name) => state.bodyClasses.has(name),
      },
    },
  };

  const context = vm.createContext({
    document,
    console: { error() {} },
    setTimeout,
    fetch: async () => {
      const response = { setHeader() {}, end(body) { this.body = body; } };
      amenitiesHandler({ method: "GET" }, response);
      return { ok: true, json: async () => JSON.parse(response.body) };
    },
  });
  context.window = context;
  if (!sdkFails) {
    context.require = (names, callback) => callback(...names.map((name) => modules[name]));
  }
  vm.runInContext(MAP_SOURCE, context);
  return { FriscoMap: context.FriscoMap, state };
}

function numbersOnMap(state) {
  return state.layer.graphics.filter((graphic) => graphic.symbol.type === "text").map((graphic) => graphic.symbol.text);
}

test("an answer gets outlines, numbered pins, and the resident's location", async () => {
  const { FriscoMap, state } = loadMap();
  await FriscoMap.showResults([
    { park: "Gallegos Park", latitude: 33.149, longitude: -96.828, distanceMiles: 0.26 },
    { park: "Frisco Commons Park", latitude: 33.12, longitude: -96.81, distanceMiles: 0.7 },
  ], DEMO);

  const types = state.layer.graphics.map((graphic) => graphic.symbol.type);
  assert.equal(types.filter((type) => type === "simple-fill").length, 2);
  assert.deepEqual(numbersOnMap(state), ["1", "2"]);
  // Two red pins plus the resident's blue location dot.
  assert.equal(types.filter((type) => type === "simple-marker").length, 3);
  assert.equal(state.status.textContent, "Showing 2 numbered results from Walnut's answer.");
  assert.equal(state.goTo.length, 1);
});

test("park-level results are pinned at their park, without a location dot", async () => {
  const { FriscoMap, state } = loadMap();
  await FriscoMap.showResults([{ park: "Frisco Commons Park", latitude: null, longitude: null, distanceMiles: null }], DEMO);

  const pin = state.layer.graphics.find((graphic) => graphic.symbol.type === "text");
  assert.deepEqual(pin.geometry, OUTLINES["FRISCO COMMONS PARK"].centroid);
  assert.equal(state.layer.graphics.filter((graphic) => graphic.symbol.type === "simple-marker").length, 1);
});

test("parks spelled differently in the park layer are still found", async () => {
  const { FriscoMap, state } = loadMap();
  await FriscoMap.showResults([{ park: "Wrangler's Range Park", latitude: null, longitude: null }], null);

  assert.match(state.queries[0], /'WRANGER''S RANGE PARK'/);
  assert.deepEqual(numbersOnMap(state), ["1"]);
});

test("an older answer that finishes loading late does not replace a newer one", async () => {
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const { FriscoMap, state } = loadMap({
    queryDelay: (where) => (where.includes("GALLEGOS") ? firstHeld : null),
  });

  const first = FriscoMap.showResults([{ park: "Gallegos Park", latitude: 33.149, longitude: -96.828 }], null);
  const second = FriscoMap.showResults([
    { park: "Frisco Commons Park", latitude: 33.12, longitude: -96.81 },
    { park: "Frisco Commons Park", latitude: 33.121, longitude: -96.811 },
  ], null);
  await second;
  releaseFirst();
  await first;

  assert.deepEqual(numbersOnMap(state), ["1", "2"]);
  assert.equal(state.status.textContent, "Showing 2 numbered results from Walnut's answer.");
});

test("clicking a card from an older answer redraws that answer's pins", async () => {
  const { FriscoMap, state } = loadMap();
  const older = [
    { park: "Gallegos Park", latitude: 33.149, longitude: -96.828 },
    { park: "Frisco Commons Park", latitude: null, longitude: null },
  ];
  await FriscoMap.showResults(older, null);
  await FriscoMap.showResults([{ park: "Wrangler's Range Park", latitude: null, longitude: null }], null);
  state.goTo = [];

  await FriscoMap.focusResult(older[1], older, null);

  assert.deepEqual(numbersOnMap(state), ["1", "2"]);
  // Redrawing doesn't zoom to fit; only the clicked park's outline is targeted.
  assert.equal(state.goTo.length, 1);
  // (Compared as JSON because the array was created inside the sandbox.)
  assert.equal(JSON.stringify(state.goTo[0]), JSON.stringify([OUTLINES["FRISCO COMMONS PARK"]]));
});

test("a single point is shown at street level", async () => {
  const { FriscoMap, state } = loadMap();
  const result = { park: "Gallegos Park", latitude: 33.149, longitude: -96.828 };
  await FriscoMap.showResults([result], null);
  state.goTo = [];

  await FriscoMap.focusResult(result, [result], null);

  assert.equal(state.goTo.length, 1);
  assert.equal(state.goTo[0].scale, 4000);
});

test("empty results clear the previous answer", async () => {
  const { FriscoMap, state } = loadMap();
  await FriscoMap.showResults([{ park: "Gallegos Park", latitude: 33.149, longitude: -96.828 }], null);
  await FriscoMap.showResults([], null);

  assert.equal(state.layer.graphics.length, 0);
  assert.equal(state.status.textContent, "No results to show on the map.");
});

test("if the map library fails, the chat is told and nothing throws", async () => {
  const { FriscoMap, state } = loadMap({ sdkFails: true });
  await FriscoMap.showResults([{ park: "Gallegos Park", latitude: 33.149, longitude: -96.828 }], null);
  await FriscoMap.focusResult({ park: "Gallegos Park" }, [], null);
  await new Promise((resolve) => setTimeout(resolve));

  assert.ok(state.bodyClasses.has("map-unavailable"));
  assert.equal(state.status.textContent, "The map is unavailable right now. The chat still works.");
});

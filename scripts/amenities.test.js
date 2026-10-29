const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { AMENITIES } = require("../lib/amenities");
const { asksForNearby, NEARBY_PATTERN } = require("../lib/search-language");
const handler = require("../api/amenities");

test("public endpoint exposes every category without GIS fields", () => {
  const response = {
    setHeader() {},
    end(body) { this.body = JSON.parse(body); },
  };
  handler({ method: "GET" }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body.amenities), Object.keys(AMENITIES));
  assert.equal(response.body.nearbyPattern, NEARBY_PATTERN);
  for (const [type, amenity] of Object.entries(AMENITIES)) {
    assert.deepEqual(response.body.amenities[type], {
      singular: amenity.singular, plural: amenity.plural, keywords: amenity.keywords,
    });
  }
  handler({ method: "POST" }, response);
  assert.equal(response.statusCode, 405);
});

test("browser and chat agree on explicit nearby wording", async () => {
  const element = { addEventListener() {}, checked: true };
  const context = vm.createContext({
    document: { querySelector: () => element, querySelectorAll: () => [] },
    fetch: async () => ({
      ok: true,
      json: async () => ({ amenities: AMENITIES, nearbyPattern: NEARBY_PATTERN }),
    }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../script.js"), "utf8"), context);
  await vm.runInContext("loadAmenities()", context);
  for (const phrase of ["near me", "nearby", "nearest", "closest", "around me", "close to me", "near us", "near you"]) {
    const question = `Find facilities ${phrase}`;
    assert.equal(asksForNearby(question), true);
    assert.equal(vm.runInContext(`questionNeedsLocation(${JSON.stringify(question)})`, context), true);
  }
  for (const question of ["Which parks have restrooms?", "Does Frisco Commons Park have playgrounds?"]) {
    assert.equal(asksForNearby(question), false);
    assert.equal(vm.runInContext(`questionNeedsLocation(${JSON.stringify(question)})`, context), false);
  }
  // New contributor entries must be recognized without changing browser code.
  for (const amenity of Object.values(AMENITIES)) {
    const question = `Find ${amenity.keywords[0]}`;
    assert.equal(vm.runInContext(`questionNeedsLocation(${JSON.stringify(question)})`, context), true);
  }
});

test("failed browser configuration requests can be retried", async () => {
  const element = { addEventListener() {}, checked: true };
  let attempts = 0;
  const context = vm.createContext({
    document: { querySelector: () => element, querySelectorAll: () => [] },
    fetch: async () => ({
      ok: ++attempts > 1,
      json: async () => ({ amenities: AMENITIES, nearbyPattern: NEARBY_PATTERN }),
    }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../script.js"), "utf8"), context);
  await assert.rejects(vm.runInContext("loadAmenities()", context), /Could not load/);
  await vm.runInContext("loadAmenities()", context);
  assert.equal(attempts, 2);
});

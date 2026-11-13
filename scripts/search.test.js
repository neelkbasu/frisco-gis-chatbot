const test = require("node:test");
const assert = require("node:assert/strict");
const { findNearbyFacilities } = require("../lib/frisco-gis");
const { resolveParkName } = require("../lib/park-names");

const input = { latitude: 33.15, longitude: -96.83, radiusMiles: 5 };
function point(park, offset = 0) {
  return { attributes: { Park: park }, geometry: { y: 33.15 + offset, x: -96.83 } };
}
function mockGis(t, points, park) {
  const calls = [];
  t.mock.method(global, "fetch", async (url) => {
    const query = new URL(url);
    calls.push(query);
    return { ok: true, json: async () => ({
      features: query.pathname.includes("ParkAmenities_Test")
        ? points : park ? [{ attributes: park }] : [],
    }) };
  });
  return calls;
}

for (const [type, field] of [["racquetball", "Racquetball"], ["swimming", "Swimming"], ["restroom", "Restrooms"]]) {
  test(`named Athletic Center ${type} uses park flags when points are missing`, async (t) => {
    mockGis(t, [], { ParkName: "Frisco Athletic Center", Address: "5828 Nancy Jane", [field]: field });
    const results = await findNearbyFacilities({ ...input, facilityType: type, searchMode: "at_park", parkName: "Frisco Athletic Center" });
    assert.equal(results.length, 1);
    assert.equal(results[0].distanceMiles, null);
    assert.equal(results[0].latitude, null);
  });
}

test("nearby art keeps the closest point per park", async (t) => {
  mockGis(t, [point("Simpson Plaza", .02), point("Simpson Plaza"), point("Simpson Plaza", .01)], { ParkName: "Simpson Plaza" });
  const results = await findNearbyFacilities({ ...input, facilityType: "public_art" });
  assert.equal(results.length, 1);
  assert.equal(results[0].distanceMiles, 0);
});

test("named-place searches retain individual points", async (t) => {
  mockGis(t, [point("Sample Park"), point("Sample Park", .01)], { ParkName: "Sample Park", Restrooms: "Restrooms" });
  const results = await findNearbyFacilities({ ...input, facilityType: "restroom", searchMode: "at_park", parkName: "Sample Park" });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.distanceMiles === null));
});

test("Shepherds Glen resolves point spelling and enriches the corrected display name", async (t) => {
  const calls = mockGis(t, [point("Shpeherds Glen Park")], { ParkName: "Shepherds Glen Park", Address: "Test address" });
  const results = await findNearbyFacilities({ ...input, facilityType: "splash_pad", searchMode: "at_park", parkName: "Shepherds Glen Park" });
  assert.ok(calls.some((url) => url.searchParams.get("where").includes("Shpeherds Glen Park")));
  assert.ok(calls.some((url) => url.searchParams.get("where") === "ParkName = 'Shepherds Glen Park'"));
  assert.equal(results[0].park, "Shepherds Glen Park");
  assert.equal(results[0].address, "Test address");
  assert.equal(resolveParkName("Wranger's Range Park").display, "Wrangler's Range Park");
});

test("negative or absent flags do not invent an amenity", async (t) => {
  mockGis(t, [], { ParkName: "Sample Park", Swimming: "No" });
  assert.deepEqual(await findNearbyFacilities({ ...input, facilityType: "swimming", searchMode: "at_park", parkName: "Sample Park" }), []);
});

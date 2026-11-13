const test = require("node:test");
const assert = require("node:assert/strict");
const { getTrailLengths, addTrailLengths, VERIFIED_LOOPS } = require("../lib/trail-lengths");
function record(length = "1.07 Mile") {
  return { attributes: { Name: "Frisco Commons Walking Loop", Length: length } };
}
test("a unique existing loop uses recorded mileage, not geometry length", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    const query = new URL(url).searchParams;
    assert.match(query.get("where"), /Connector = 'No'/);
    assert.match(query.get("where"), /LifeCycleStatus = 'Existing'/);
    return { ok: true, json: async () => ({ features: [record()] }) };
  });
  const trails = await getTrailLengths("Frisco Commons Park");
  assert.equal(trails[0].lengthMiles, 1.07);
  assert.equal((await getTrailLengths("Frisco Commons Walking Loop"))[0].lengthMiles, 1.07);
});
test("duplicate segments, missing mileage and truncated queries are never summed", async (t) => {
  let data;
  t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => data }));
  for (data of [
    { features: [record(), record()] },
    { features: [record(null)] },
    { features: [record("0.00 Mile")] },
    { features: [record("100 feet")] },
    { features: [record()], exceededTransferLimit: true },
  ]) assert.deepEqual(await getTrailLengths("Frisco Commons Park"), []);
});
test("unverified names never query or borrow another park's length", async (t) => {
  t.mock.method(global, "fetch", () => { throw new Error("Must not query"); });
  assert.deepEqual(await getTrailLengths("Frisco Commons Connector"), []);
  assert.equal(Object.keys(VERIFIED_LOOPS).length, new Set(Object.values(VERIFIED_LOOPS)).size);
});
test("optional service failure preserves search results and accessible routes get no loop mileage", async (t) => {
  t.mock.method(global, "fetch", async () => { throw new Error("Unavailable"); });
  const results = [
    { park: "Frisco Commons Park", facilityType: "trail" },
    { park: "Frisco Commons Park", facilityType: "accessible_trail" },
  ];
  assert.deepEqual(await addTrailLengths(results), results);
});

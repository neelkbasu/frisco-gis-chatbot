const TRAIL_LAYER_URL = "https://maps.friscotexas.gov/gis/rest/services/Public/FriscoCommunityMaps/MapServer/10";
// Name matches checked against the City's park and walking-loop records.
// These identify individual loops, never a total for every path in a park.
const VERIFIED_LOOPS = {
  "Oakbrook Park": "Oakbrook Park Walking Loop",
  "Bobwhite Park": "Bobwhite Park Walking Loop",
  "B.F. Phillips Community Park": "B.F. Phillips Community Park Walking Loop",
  "Stephen's Green Park": "Stephen's Green Park Walking Loop",
  "Mourning Dove Park": "Mourning Dove Park Walking Loop",
  "Coyote Crossing Park": "Coyote Crossing Park Walking Loop",
  "Warren Sports Complex": "Warren Sports Complex Walking Loop",
  "Frisco Commons Park": "Frisco Commons Walking Loop",
  "Fairways Green Park": "Fairways Green Park Walking Loop",
  "Falcons Field Park": "Falcons Field Walking Loop",
  "Crescent Park": "Crescent Park Walking Loop",
  "Foncine Settlement Park": "Foncine Settlement Park Walking Loop",
  "J.R. Newman Park": "JR Newman Park Walking Loop",
  "Shepherds Glen Park": "Shepherds Glen Park Walking Loop",
  "Gallegos Park": "Gallegos Park Walking Loop",
  "J.C. Grant Park": "J.C. Grant Park Walking Loop",
  "Ballpark Plaza": "Ballpark Plaza Walking Loop",
  "Old Orchard Park": "Old Orchard Park Walking Loop",
  "Beavers Bend Park": "Beaver's Bend Park Walking Loop",
  "Limestone Quarry Park": "Limestone Quarry Park Walking Loop",
  "Duncan Park": "Duncan Park Walking Loop",
  "Preston North Park": "Preston North Park Walking Loop",
  "Boulder Draw Park": "Boulder Draw Park Walking Loop",
  "Miramonte Park": "Miramonte Park Walking Loop",
  "Hummingbird Park": "Hummingbird Park Walking Loop",
  "Plum Creek Park": "Plum Creek Park Walking Loop",
  "Northeast Community Park": "Northeast Community Park Walking Loop",
  "Boyd Park": "Boyd Park Walking Loop",
  "Harold Bacchus Community Park": "Harold Bacchus Community Park Walking Loop",
  "Monarch View Park": "Monarch View Park Walking Loop"
};

async function getTrailLengths(placeName) {
  const key = String(placeName || "").trim().toLowerCase();
  const entry = Object.entries(VERIFIED_LOOPS).find(([park, trail]) =>
    park.toLowerCase() === key || trail.toLowerCase() === key
  );
  if (!entry) return [];
  const [park, name] = entry;
  const query = new URLSearchParams({
    where: `Name = '${name.replaceAll("'", "''")}' AND LifeCycleStatus = 'Existing' AND WalkingLoop = 'Yes' AND Connector = 'No'`,
    outFields: "OBJECTID,Name,Length", returnGeometry: "false", f: "json",
  });
  const response = await fetch(`${TRAIL_LAYER_URL}/query?${query}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Trail length service is unavailable.");
  const data = await response.json();
  if (data.error) throw new Error("Trail length query failed.");
  // Multiple records are ambiguous even if their recorded lengths agree.
  if (data.exceededTransferLimit || data.features?.length !== 1) return [];
  const record = data.features[0].attributes;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s+miles?$/i.exec(String(record?.Length || "").trim());
  if (!match || Number(match[1]) <= 0 || record.Name?.trim() !== name) return [];
  return [{ park, name, lengthMiles: Number(match[1]), sourceUrl: TRAIL_LAYER_URL }];
}

async function addTrailLengths(results) {
  return Promise.all(results.map(async (result) => {
    // A walking loop does not establish accessible-trail or biking mileage.
    if (result.facilityType !== "trail") return result;
    try {
      const trailLengths = await getTrailLengths(result.park);
      return trailLengths.length ? { ...result, trailLengths } : result;
    } catch {
      // Optional length information must not prevent an amenity search.
      return result;
    }
  }));
}

module.exports = { getTrailLengths, addTrailLengths, VERIFIED_LOOPS, TRAIL_LAYER_URL };

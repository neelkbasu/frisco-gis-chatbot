const { findNearbyFacilities } = require("../lib/frisco-gis");

const latitude = Number(process.argv[2]);
const longitude = Number(process.argv[3]);
const radiusMiles = Number(process.argv[4] || 5);

if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
  console.error(
    "Usage: npm run test:gis -- <latitude> <longitude> [radiusMiles]"
  );
  process.exitCode = 1;
} else {
  runTests();
}

async function runTests() {
  try {
    for (const facilityType of ["basketball", "playground"]) {
      const results = await findNearbyFacilities({
        latitude,
        longitude,
        facilityType,
        radiusMiles,
      });

      console.log(`\n${facilityType.toUpperCase()} RESULTS`);
      console.dir(results, { depth: null });
    }
  } catch (error) {
    console.error(`\nGIS test failed: ${error.message}`);
    process.exitCode = 1;
  }
}

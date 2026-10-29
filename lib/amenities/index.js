// Explicit imports keep contributor files discoverable by serverless bundlers.
const groups = [
  require("./existing"),
  require("./neel"),
  require("./camilly"),
  require("./rosa"),
  require("./agnes"),
  require("./research"),
];

const AMENITIES = {};
for (const group of groups) {
  for (const [type, amenity] of Object.entries(group)) {
    if (!/^[a-z][a-z0-9_]*$/.test(type) || Object.hasOwn(AMENITIES, type)) {
      throw new Error(`Invalid or duplicate amenity key: ${type}`);
    }
    for (const field of ["gisValue", "parkField", "singular", "plural"]) {
      if (typeof amenity[field] !== "string" || !amenity[field].trim()) {
        throw new Error(`${type} requires ${field}.`);
      }
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(amenity.parkField) ||
        amenity.gisValue.includes("'") ||
        !Array.isArray(amenity.keywords) || !amenity.keywords.length ||
        amenity.keywords.some((word) => typeof word !== "string" || !word.trim())) {
      throw new Error(`Invalid GIS mapping or keywords for ${type}.`);
    }
    AMENITIES[type] = amenity;
  }
}

const AMENITY_NAMES = Object.fromEntries(
  Object.entries(AMENITIES).map(([type, amenity]) => [type, amenity.gisValue])
);
const PARK_AMENITY_FIELDS = Object.fromEntries(
  Object.entries(AMENITIES).map(([type, amenity]) => [type, amenity.parkField])
);

module.exports = { AMENITIES, AMENITY_NAMES, PARK_AMENITY_FIELDS };

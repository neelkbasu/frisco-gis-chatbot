const { NEARBY_PATTERN } = require("../lib/search-language");
const { AMENITIES } = require("../lib/amenities");
const { PARK_NAME_SPELLINGS } = require("../lib/park-names");

// Only presentation labels and recognition keywords are needed by the browser.
const amenities = Object.fromEntries(Object.entries(AMENITIES).map(([type, amenity]) => [
  type, { singular: amenity.singular, plural: amenity.plural, keywords: amenity.keywords },
]));

// The map looks up park outlines by the park layer's own spelling, which
// differs from the displayed name for a few parks (see park-names.js).
const parkNameSpellings = PARK_NAME_SPELLINGS.map(({ display, park, point }) => ({ display, park, point }));

// Friendly names for the City's amenity values (e.g. "Restrooms" -> "restroom"),
// used by the map's hover tooltips.
const amenityLabels = Object.fromEntries(
  Object.values(AMENITIES).map((amenity) => [amenity.gisValue, amenity.singular])
);

module.exports = function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "Use GET for this endpoint." }));
    return;
  }
  response.statusCode = 200;
  response.end(JSON.stringify({ amenities, nearbyPattern: NEARBY_PATTERN, parkNameSpellings, amenityLabels }));
};

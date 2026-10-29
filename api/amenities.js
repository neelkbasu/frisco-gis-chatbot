const { NEARBY_PATTERN } = require("../lib/search-language");
const { AMENITIES } = require("../lib/amenities");

// Only presentation labels and recognition keywords are needed by the browser.
const amenities = Object.fromEntries(Object.entries(AMENITIES).map(([type, amenity]) => [
  type, { singular: amenity.singular, plural: amenity.plural, keywords: amenity.keywords },
]));

module.exports = function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "Use GET for this endpoint." }));
    return;
  }
  response.statusCode = 200;
  response.end(JSON.stringify({ amenities, nearbyPattern: NEARBY_PATTERN }));
};

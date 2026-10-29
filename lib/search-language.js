// Shared by chat routing and the browser through /api/amenities.
const NEARBY_PATTERN = String.raw`\b(near me|nearby|nearest|closest|around me|close to me|near us|near you)\b`;

function asksForNearby(message) {
  return new RegExp(NEARBY_PATTERN, "i").test(message);
}

module.exports = { NEARBY_PATTERN, asksForNearby };

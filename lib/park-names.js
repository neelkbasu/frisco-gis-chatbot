// Explicit source-layer spellings; never fuzzy-match similarly named parks.
const names = [
  { display: "Wrangler's Range Park", park: "Wranger's Range Park", point: "Wrangler's Range Park" },
  { display: "Shepherds Glen Park", park: "Shepherds Glen Park", point: "Shpeherds Glen Park" },
];

function resolveParkName(value) {
  const trimmed = String(value || "").trim();
  return names.find((entry) =>
    Object.values(entry).some((name) => name.toLowerCase() === trimmed.toLowerCase())
  ) || { display: trimmed, park: trimmed, point: trimmed };
}

module.exports = { resolveParkName, PARK_NAME_SPELLINGS: names };

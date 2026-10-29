# Ask Walnut

A Frisco parks assistant: browser → chat API (Gemini) → MCP tool → ArcGIS.

## Adding amenities

Each contributor edits only their assigned file under `lib/amenities/`:

| Contributor | File |
| --- | --- |
| Neel | `neel.js` |
| Camilly | `camilly.js` |
| Rosa | `rosa.js` |
| Agnes | `agnes.js` |
| Research | `research.js` |

Assignments are listed at the top of each file. The existing six categories live
in `existing.js`. Contributor files start empty; the refactor adds no categories.

Example for Rosa's file:

```js
module.exports = {
  pickleball: {
    gisValue: "Pickleball",
    parkField: "Pickleball",
    singular: "pickleball court",
    plural: "pickleball courts",
    keywords: ["pickleball"],
  },
};
```

Use a unique lowercase key with underscores. Verify the exact point-layer
`Amenity` value and park-layer field name. Add common user wording to
`keywords`; these feed Gemini instructions and browser location detection.

The registry automatically supplies GIS mappings, selected park fields, MCP
types, chat labels, and browser labels/keywords through `GET /api/amenities`.
No edits to those shared files are needed for ordinary category additions.

Horseshoe Pit requires separate work: its park field exists but no matching
point category was found during the API review. Do not add a normal definition
until its point-data availability or alternative search behavior is resolved.

## Run locally

Install Node.js and dependencies with `npm install`. Create `.env.local`:

```text
GEMINI_API_KEY=your-key
```

Run `npm run dev:api` and open http://127.0.0.1:3000.
The local server serves the frontend and all three API endpoints.
For MCP-only development, run `npm run dev:mcp`.

## Verify an addition

Run `npm test` for offline registry, endpoint, and browser location regression checks.
These checks do not call Gemini or ArcGIS. Nearby wording is shared in
`lib/search-language.js` and delivered to the browser through `/api/amenities`.

- Nearby: “Find pickleball courts near me.”
- Citywide: “Which parks have pickleball?”
- Named park: “Is there pickleball at Frisco Commons Park?”
- Try Demo Mode and actual browser location separately.
- Direct MCP check: `npm run test:mcp -- 33.1507 -96.8236 5 pickleball`.
- The GIS smoke script currently checks basketball and playground only:
  `npm run test:gis -- 33.1507 -96.8236 5`.

An empty result does not establish that a facility is absent. Searches return
at most five results, and nearby distances are straight-line distances.

## Vercel

Keep the existing API layout and environment variables:
`GEMINI_API_KEY` and `MCP_SERVER_URL` (the deployed /api/mcp URL).
The new `api/amenities.js` is a Node function using explicit local imports,
just like the other handlers. It needs no additional environment variable.
Test on a preview deployment before merging; deployment is not part of this
refactor.

# Ask Walnut

Ask Walnut helps people find parks, recreation facilities, and amenities in
Frisco, Texas. Ask a question in plain English and get results from City of
Frisco GIS, including addresses, park websites, and nearby distances.

## What you can ask

- “Find basketball courts near me.”
- “Which parks have splash pads?”
- “Does Frisco Athletic Center have swimming?”
- “Are there restrooms at Frisco Commons Park?”

Gemini interprets the question. An MCP search tool queries two ArcGIS layers:
amenity points provide facility locations, and ParkApp provides park details
and recorded amenity flags.

Nearby recommendations show up to five distinct parks, using the nearest
recorded amenity point in each. Named-place searches can show individual points;
if no points are mapped, a positive ParkApp flag can still establish recorded
presence. Missing records do not prove an amenity is absent.

Distances are straight-line distances, not travel distances. The app does not
provide live opening hours, closures, availability, reservations, directions,
or trail mileage. A general park-details tool has not been added.

## Run locally

Install Node.js, then run:

```bash
npm install
```

Create `.env.local` in the project root:

```env
GEMINI_API_KEY=your-key
```

Start the app:

```bash
npm run dev:api
```

Open http://127.0.0.1:3000. Demo Mode uses a sample Frisco location.
Turn it off to use your browser's location. Restart the server after editing
server code or environment variables.

Each contributor needs their own local configuration. Never commit API keys;
`.env.local` and `node_modules/` are ignored by Git.

## Project files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css`, `script.js` | Chat interface, location handling, and result cards |
| `api/chat.js` | Gemini routing and replies |
| `api/mcp.js` | Validated MCP search tool |
| `api/amenities.js` | Browser labels and keywords |
| `lib/frisco-gis.js` | ArcGIS searches, distances, and park details |
| `lib/park-names.js` | Known spelling differences between GIS layers |
| `lib/amenities/` | Shared amenity definitions, split by contributor |

## Add an amenity

Edit your assigned file: `neel.js`, `camilly.js`, `rosa.js`, `agnes.js`,
or `research.js` under `lib/amenities/`. Follow this format:

```js
pickleball: {
  gisValue: "Pickleball",
  parkField: "Pickleball",
  singular: "pickleball court",
  plural: "pickleball courts",
  keywords: ["pickleball"],
},
```

Verify the exact GIS category and ParkApp field names. The registry updates
search mappings, MCP types, Gemini instructions, and browser labels automatically.
New categories without mapped points need special consideration for nearby searches.

## Test and deploy

Run `npm test` for offline regression tests. Before merging, also try nearby,
citywide, and named-place questions locally and in a Vercel preview.

For a live MCP smoke check:

```bash
npm run test:mcp -- 33.1507 -96.8236 5 basketball
```

On Vercel, configure `GEMINI_API_KEY` and `MCP_SERVER_URL` (your deployment's
`/api/mcp` URL). Local development resolves the MCP URL automatically.

# Ask Walnut

Ask Walnut helps people find parks, recreation facilities, and amenities in
Frisco, Texas. Ask a question in plain English and get results from City of
Frisco GIS, including addresses, park websites, and nearby distances.

## What you can ask

- “Find basketball courts near me.”
- “Which parks have splash pads?”
- “How long is Frisco Commons Walking Loop?”
- “Does Frisco Athletic Center have swimming?”
- “Are there restrooms at Frisco Commons Park?”

Gemini understands your question and searches City of Frisco GIS data.
Results include up to five parks. Distances are straight-line distances.
Missing information does not necessarily mean an amenity is absent.

The app does not provide current hours, closures, reservations, directions,
or complete route planning. Recorded walking-loop lengths are available only
for verified park matches. Trail cards show loop length separately from distance
from you. Missing, ambiguous, and segment-only lengths are left out; segments
are never added together.

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

Each computer needs its own local configuration. Never commit API keys;
`.env.local` and `node_modules/` are ignored by Git.

## Test

Run the automated checks:

```bash
npm test
```

These tests check the code using sample data. They do not need an API key.

For a full check, start the app and try the example questions above:

- Keep Demo Mode on to test with the sample Frisco location.
- Turn it off and allow location access to test nearby searches from your location.
- Check that cards show park names, available addresses, and website links.
- Nearby results should show distances and each park once.
- Named-place and citywide results should not show distances.

Repeat these checks on a Vercel preview before deploying changes.

## Vercel

On Vercel, configure `GEMINI_API_KEY` and `MCP_SERVER_URL` (your deployment's
`/api/mcp` URL). Local development resolves the MCP URL automatically.

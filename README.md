# Ask Walnut

A Frisco parks assistant with a browser frontend, a Gemini-powered chat API,
and an MCP tool backed by City of Frisco GIS.

## Run locally

Run these commands from the project folder:

```sh
npm ci
cp .env.example .env.local
```

Edit `.env.local` and replace `your_gemini_api_key` with your Gemini API key.
Then start the full application:

```sh
npm run dev:api
```

Open **http://127.0.0.1:3000**. This server serves the page, `/api/chat`, and
`/api/mcp` together. If you set `PORT` in `.env.local`, use that port instead.
Restart the server after changing `.env.local` or backend code.

VS Code Live Server (usually port 5500 or 5501) only serves static files. It
cannot run the chat API. Opening the page there makes `/api/chat` fail, often
with an empty HTTP 405 response. Use the address printed by `dev:api` for chat.
`npm run dev:mcp` runs only the MCP endpoint; it does not serve the chat page.

Demo Mode starts enabled and uses a sample Frisco location. Turn it off to use
browser geolocation for nearby searches.

## Verify amenities

```sh
npm run test:amenities
npm run test:mcp -- 33.1507 -96.8236 5 fishing nearby
```

The automated suite uses service fixtures. The MCP command queries live GIS
and does not require a Gemini key.

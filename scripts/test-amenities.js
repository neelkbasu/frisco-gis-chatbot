const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const mcpHandler = require("../api/mcp");
const chatHandler = require("../api/chat");

// Fixed service fixtures keep these checks independent of live GIS and Gemini.
const amenities = [
  ["disc_golf", "Disc Golf", "DiscGolf", "disc golf location"],
  ["dog_park", "Dog Park", "DogPark", "dog park"],
  ["fishing", "Fishing", "Fishing", "fishing location"],
  ["fitness_equipment", "Fitness Equipment", "FitnessEquipment", "fitness equipment location"],
  ["football", "Football", "Football", "football field"],
  ["horseshoe_pit", "Horseshoe Pit", "HorseshoePit", "horseshoe pit"],
];
const location = { latitude: 33.1507, longitude: -96.8236, radiusMiles: 5 };
const park = { ParkName: "Example Park", Address: "123 Example Street" };

test("new amenities through MCP and chat", async function (t) {
  const realFetch = global.fetch;
  let queries = [];
  let routedArgs;
  let emptyResults = false;
  t.mock.method(global, "fetch", async function (input, options) {
    const url = new URL(typeof input === "string" ? input : input.url || input);
    if (url.hostname === "services6.arcgis.com") {
      queries.push(url);
      const pointLayer = url.pathname.includes("ParkAmenities_Test");
      return Response.json({ features: emptyResults ? [] : pointLayer
        ? [{ attributes: { Park: park.ParkName }, geometry: { x: location.longitude, y: location.latitude } }]
        : [{ attributes: park }, { attributes: { ParkName: "Select a Park for More Info" } }] });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      const body = JSON.parse(options?.body || await input.clone().text());
      // Every new type must be exposed to Gemini as well as MCP clients.
      const declaration = body.tools[0].functionDeclarations.find(tool => tool.name === "find_nearby_facilities");
      for (const [type] of amenities) {
        assert.ok(declaration.parametersJsonSchema.properties.facilityType.enum.includes(type));
        assert.ok(JSON.stringify(body.systemInstruction).includes(type));
      }
      return Response.json({ candidates: [{ content: { role: "model", parts: [{
        functionCall: { name: "find_nearby_facilities", args: routedArgs },
      }] }, finishReason: "STOP" }] });
    }
    assert.equal(url.hostname, "127.0.0.1", "tests must not call external services");
    return realFetch(input, options);
  });

  const server = http.createServer((request, response) => {
    const handler = request.url.startsWith("/api/chat") ? chatHandler : mcpHandler;
    Promise.resolve(handler(request, response)).catch(error => {
      response.statusCode = 500;
      response.end(error.message);
    });
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousMcpUrl = process.env.MCP_SERVER_URL;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.MCP_SERVER_URL = `${endpoint}/api/mcp`;
  t.after(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = previousMcpUrl;
  });
  const client = new Client({ name: "amenity-regression-test", version: "1.0.0" }, {
    versionNegotiation: { mode: "auto" },
  });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/api/mcp`)));

  await t.test("MCP discovery advertises all six amenity types", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(tool => tool.name === "find_nearby_facilities");
    for (const [type] of amenities) assert.ok(tool.inputSchema.properties.facilityType.enum.includes(type));
    assert.match(tool.description, /without a radius filter or distances/);
  });

  for (const [type, name, field, replyLabel] of amenities) {
    for (const searchMode of ["nearby", "parks", "at_park"]) {
      await t.test(`${type}: ${searchMode} queries the correct GIS records`, async () => {
        queries = [];
        const args = { ...location, facilityType: type, searchMode,
          ...(searchMode === "at_park" ? { parkName: "Example Park" } : {}) };
        const result = await client.callTool({ name: "find_nearby_facilities", arguments: args });
        assert.ok(!result.isError, JSON.stringify(result));
        const { results, note } = result.structuredContent;
        assert.equal(results.length, 1);
        assert.equal(results[0].facilityType, type);
        assert.equal(results[0].address, park.Address);
        const query = queries[0].searchParams;
        const usesParkRecords = searchMode === "parks" || type === "horseshoe_pit";
        if (usesParkRecords) {
          assert.ok(queries[0].pathname.includes("ParkApp_Testing"));
          assert.ok(query.get("where").startsWith(`${field} IS NOT NULL`));
          assert.ok(query.get("outFields").split(",").includes(field));
          assert.equal(results[0].latitude, null);
          assert.equal(results[0].longitude, null);
        } else {
          assert.ok(queries[0].pathname.includes("ParkAmenities_Test"));
          assert.ok(query.get("where").startsWith(`Amenity = '${name}'`));
          assert.equal(query.has("geometry"), searchMode === "nearby");
          if (searchMode === "nearby") {
            assert.equal(query.get("geometry"), `${location.longitude},${location.latitude}`);
            assert.equal(query.get("distance"), "5");
          }
        }
        if (searchMode === "at_park") assert.ok(query.get("where").includes(" = 'Example Park'"));
        assert.equal(results[0].distanceMiles, searchMode === "nearby" && !usesParkRecords ? 0 : null);
        if (type === "horseshoe_pit") assert.match(note, /radius filtering and distances are unavailable/);
        else assert.equal(note, undefined);
      });
    }

    await t.test(`${type}: chat renders GIS results and the correct distance message`, async () => {
      routedArgs = { ...location, latitude: 0, longitude: 0, facilityType: type, searchMode: "parks" };
      queries = [];
      const response = await realFetch(`${endpoint}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...location, message: type === "fishing" ? "Where's the nearest fishing area?" : `Find ${name} near me` }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.results[0].facilityType, type);
      assert.ok(!body.reply.includes("undefined"));
      if (type === "horseshoe_pit") {
        assert.match(body.reply, /not filtered by distance/);
        assert.match(body.reply, /Exact horseshoe pit locations are not recorded/);
        assert.equal(body.distanceNote, null);
        assert.ok(!body.reply.includes("closest"));
      } else {
        assert.ok(body.reply.includes(replyLabel));
        assert.equal(body.distanceNote, "Straight-line distances");
        assert.equal(queries[0].searchParams.get("geometry"), `${location.longitude},${location.latitude}`);
      }
    });
  }

  await t.test("empty horseshoe results retain the location limitation", async () => {
    emptyResults = true;
    const result = await client.callTool({ name: "find_nearby_facilities",
      arguments: { ...location, facilityType: "horseshoe_pit" } });
    assert.deepEqual(result.structuredContent.results, []);
    assert.match(result.structuredContent.note, /distances are unavailable/);
    emptyResults = false;
  });

  await t.test("named horseshoe searches require and safely escape the park name", async () => {
    queries = [];
    const missingName = await client.callTool({ name: "find_nearby_facilities",
      arguments: { ...location, facilityType: "horseshoe_pit", searchMode: "at_park" } });
    assert.equal(missingName.isError, true);
    assert.equal(queries.length, 0);
    await client.callTool({ name: "find_nearby_facilities", arguments: {
      ...location, facilityType: "horseshoe_pit", searchMode: "at_park", parkName: "O'Brien Park",
    } });
    assert.ok(queries[0].searchParams.get("where").includes("ParkName = 'O''Brien Park'"));
  });
});

test("browser collects locations and displays readable labels for the new amenities", () => {
  function element() {
    return { children: [], addEventListener() {}, appendChild(child) { this.children.push(child); } };
  }
  const context = vm.createContext({ document: {
    querySelector: element, querySelectorAll: () => [], createElement: element,
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../script.js"), "utf8"), context);
  for (const [type, name] of amenities) {
    for (const question of [`Find ${name}`, `Where are the ${name} locations?`, `Nearest ${name}`]) {
      assert.equal(context.questionNeedsLocation(question), true, question);
    }
    assert.equal(context.questionNeedsLocation(`Which parks have ${name}?`), false);
    const message = element();
    context.addResultCards(message, [{ facilityType: type, distanceMiles: null }]);
    const details = message.children[0].children[0].children[1].textContent;
    assert.ok(details.toLowerCase().includes(`type: ${name.toLowerCase()}`), details);
    assert.ok(!details.includes("Distance:"));
  }
  for (const question of ["Where's the nearest fishing area?", "Where can I fish?", "Where can I play frisbee golf?", "Find off-leash dog areas", "Where can I play horseshoes?"]) {
    assert.equal(context.questionNeedsLocation(question), true, question);
  }
});

test("chat response errors explain static previews and preserve API messages", async function (t) {
  function browserContext(response, hostname = "127.0.0.1") {
    const context = vm.createContext({
      window: { location: { hostname } },
      document: { querySelector: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
      fetch: async () => response,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../script.js"), "utf8"), context);
    return context;
  }

  const cases = [
    ["empty 405 from a static server", new Response(null, { status: 405 }), /npm run dev:api/],
    ["HTML 404 from a static server", new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } }), /http:\/\/127\.0\.0\.1:3000/],
    ["HTML fallback page", new Response("<!DOCTYPE html><title>Preview</title>", { headers: { "content-type": "text/html" } }), /chat API is not running/],
    ["gateway timeout", new Response("Gateway timeout", { status: 504 }), /temporarily unavailable or timed out/],
    ["HTML gateway timeout", new Response("<h1>Gateway timeout</h1>", { status: 504, headers: { "content-type": "text/html" } }), /temporarily unavailable or timed out/],
    ["malformed JSON", new Response("{", { headers: { "content-type": "application/json" } }), /invalid response \(HTTP 200\)/],
    ["null JSON", Response.json(null), /unexpected response/],
    ["API configuration error", Response.json({ error: "The assistant is not configured yet." }, { status: 500 }), /not configured yet/],
  ];
  for (const [name, response, expected] of cases) {
    await t.test(name, async () => {
      const context = browserContext(response);
      await assert.rejects(context.askChatApi("Where's the nearest fishing area?", location), expected);
    });
  }
  await t.test("hosted failures omit local development instructions", async () => {
    const context = browserContext(new Response(null, { status: 405 }), "parks.example");
    await assert.rejects(context.askChatApi("Find fishing", location), /unavailable at this address/);
  });
  await t.test("valid fishing results pass through unchanged", async () => {
    const expected = { reply: "Warren Sports Complex is the closest fishing location.", results: [{ facilityType: "fishing" }] };
    const context = browserContext(Response.json(expected));
    assert.deepEqual(await context.askChatApi("Where's the nearest fishing area?", location), expected);
  });
});

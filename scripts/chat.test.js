const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const path = require("node:path");
const localRequire = createRequire(path.join(__dirname, "../api/chat.js"));

async function chat(facilityType, searchMode, parkName, results) {
  let instructions;
  const context = vm.createContext({
    module: { exports: {} }, process: { env: { GEMINI_API_KEY: "test" } },
    URL, console, setTimeout,
    require(name) {
      if (name === "@google/genai") return { GoogleGenAI: class {
        models = { generateContent: async (request) => {
          instructions = request.config.systemInstruction;
          return { functionCalls: [{ name: "find_nearby_facilities", args: {
            facilityType, searchMode, parkName, radiusMiles: 5,
          } }] };
        } };
      } };
      if (name === "@modelcontextprotocol/client") return {
        Client: class {
          async connect() {}
          async close() {}
          async callTool() { return { structuredContent: { results } }; }
        },
        StreamableHTTPClientTransport: class {},
      };
      return localRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../api/chat.js"), "utf8"), context);
  const response = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await context.module.exports({
    method: "POST", headers: { host: "localhost:3000" },
    body: { message: "Does this named facility have the amenity?", latitude: 33.15, longitude: -96.83 },
  }, response);
  assert.equal(response.statusCode, 200);
  return { ...response.body, instructions };
}

test("citywide and named-place replies use plural registry labels", async () => {
  const citywide = await chat("splash_pad", "parks", undefined, [{ park: "Sample Park" }]);
  assert.match(citywide.reply, /with splash pads/);
  assert.match(citywide.reply, /up to five/);
  const named = await chat("skate_park", "at_park", "Sample Park", [{ park: "Sample Park" }]);
  assert.match(named.reply, /list skate parks at Sample Park/);
});

test("routing instructions explicitly support Athletic Center amenity questions", async () => {
  const reply = await chat("swimming", "at_park", "Frisco Athletic Center", [{ park: "Frisco Athletic Center" }]);
  assert.match(reply.instructions, /athletic centers and sports complexes/);
  assert.match(reply.instructions, /parkName Frisco Athletic Center/);
  assert.match(reply.reply, /swimming facilities at Frisco Athletic Center/);
});

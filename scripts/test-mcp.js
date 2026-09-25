const http = require("node:http");
const mcpHandler = require("../api/mcp");

const latitude = Number(process.argv[2]);
const longitude = Number(process.argv[3]);
const radiusMiles = Number(process.argv[4] || 5);
const facilityType = process.argv[5] || "basketball";

if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
  console.error(
    "Usage: npm run test:mcp -- <latitude> <longitude> [radiusMiles] [basketball|playground]"
  );
  process.exitCode = 1;
} else {
  runTest();
}

async function runTest() {
  const server = http.createServer(mcpHandler);

  try {
    await new Promise(function (resolve, reject) {
      function handleListenError(error) {
        reject(error);
      }

      server.once("error", handleListenError);
      server.listen(0, "127.0.0.1", function () {
        server.off("error", handleListenError);
        resolve();
      });
    });

    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}`;

    // Initialize a standard stateless MCP connection.
    await sendMcpRequest(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "frisco-mcp-test", version: "1.0.0" },
      },
    });

    // Call the real tool through the HTTP endpoint, not the GIS module directly.
    const toolResponse = await sendMcpRequest(endpoint, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "find_nearby_facilities",
        arguments: { latitude, longitude, facilityType, radiusMiles },
      },
    });

    if (toolResponse.error) {
      throw new Error(toolResponse.error.message);
    }

    if (toolResponse.result?.isError) {
      const errorText = toolResponse.result.content?.[0]?.text;
      throw new Error(errorText || "The MCP tool returned an error.");
    }

    if (!toolResponse.result?.structuredContent) {
      throw new Error("The MCP tool did not return structured results.");
    }

    console.dir(toolResponse.result.structuredContent, { depth: null });
  } catch (error) {
    console.error(`MCP test failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

async function sendMcpRequest(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText}`);
  }

  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = responseText
      .split("\n")
      .find(function (line) {
        return line.startsWith("data: ");
      });

    if (!dataLine) {
      throw new Error("The MCP endpoint returned an empty event stream.");
    }

    return JSON.parse(dataLine.slice(6));
  }

  return JSON.parse(responseText);
}

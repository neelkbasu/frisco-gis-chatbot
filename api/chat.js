const { GoogleGenAI } = require("@google/genai");
const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");

const MODEL_NAME = "gemini-3.5-flash-lite";
const DEFAULT_RADIUS_MILES = 5;
const SUPPORTED_FACILITY_TYPES = ["basketball", "playground"];
const UNSUPPORTED_REPLY =
  "Right now I can help you find basketball courts and playgrounds in Frisco.";

const facilityTool = {
  name: "find_nearby_facilities",
  description:
    "Find nearby basketball courts or playgrounds using official City of Frisco GIS data. Call this only for those two facility types.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      latitude: {
        type: "number",
        description: "The user's latitude.",
        minimum: -90,
        maximum: 90,
      },
      longitude: {
        type: "number",
        description: "The user's longitude.",
        minimum: -180,
        maximum: 180,
      },
      facilityType: {
        type: "string",
        enum: SUPPORTED_FACILITY_TYPES,
      },
      radiusMiles: {
        type: "number",
        description:
          "Search radius in miles. Use 5 unless the resident requests another radius.",
        exclusiveMinimum: 0,
      },
    },
    required: ["latitude", "longitude", "facilityType", "radiusMiles"],
  },
};

// Retry temporary Gemini failures. The first request is immediate, then
// retries wait about 1, 2, and 4 seconds (exponential backoff).
async function callGeminiWithRetry(ai, request) {
  const retryableStatuses = [429, 500, 503, 504];
  const retryDelays = [1000, 2000, 4000];

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      const status = Number(error.status || error.statusCode || error.response?.status);
      const canRetry = retryableStatuses.includes(status);

      // Client/authentication errors (400, 401, 403) and other errors stop
      // immediately because retrying will not fix the request.
      if (!canRetry || attempt === retryDelays.length) {
        if (canRetry) {
          error.code = "TEMPORARY_GEMINI_FAILURE";
        }
        console.error("Gemini API error:", error);
        throw error;
      }

      console.error(`Gemini temporary error (HTTP ${status}); retrying:`, error);
      await new Promise(function (resolve) {
        setTimeout(resolve, retryDelays[attempt]);
      });
    }
  }
}

// Gemini interprets the resident's wording, but it does not create GIS facts.
async function understandRequest(message, latitude, longitude) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await callGeminiWithRetry(ai, {
    model: MODEL_NAME,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Resident message: ${JSON.stringify(message)}\n` +
              `Validated latitude: ${latitude}\n` +
              `Validated longitude: ${longitude}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction:
        "You route requests for the Frisco City Assistant. " +
        "Call find_nearby_facilities when the resident asks for basketball courts or playgrounds, including phrases such as courts nearby or somewhere for kids to play. " +
        "Treat an unqualified request for nearby courts as basketball courts. " +
        "Use the supplied validated coordinates. Use a 5-mile radius unless the resident explicitly asks for another radius. " +
        "Do not call the tool for any other topic. Never invent facility information.",
      tools: [{ functionDeclarations: [facilityTool] }],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
      temperature: 0,
      maxOutputTokens: 256,
    },
  });

  return response.functionCalls?.find(function (functionCall) {
    return functionCall.name === "find_nearby_facilities";
  });
}

// Resolve the MCP endpoint. Production uses the public URL configured in
// MCP_SERVER_URL; localhost keeps a convenient local fallback.
function getMcpUrl(request) {
  if (process.env.MCP_SERVER_URL) {
    return new URL(process.env.MCP_SERVER_URL);
  }

  const host = request.headers.host || "";
  const hostname = host.split(":")[0];

  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return new URL(`http://${host}/api/mcp`);
  }

  throw new Error("The MCP server URL is not configured.");
}

// Call the existing MCP tool so this file never duplicates ArcGIS logic.
async function callFacilityTool(mcpUrl, input) {
  const client = new Client(
    { name: "frisco-chat-api", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  const transport = new StreamableHTTPClientTransport(mcpUrl);

  try {
    await client.connect(transport);
    const toolResult = await client.callTool({
      name: "find_nearby_facilities",
      arguments: input,
    });

    if (toolResult.isError) {
      throw new Error("The Frisco GIS tool returned an error.");
    }

    const results = toolResult.structuredContent?.results;

    if (!Array.isArray(results)) {
      throw new Error("The Frisco GIS tool returned an unexpected response.");
    }

    return results;
  } finally {
    await client.close();
  }
}

// Create a concise reply using only facts already returned by City GIS.
function buildReply(results, facilityType, radiusMiles) {
  const pluralFacilityLabel =
    facilityType === "basketball" ? "basketball courts" : "playgrounds";

  if (results.length === 0) {
    return `I couldn't find any ${pluralFacilityLabel} within ${radiusMiles} miles. Source: City of Frisco GIS`;
  }

  const closest = results[0];
  const addressText = closest.address ? ` at ${closest.address}` : "";
  const facilityLabel =
    results.length === 1
      ? facilityType === "basketball"
        ? "basketball court"
        : "playground"
      : pluralFacilityLabel;

  return (
    `I found ${results.length} nearby ${facilityLabel}. ` +
    `The closest is ${closest.name}, ${closest.distanceMiles} miles away${addressText}. ` +
    "Source: City of Frisco GIS"
  );
}

function validateBody(body) {
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);

  if (!message) {
    return { error: "message is required." };
  }

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: "latitude must be a number between -90 and 90." };
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: "longitude must be a number between -180 and 180." };
  }

  return { message, latitude, longitude };
}

async function readJsonBody(request) {
  if (request.body !== undefined) {
    return typeof request.body === "string"
      ? JSON.parse(request.body)
      : request.body;
  }

  let rawBody = "";

  for await (const chunk of request) {
    rawBody += chunk;

    if (rawBody.length > 20_000) {
      throw new Error("Request body is too large.");
    }
  }

  return JSON.parse(rawBody || "{}");
}

function sendJson(response, statusCode, data) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

// Vercel runs this handler when the frontend posts to /api/chat.
module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "Use POST for this endpoint." });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 500, {
      error: "The assistant is not configured yet.",
    });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: "Send a valid JSON request body." });
    return;
  }

  const input = validateBody(body);

  if (input.error) {
    sendJson(response, 400, { error: input.error });
    return;
  }

  try {
    const functionCall = await understandRequest(
      input.message,
      input.latitude,
      input.longitude
    );

    if (!functionCall) {
      sendJson(response, 200, { reply: UNSUPPORTED_REPLY, results: [] });
      return;
    }

    const facilityType = functionCall.args?.facilityType;

    if (!SUPPORTED_FACILITY_TYPES.includes(facilityType)) {
      sendJson(response, 200, { reply: UNSUPPORTED_REPLY, results: [] });
      return;
    }

    const requestedRadius = Number(functionCall.args?.radiusMiles);
    const radiusMiles =
      Number.isFinite(requestedRadius) && requestedRadius > 0
        ? requestedRadius
        : DEFAULT_RADIUS_MILES;

    // Always use the validated request coordinates, never model-generated ones.
    const toolInput = {
      latitude: input.latitude,
      longitude: input.longitude,
      facilityType,
      radiusMiles,
    };
    const results = await callFacilityTool(getMcpUrl(request), toolInput);
    const reply = buildReply(results, facilityType, radiusMiles);

    sendJson(response, 200, { reply, results });
  } catch (error) {
    // Keep detailed errors in server logs, not in responses sent to residents.
    console.error("Frisco chat API error:", error);
    if (error.code === "TEMPORARY_GEMINI_FAILURE") {
      sendJson(response, 200, {
        reply: "The AI service is temporarily busy. Please try again in a moment.",
        results: [],
      });
      return;
    }
    sendJson(response, 502, {
      error: "The assistant could not complete that request. Please try again.",
    });
  }
};

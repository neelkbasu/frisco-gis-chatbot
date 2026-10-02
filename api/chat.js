const { GoogleGenAI } = require("@google/genai");
const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");

const MODEL_NAME = "gemini-3.5-flash-lite";
const DEFAULT_RADIUS_MILES = 5;
const { AMENITY_NAMES } = require("../lib/frisco-gis");
const SUPPORTED_FACILITY_TYPES = Object.keys(AMENITY_NAMES);
const UNSUPPORTED_REPLY =
  "That feature isn't implemented yet—Ask Walnut is a work in progress! For now, I can help you find basketball courts, playgrounds, walking trails, accessible trails, restrooms, and park parking in Frisco.";

// These responses are written here, rather than generated, so unavailable
// details never become invented GIS facts or promises of future features.
const UNAVAILABLE_REPLIES = {
  trail_length: "I can't answer trail lengths yet because this GIS data doesn't include route mileage. Ask Walnut is a work in progress, but I can help you find walking trails or accessible trails.",
  live_status: "I can't check current opening hours, closures, working facilities, or available parking spaces yet. Ask Walnut is a work in progress. Please check the official City of Frisco website for current information.",
  directions: "Walking and driving directions aren't implemented yet—Ask Walnut is a work in progress. I can show recorded facility locations and straight-line distances for nearby searches.",
  other: "I can't answer that detail with the information currently available. Ask Walnut is a work in progress! I can help you find supported park amenities instead.",
};

const facilityTool = {
  name: "find_nearby_facilities",
  description:
    "Search official Frisco GIS for supported amenities near the resident, at a named park, or parks with an amenity.",
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
      searchMode: {
        type: "string", enum: ["nearby", "parks", "at_park"],
        description: "nearby for closest/near-me searches; parks for which parks have an amenity; at_park for amenities at a named park without a distance request.",
      },
      parkName: { type: "string", description: "Park name explicitly supplied by the resident. Omit if none is supplied." },
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
        "Call find_nearby_facilities for basketball, playground, trail (walking trails), accessible_trail, restroom, or parking. Accessible trails means the recorded accessible-trail category, not a guarantee that the whole park is accessible. " +
        "Use searchMode parks for 'which parks have restrooms/parking' without nearby wording. Use nearby for nearest, closest, or nearby searches. Include parkName if the resident names their park; expand an unambiguous name such as Frisco Commons to Frisco Commons Park. Use at_park for named-park amenity questions without nearby wording. If they say 'this park' without naming it, ask which park through clarification instead of guessing. " +
        "Treat an unqualified request for nearby courts as basketball courts. " +
        "Use the supplied validated coordinates. Use a 5-mile radius unless the resident explicitly asks for another radius. " +
        "Call unavailable_information when the question requires trail length or route mileage, opening hours, live closures or operating status, parking availability or fees, reservations, directions, or other details the search tool cannot answer. Do not substitute a facility search for an unavailable detail. Use this tool for unsupported topics too. For a question mixing an amenity search with an unavailable detail, explain the limitation using unavailable_information. " +
        "Do not call the tool for any other topic. Never invent facility information or trail lengths.",
      tools: [{ functionDeclarations: [facilityTool, {
        name: "clarify_park",
        description: "Ask for the park name when the resident refers to this park or my park without naming it.",
        parametersJsonSchema: { type: "object", properties: {} },
      }, {
        name: "unavailable_information",
        description: "Explain that a requested feature or detail is not currently supported. Never invent an answer.",
        parametersJsonSchema: {
          type: "object",
          properties: { reason: { type: "string", enum: ["trail_length", "live_status", "directions", "other", "unsupported"] } },
          required: ["reason"],
        },
      }] }],
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
    return ["find_nearby_facilities", "clarify_park", "unavailable_information"].includes(functionCall.name);
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
  const pluralFacilityLabel = { basketball: "basketball courts", playground: "playgrounds", trail: "walking trails", accessible_trail: "accessible trails", restroom: "restrooms", parking: "parking locations" }[facilityType];

  if (results.length === 0) {
    return `I couldn't find any ${pluralFacilityLabel} within ${radiusMiles} miles.`;
  }

  const closest = results[0];
  const facilityLabel = results.length === 1
    ? { basketball: "basketball court", playground: "playground", trail: "walking trail", accessible_trail: "accessible trail", restroom: "restroom", parking: "parking location" }[facilityType]
    : pluralFacilityLabel;

  return (
    `I found ${results.length} nearby ${facilityLabel}. ` +
    `${closest.name || closest.park || "The first result"} is the closest, about ${closest.distanceMiles} miles away.`
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

    if (functionCall.name === "unavailable_information") {
      const reason = functionCall.args?.reason;
      sendJson(response, 200, {
        reply: reason === "unsupported" ? UNSUPPORTED_REPLY
          : UNAVAILABLE_REPLIES[reason] || UNAVAILABLE_REPLIES.other,
        results: [],
      });
      return;
    }

    if (functionCall.name === "clarify_park") {
      sendJson(response, 200, {
        reply: "Which park are you at? Please include its name in your restroom or trail question, or ask for the nearest facility using your location.",
        results: [],
      });
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
      searchMode: ["nearby", "parks", "at_park"].includes(functionCall.args?.searchMode)
        ? functionCall.args.searchMode : "nearby",
      ...(typeof functionCall.args?.parkName === "string" && functionCall.args.parkName.trim()
        ? { parkName: functionCall.args.parkName.trim() } : {}),
    };
    const results = await callFacilityTool(getMcpUrl(request), toolInput);
    const label = AMENITY_NAMES[facilityType].toLowerCase();
    const reply = toolInput.searchMode === "parks"
      ? (results.length ? `I found ${results.length} parks with ${label}.` : `No parks with ${label} were found in the GIS records.`)
      : toolInput.searchMode === "at_park"
        ? (results.length ? `The GIS records list ${label} at ${toolInput.parkName}.` : `No matching ${label} points were found for ${toolInput.parkName}; this does not confirm the amenity is absent.`)
        : buildReply(results, facilityType, radiusMiles);

    // Keep attribution separate from the conversational reply. Unavailable
    // trail mileage is explained only when asked, through the existing tool.
    sendJson(response, 200, {
      reply, results, source: "City of Frisco GIS",
      distanceNote: toolInput.searchMode === "nearby" && results.length
        ? "Straight-line distances" : null,
    });
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

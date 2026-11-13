const { GoogleGenAI } = require("@google/genai");
const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");

const MODEL_NAME = "gemini-3.5-flash-lite";
const DEFAULT_RADIUS_MILES = 5;
const { asksForNearby } = require("../lib/search-language");
const { AMENITIES, AMENITY_NAMES } = require("../lib/amenities");
const { CITY_AMENITY_CATEGORIES } = require("../lib/frisco-gis");
const supportedLabels = Object.values(AMENITIES).map((amenity) => amenity.plural).join(", ");
const routingDescriptions = Object.entries(AMENITIES).map(([type, amenity]) =>
  `${type}: ${amenity.plural} (keywords: ${amenity.keywords.join(", ")})`
).join("; ");
const SUPPORTED_FACILITY_TYPES = Object.keys(AMENITY_NAMES);
const UNSUPPORTED_REPLY =
  `That feature isn't implemented yet—Ask Walnut is a work in progress! For now, I can help you find ${supportedLabels} in Frisco.`;

// These responses are written here, rather than generated, so unavailable
// details never become invented GIS facts or promises of future features.
const UNAVAILABLE_REPLIES = {
  trail_length: "Please name the park or walking loop. I can check recorded lengths for verified walking loops; I do not combine trail segments.",
  live_status: "I can't check current opening hours, closures, working facilities, or available parking spaces yet. Ask Walnut is a work in progress. Please check the official City of Frisco website for current information.",
  directions: "Walking and driving directions aren't implemented yet—Ask Walnut is a work in progress. I can show recorded facility locations and straight-line distances for nearby searches.",
  other: "I can't answer that detail with the information currently available. Ask Walnut is a work in progress! I can help you find supported park amenities instead.",
};

const facilityTool = {
  name: "find_nearby_facilities",
  description:
    "Search official Frisco GIS for supported amenities near the resident, at a named park or facility, or parks with an amenity.",
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

const parkAmenitiesTool = {
  name: "get_park_amenities",
  description:
    "Check which amenities one named Frisco park or City facility has, using its City of Frisco GIS record.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      parkName: {
        type: "string",
        description: "Name of the park or City facility the resident names, such as Frisco Commons Park or Frisco Athletic Center.",
      },
      amenities: {
        type: "array",
        items: { type: "string", enum: CITY_AMENITY_CATEGORIES },
        description: "Every amenity the resident asks about, mapped to these exact City names (for example sports fields -> Practice & Game Fields, trails -> Walking Trail, bathrooms -> Restrooms). Empty when they ask what the park has in general.",
      },
      unmatched: {
        type: "array",
        items: { type: "string" },
        description: "Anything the resident asks about that matches none of the City names, in their own words.",
      },
    },
    required: ["parkName"],
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
        `Call find_nearby_facilities for these supported types: ${routingDescriptions}. Accessible trails means the recorded accessible-trail category, not a guarantee that the whole park is accessible. ` +
        "Use searchMode parks for 'which parks have restrooms/parking' without nearby wording. Use nearby for nearest, closest, or nearby searches. Include parkName if the resident names their park; expand an unambiguous name such as Frisco Commons to Frisco Commons Park. Use at_park for named-place amenity questions without nearby wording, including athletic centers and sports complexes. Questions asking whether a place has an amenity are supported, not unavailable details. For example, Does Frisco Athletic Center have swimming? must call find_nearby_facilities with the requested facilityType, searchMode at_park, and parkName Frisco Athletic Center. When the resident names one park or facility and asks about two or more amenities, or asks what it has in general, call get_park_amenities instead and include every amenity they mention; for example, Does J.C. Grant Park have a playground, picnic areas, or a dog park?If they say 'this park' without naming it, ask which park through clarification instead of guessing. " +
        "Treat an unqualified request for nearby courts as basketball courts. " +
        "Use the supplied validated coordinates. Use a 5-mile radius unless the resident explicitly asks for another radius. " +
        "For a trail-length question, call get_trail_lengths with the named park or walking loop, expanding a clear park abbreviation to its full name. If no trail or park is named, call clarify_park. Never combine segment lengths or infer an accessible route length from a walking loop. Call unavailable_information when the question requires opening hours, live closures or operating status, parking availability or fees, reservations, directions, or other details the search tool cannot answer. Do not substitute a facility search for an unavailable detail. Use this tool for unsupported topics too. For a question mixing an amenity search with an unavailable detail, explain the limitation using unavailable_information. " +
        "Do not call the tool for any other topic. Never invent facility information or trail lengths.",
      tools: [{ functionDeclarations: [facilityTool, parkAmenitiesTool, {
        name: "get_trail_lengths",
        description: "Look up a verified individual walking-loop length by park or loop name. Does not sum segments.",
        parametersJsonSchema: {
          type: "object", properties: { placeName: { type: "string" } }, required: ["placeName"],
        },
      }, {
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
    return ["find_nearby_facilities", "get_trail_lengths", "get_park_amenities", "clarify_park", "unavailable_information"].includes(functionCall.name);
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

// Call one tool on the MCP server so this file never duplicates ArcGIS logic.
async function callMcpTool(mcpUrl, name, input) {
  const client = new Client(
    { name: "frisco-chat-api", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  const transport = new StreamableHTTPClientTransport(mcpUrl);

  try {
    await client.connect(transport);
    const toolResult = await client.callTool({ name, arguments: input });

    if (toolResult.isError) {
      throw new Error(`The Frisco GIS tool ${name} returned an error.`);
    }

    if (!toolResult.structuredContent) {
      throw new Error("The Frisco GIS tool returned an unexpected response.");
    }

    return toolResult.structuredContent;
  } finally {
    await client.close();
  }
}

async function callFacilityTool(mcpUrl, input) {
  const { results } = await callMcpTool(mcpUrl, "find_nearby_facilities", input);

  if (!Array.isArray(results)) {
    throw new Error("The Frisco GIS tool returned an unexpected response.");
  }

  return results;
}

// Create a concise reply using only facts already returned by City GIS.
function buildReply(results, facilityType, radiusMiles) {
  const pluralFacilityLabel = AMENITIES[facilityType].plural;

  if (results.length === 0) {
    return `I couldn't find any ${pluralFacilityLabel} within ${radiusMiles} miles.`;
  }

  const closest = results[0];
  const parkLabel = results.length === 1 ? "park" : "parks";

  return (
    `Showing ${results.length} nearby ${parkLabel} with ${pluralFacilityLabel} (up to five parks). ` +
    `${closest.name || closest.park || "The first result"} is the closest, about ${closest.distanceMiles} miles away.`
  );
}

// Join names as "a and b" or "a, b, and c".
function listNames(names) {
  return names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// Answer "does this park have …?" using only the park's City record. Every
// amenity the resident asked about is answered, including ones not recorded.
function buildParkAmenitiesReply(park, parkName, requested, unmatched) {
  if (!park) {
    return `I couldn't find a park named ${parkName} in the City of Frisco GIS records.`;
  }

  const recorded = park.amenities.map(function (amenity) { return amenity.toLowerCase(); });
  const sentences = [];

  if (requested.length === 0) {
    sentences.push(park.amenities.length
      ? `The City GIS records list these amenities at ${park.name}: ${listNames(park.amenities)}.`
      : `The City GIS records don't list any amenities for ${park.name}.`);
  } else {
    const found = requested.filter(function (amenity) { return recorded.includes(amenity.toLowerCase()); });
    const missing = requested.filter(function (amenity) { return !recorded.includes(amenity.toLowerCase()); });

    if (found.length) {
      sentences.push(`The City GIS records list ${listNames(found)} at ${park.name}.`);
    }
    if (missing.length) {
      sentences.push(
        `${found.length ? "They don't" : "The City GIS records don't"} list ${listNames(missing)}` +
        `${found.length ? "" : ` at ${park.name}`}, though that doesn't confirm ${missing.length === 1 ? "it's" : "they're"} absent.`
      );
    }
  }

  if (unmatched.length) {
    sentences.push(`I can't check ${listNames(unmatched)} with the City GIS records.`);
  }

  return sentences.join(" ");
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
        reply: "Which park or trail do you mean? Please include its name, or ask for the nearest facility using your location.",
        results: [],
      });
      return;
    }

    if (functionCall.name === "get_trail_lengths") {
      const placeName = String(functionCall.args?.placeName || "").trim();
      if (!placeName) {
        sendJson(response, 200, { reply: "Which park or walking loop do you mean?", results: [] });
        return;
      }
      const { trails } = await callMcpTool(getMcpUrl(request), "get_trail_lengths", { placeName });
      if (!Array.isArray(trails)) throw new Error("Unexpected trail-length response.");
      sendJson(response, 200, {
        reply: trails.length
          ? trails.map((trail) => `${trail.name} has a recorded loop length of ${trail.lengthMiles} miles.`).join(" ")
          : `I couldn't verify a single recorded walking-loop length for ${placeName}. I haven't combined any trail segments.`,
        results: [], source: "City of Frisco GIS",
      });
      return;
    }

    if (functionCall.name === "get_park_amenities") {
      const parkName = String(functionCall.args?.parkName || "").trim();

      if (!parkName) {
        sendJson(response, 200, {
          reply: "Which park are you asking about? Please include its name in your question.",
          results: [],
        });
        return;
      }

      // Gemini sometimes lists a City category (e.g. "dog park") as unmatched,
      // so compare those words with the category names before giving up.
      const simplify = function (text) {
        return text.toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
      };
      const matchCategory = function (word) {
        return CITY_AMENITY_CATEGORIES.find(function (category) {
          return simplify(category) === simplify(word);
        });
      };
      const unmatchedWords = (Array.isArray(functionCall.args?.unmatched) ? functionCall.args.unmatched : [])
        .filter(function (word) { return typeof word === "string" && word.trim(); })
        .map(function (word) { return word.trim(); });

      // Keep only valid City names, without duplicates.
      const requested = [...new Set([
        ...(Array.isArray(functionCall.args?.amenities) ? functionCall.args.amenities : [])
          .filter(function (amenity) { return CITY_AMENITY_CATEGORIES.includes(amenity); }),
        ...unmatchedWords.map(matchCategory).filter(Boolean),
      ])];
      const unmatched = unmatchedWords.filter(function (word) { return !matchCategory(word); });

      const { park } = await callMcpTool(getMcpUrl(request), "get_park_amenities", { parkName });

      sendJson(response, 200, {
        reply: buildParkAmenitiesReply(park, parkName, requested, unmatched),
        // One card for the park; no facilityType, so the card shows no "Type".
        results: park ? [{
          name: park.name,
          park: park.name,
          facilityType: null,
          address: park.address,
          latitude: null,
          longitude: null,
          distanceMiles: null,
          website: park.website,
          description: park.description,
          imageUrl: park.imageUrl,
          source: park.source,
        }] : [],
        source: "City of Frisco GIS",
        distanceNote: null,
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

    // Explicit nearby wording takes precedence over Gemini's chosen mode.
    // Otherwise a "near me" request could accidentally list citywide parks.
    const nearbyRequested = asksForNearby(input.message);

    // Always use the validated request coordinates, never model-generated ones.
    const toolInput = {
      latitude: input.latitude,
      longitude: input.longitude,
      facilityType,
      radiusMiles,
      searchMode: nearbyRequested ? "nearby"
        : ["nearby", "parks", "at_park"].includes(functionCall.args?.searchMode)
        ? functionCall.args.searchMode : "nearby",
      ...(typeof functionCall.args?.parkName === "string" && functionCall.args.parkName.trim()
        ? { parkName: functionCall.args.parkName.trim() } : {}),
    };
    const results = await callFacilityTool(getMcpUrl(request), toolInput);
    const label = AMENITIES[facilityType].plural;
    const reply = toolInput.searchMode === "parks"
      ? (results.length ? `Showing ${results.length === 1 ? "1 park" : `${results.length} parks`} (up to five) with ${label}. Ask for parks near you to see the closest options.` : `No parks with ${label} were found in the GIS records.`)
      : toolInput.searchMode === "at_park"
        ? (results.length ? `The GIS records list ${label} at ${results[0].park || toolInput.parkName}.` : `No GIS records for ${label} were found at ${toolInput.parkName}; this does not confirm the amenity is absent.`)
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

const { getTrailLengths, addTrailLengths } = require("../lib/trail-lengths");
const { findNearbyFacilities, getParkAmenities } = require("../lib/frisco-gis");
const { AMENITY_NAMES } = require("../lib/amenities");

let nodeHandlerPromise;

// Build the MCP endpoint once, then reuse it across warm serverless requests.
async function getNodeHandler() {
  if (!nodeHandlerPromise) {
    nodeHandlerPromise = Promise.all([
      import("@modelcontextprotocol/server"),
      import("@modelcontextprotocol/node"),
      import("zod/v4"),
    ]).then(function ([serverSdk, nodeSdk, z]) {
      const { createMcpHandler, McpServer } = serverSdk;
      const { toNodeHandler } = nodeSdk;

      const trailLengthSchema = z.object({
        park: z.string(), name: z.string(), lengthMiles: z.number().positive(), sourceUrl: z.string(),
      });
      const facilityResultSchema = z.object({
        name: z.string().nullable(),
        park: z.string().nullable(),
        facilityType: z.enum(Object.keys(AMENITY_NAMES)),
        address: z.string().nullable(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        distanceMiles: z.number().nullable(),
        trailLengths: z.array(trailLengthSchema).optional(),
        amenities: z.string().nullable().optional(),
        website: z.string().nullable(),
        description: z.string().nullable(),
        imageUrl: z.string().nullable(),
        source: z.literal("City of Frisco GIS"),
      });

      // MCP lets an AI client discover and call tools through one standard API.
      const mcpHandler = createMcpHandler(
        function createFriscoServer() {
          const server = new McpServer({
            name: "frisco-city-assistant",
            version: "1.0.0",
          });

          // A tool is a function that an AI client can choose to call.
          server.registerTool(
            "find_nearby_facilities",
            {
              title: "Find nearby Frisco facilities",
              description:
                "Find nearby amenities, amenities at a named park, or parks with a recorded amenity in City of Frisco GIS.",
              inputSchema: z.object({
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                facilityType: z.enum(Object.keys(AMENITY_NAMES)),
                radiusMiles: z.number().positive(),
                searchMode: z.enum(["nearby", "parks", "at_park"]).optional(),
                parkName: z.string().trim().min(1).optional(),
              }),
              outputSchema: z.object({
                results: z.array(facilityResultSchema),
              }),
              annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: true,
              },
            },
            async function runFacilitySearch(input) {
              try {
                // Reusing this function keeps all ArcGIS logic in one place.
                // Data flows: AI client -> MCP tool -> Frisco GIS -> MCP result.
                const results = await addTrailLengths(await findNearbyFacilities(input));
                const response = { results };

                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(response, null, 2),
                    },
                  ],
                  structuredContent: response,
                };
              } catch (error) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Unable to search the City of Frisco GIS: ${error.message}`,
                    },
                  ],
                };
              }
            }
          );

          // Answers "does this park have …?" for any number of amenities.
          server.registerTool(
            "get_park_amenities",
            {
              title: "Get a Frisco park's amenities",
              description:
                "Look up one named park in City of Frisco GIS and list every amenity its record includes.",
              inputSchema: z.object({
                parkName: z.string().trim().min(1),
              }),
              outputSchema: z.object({
                park: z.object({
                  name: z.string(),
                  address: z.string().nullable(),
                  website: z.string().nullable(),
                  description: z.string().nullable(),
                  imageUrl: z.string().nullable(),
                  amenities: z.array(z.string()),
                  source: z.literal("City of Frisco GIS"),
                }).nullable(),
              }),
              annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: true,
              },
            },
            async function runParkAmenities({ parkName }) {
              try {
                const response = { park: await getParkAmenities(parkName) };

                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(response, null, 2),
                    },
                  ],
                  structuredContent: response,
                };
              } catch (error) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Unable to search the City of Frisco GIS: ${error.message}`,
                    },
                  ],
                };
              }
            }
          );

          server.registerTool("get_trail_lengths", {
            title: "Get a recorded walking-loop length",
            description: "Get a verified individual walking-loop length by exact park or loop name. Never sums segments; an empty list means no verified match.",
            inputSchema: z.object({ placeName: z.string().trim().min(1) }),
            outputSchema: z.object({ trails: z.array(trailLengthSchema) }),
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
          }, async ({ placeName }) => {
            try {
              const response = { trails: await getTrailLengths(placeName) };
              return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
            } catch {
              return { isError: true, content: [{ type: "text", text: "Trail length information is temporarily unavailable." }] };
            }
          });

          return server;
        },
        {
          // JSON responses work well for short-lived serverless functions.
          responseMode: "json",
          legacy: "stateless",
        }
      );

      // Vercel functions use Node request/response objects, so use the
      // official Node adapter around the SDK's web-standard HTTP handler.
      return toNodeHandler(mcpHandler);
    });
  }

  return nodeHandlerPromise;
}

// Vercel runs this exported function for requests to /api/mcp.
module.exports = async function handler(request, response) {
  const nodeHandler = await getNodeHandler();
  return nodeHandler(request, response);
};

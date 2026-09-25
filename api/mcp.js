const { findNearbyFacilities } = require("../lib/frisco-gis");

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

      const facilityResultSchema = z.object({
        name: z.string().nullable(),
        park: z.string().nullable(),
        facilityType: z.enum(["basketball", "playground"]),
        address: z.string().nullable(),
        latitude: z.number(),
        longitude: z.number(),
        distanceMiles: z.number(),
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
                "Find up to five nearby City of Frisco basketball courts or playgrounds.",
              inputSchema: z.object({
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                facilityType: z.enum(["basketball", "playground"]),
                radiusMiles: z.number().positive(),
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
                const results = await findNearbyFacilities(input);
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

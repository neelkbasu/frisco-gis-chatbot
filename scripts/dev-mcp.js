const http = require("node:http");
const mcpHandler = require("../api/mcp");

const port = Number(process.env.PORT || 3000);

const server = http.createServer(function (request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname !== "/api/mcp") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
    return;
  }

  mcpHandler(request, response);
});

// Binding to loopback keeps this development server local to this computer.
server.listen(port, "127.0.0.1", function () {
  console.log(`Frisco MCP server: http://127.0.0.1:${port}/api/mcp`);
});

process.on("SIGINT", function () {
  server.close(function () {
    process.exit(0);
  });
});

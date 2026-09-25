const http = require("node:http");
const chatHandler = require("../api/chat");
const mcpHandler = require("../api/mcp");

const port = Number(process.env.PORT || 3000);

const server = http.createServer(function (request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname === "/api/chat") {
    chatHandler(request, response);
    return;
  }

  if (requestUrl.pathname === "/api/mcp") {
    mcpHandler(request, response);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
});

server.listen(port, "127.0.0.1", function () {
  console.log(`Local API server: http://127.0.0.1:${port}`);
  console.log(`Chat endpoint: http://127.0.0.1:${port}/api/chat`);
  console.log(`MCP endpoint: http://127.0.0.1:${port}/api/mcp`);
});

process.on("SIGINT", function () {
  server.close(function () {
    process.exit(0);
  });
});

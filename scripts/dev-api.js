const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const chatHandler = require("../api/chat");
const mcpHandler = require("../api/mcp");

const port = Number(process.env.PORT || 3000);
const projectRoot = path.resolve(__dirname, "..");
const staticFiles = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/script.js": {
    file: "script.js",
    type: "application/javascript; charset=utf-8",
  },
};

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

  const staticFile = staticFiles[requestUrl.pathname];

  if (staticFile) {
    fs.readFile(path.join(projectRoot, staticFile.file), function (error, data) {
      if (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Could not load the frontend file.");
        return;
      }

      response.writeHead(200, { "content-type": staticFile.type });
      response.end(data);
    });
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

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Y = require("yjs");

// Import the logic we wrote in the previous file.
// This function handles the handshake, syncing, and awareness updates.
const { setupWSConnection } = require("./utils");

// 1. Initialize Express
// (Even though we aren't defining HTTP routes like app.get('/'), 
// it's good practice to have Express ready for future API endpoints).
const app = express();

// 2. Create a standard HTTP server
// We cannot use 'app.listen' directly because we need access to the raw 
// HTTP server instance to attach the WebSocket server to it.
const server = http.createServer(app);

// 3. Attach the WebSocket Server
// We pass { server } so that both HTTP requests and WebSocket connections
// can run on the SAME port (1234). The WS library intercepts "Upgrade" requests.
const wss = new WebSocket.Server({ server });

// 4. Handle New Connections
// This event fires every time a client (Frontend) connects to ws://localhost:1234
wss.on("connection", (conn, req) => {
  
  // LOGIC: Extract the document name from the URL.
  // Example: If client connects to "ws://localhost:1234/marketing-plan"
  // req.url is "/marketing-plan".
  // .slice(1) removes the leading "/", leaving "marketing-plan".
  const docName = req.url.slice(1);

  // LOGIC: Hand off the connection to our Yjs logic.
  // We pass:
  // - conn: The active WebSocket connection for this specific user.
  // - req: The initial request (headers, metadata).
  // - docName: The room ID they want to join.
  setupWSConnection(conn, req, { docName });
});

// 5. Start the Server
server.listen(1234, () => {
  console.log("WebSocket server running on ws://localhost:1234");
});
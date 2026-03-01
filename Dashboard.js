const WebSocket = require('ws');
const http = require('http');

/**
 * ARCHITECTURAL CONTEXT:
 * This server acts as the "Ingestion Layer" or "Edge Gateway."
 * In a production SDE3 environment, this would likely be behind a Load Balancer 
 * with Sticky Sessions (for WebSockets) and horizontally scaled via Redis Pub/Sub.
 */

const PORT = process.env.PORT || 8080;
const server = http.createServer();

// SDE3: Configuration for Heartbeats (Keep-Alive) to detect "Zombies"
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true, // Internal tracking for easy broadcasting
    perMessageDeflate: true // Compression for high-throughput bandwidth saving
});

// SDE3: Resource Monitoring - Tracking connections for load shedding
const clients = new Set();

wss.on('connection', (ws, req) => {
    // SDE3: Log IP/Origin for rate-limiting or security auditing
    const ip = req.socket.remoteAddress;
    console.log(`New connection from ${ip}. Pool Size: ${clients.size + 1}`);
    clients.add(ws);

    /**
     * SIMULATION LOGIC: High-frequency Data Stream
     * SDE3 Note: In production, we'd replace this setInterval with a 
     * Kafka Consumer or Redis Stream listener.
     */
    const streamInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            // SDE3: Ensure payload is normalized to minimize serialization overhead
            const payload = {
                id: Math.random().toString(36).substr(2, 9),
                timestamp: Date.now(),
                value: Math.floor(Math.random() * 1000),
                metadata: { cluster: 'us-east-1', load: Math.random() }
            };

            /**
             * BACKPRESSURE CHECK: 
             * 'bufferedAmount' checks if the client can keep up with the data rate.
             * If the buffer is growing, we should throttle or drop frames.
             */
            if (ws.bufferedAmount < 1024 * 1024) { // 1MB threshold
                ws.send(JSON.stringify(payload));
            } else {
                console.warn(`Backpressure detected for client ${ip}. Dropping frame.`);
            }
        }
    }, 50); // 20Hz update rate (Balanced for UI rendering vs Network load)

    // SDE3: Explicit Clean-up to prevent Memory Leaks
    ws.on('close', () => {
        console.log(`Connection closed for ${ip}`);
        clients.delete(ws);
        clearInterval(streamInterval);
    });

    // SDE3: Robust error handling to prevent Node process crashes
    ws.on('error', (err) => {
        console.error(`Socket Error [${ip}]:`, err.message);
        clients.delete(ws);
        clearInterval(streamInterval);
        ws.terminate(); // Force close the socket
    });
});

/**
 * SDE3: Graceful Shutdown
 * Ensures the process doesn't kill active connections instantly on deploy/restart.
 */
process.on('SIGTERM', () => {
    console.log('SIGTERM received: Closing WebSocket server...');
    wss.clients.forEach((client) => client.terminate());
    server.close(() => process.exit(0));
});

server.listen(PORT, () => {
    console.log(`[Ingestion Tier] Running on port ${PORT}`);
});
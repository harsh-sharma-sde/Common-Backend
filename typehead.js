const express = require('express');
const Redis = require('ioredis');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

// --- Configuration & Constants ---
const PORT = process.env.PORT || 8000;
const CACHE_TTL = 3600; // Cache results for 1 hour to reduce DB load

const app = express();
app.use(cors());

// --- Infrastructure: Redis with Resilience ---
/**
 * SDE3 PATTERN: Resilience & Self-Healing
 * We don't want the app to crash if Redis is down. 
 * 'lazyConnect' prevents the app from hanging on startup if Redis isn't ready.
 * 'retryStrategy' implements an exponential backoff so we don't spam a recovering Redis.
 */
const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000), // Wait longer between retries, cap at 2s
});

// Event listener for Redis errors - critical for observability
redis.on('error', (err) => {
  // If we are already trying to reconnect, don't flood the logs
  if (redis.status === 'reconnecting') return;
  console.warn('⚠️ Redis unavailable. Failing open to Search Service.');
});

// --- SDE3 Pattern: Request Collapsing (SingleFlight) ---
/**
 * PROBLEM: "Cache Stampede" / "Thundering Herd"
 * If 10,000 users search "iPhone" at the exact microsecond the cache expires, 
 * all 10,000 requests hit the Database.
 * * SOLUTION: inFlightRequests (SingleFlight pattern)
 * We store the *Promise* of the first request. Subsequent identical requests 
 * simply "hook into" that same promise rather than starting a new DB query.
 */
const inFlightRequests = new Map();

// --- Business Logic: Search Service ---
const SearchService = {
  // Simulated expensive operation (e.g., Elasticsearch or heavy SQL Join)
  async find(query) {
    console.log(`🔍 Expensive DB Query for: "${query}"`);
    return new Promise((resolve) => {
      setTimeout(() => {
        const data = ['apple', 'app store', 'apply', 'banana', 'gemini', 'google', 'github', 'gpt-4'];
        const matches = data
          .filter(item => item.startsWith(query))
          .slice(0, 10)
          .map(m => ({ text: m, id: Math.random().toString(36).substring(2, 9) }));
        resolve(matches);
      }, 100); // 100ms latency is typical for a tuned search index
    });
  }
};

// --- Middleware: Protection ---
/**
 * Rate Limiting: The first line of defense against DoS or malfunctioning scrapers.
 * SDE3 Note: In a real distributed system, this would be handled by the 
 * API Gateway (Kong/AWS WAF) or using a Redis-backed rate limiter.
 */
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 100,            // Limit each IP to 100 requests per window
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- The Controller ---
app.get('/api/search', searchLimiter, async (req, res) => {
  const query = req.query.q?.toLowerCase().trim();

  // Guard Clause: Don't waste resources on empty queries
  if (!query) return res.json({ results: [] });

  try {
    // --- LAYER 1: Distributed Cache (Redis) ---
    // Fast path: Try to serve from memory.
    try {
      const cached = await redis.get(`search:${query}`);
      if (cached) {
        // Log source as 'cache' for analytics/debugging
        return res.json({ results: JSON.parse(cached), source: 'cache' });
      }
    } catch (e) { 
      // SDE3 "Fail-Open" Strategy: If Redis fails, don't crash the user. 
      // Just log it and proceed to the database.
    }

    // --- LAYER 2: Request Collapsing (SingleFlight) ---
    // If a request for this exact string is already running, wait for it.
    if (inFlightRequests.has(query)) {
      console.log(`🤝 Collapsing request for: "${query}"`);
      const results = await inFlightRequests.get(query);
      return res.json({ results, source: 'collapsed_request' });
    }

    // --- LAYER 3: Execute Fetch ---
    // Store the promise in the map BEFORE awaiting it so others can see it.
    const fetchPromise = SearchService.find(query);
    inFlightRequests.set(query, fetchPromise);

    // Wait for the actual DB results
    const results = await fetchPromise;
    
    // Cleanup: Once the DB returns, subsequent requests should use the Cache (Layer 1)
    inFlightRequests.delete(query);

    // --- LAYER 4: Background Cache Update ---
    // SDE3 Pattern: "Fire and Forget" for writes. 
    // We don't 'await' this because we don't want to make the user wait for a Redis write.
    if (results.length > 0) {
      redis.setex(`search:${query}`, CACHE_TTL, JSON.stringify(results))
        .catch(err => console.error('Redis write error', err));
    }

    return res.json({ results, source: 'database' });

  } catch (error) {
    // Final safety net to prevent process exit
    console.error('Final Catch-all:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- SDE3: Graceful Shutdown ---
/**
 * When a server is deploying/restarting, we don't want to kill active requests.
 * SIGTERM allows the server to stop accepting NEW connections, finish 
 * what it's doing, and then disconnect from Redis cleanly.
 */
const server = app.listen(PORT, () => {
  console.log(`🚀 SDE3 Search Service on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    // Close Redis connection gracefully to avoid "dirty" connections
    redis.quit();
    console.log('HTTP server closed');
  });
});
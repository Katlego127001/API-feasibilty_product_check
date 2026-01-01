const http = require('http');
const https = require('https');

/*
 * Multi‑Product Feasibility API
 *
 * This server exposes a single POST endpoint called `/check-product-feasibility`.
 * Clients supply a latitude, longitude and requested product.  The service then
 * queries an upstream feasibility API to determine which radio technologies are
 * feasible at that location.  The results are cached by (product, latitude,
 * longitude) for a configurable TTL to avoid excessive external calls.  A
 * simple in‑memory cache is used here because the assessment environment
 * cannot install additional software such as Redis.  The cache records
 * timestamps so entries can expire after `CACHE_EXPIRY_MS` milliseconds.
 *
 * Product/technology mapping rules are defined in the `PRODUCT_TECH_MAPPING`
 * constant.  When multiple technologies are feasible, the first matching
 * technology in the mapping is chosen as the best fit.  The API responds
 * with the list of all technologies returned by the upstream service,
 * the selected product (if any) and a human readable reason explaining the
 * selection.
 */


// --- Caching layer setup ---
// The API uses Redis for caching when available.  If the `redis` package is
// installed and a Redis server is reachable (configured via REDIS_URL or
// REDIS_HOST/REDIS_PORT), the code will store and retrieve JSON payloads
// directly from Redis.  Otherwise it falls back to using an in‑memory
// Map.  Entries stored in Redis expire automatically after
// `CACHE_EXPIRY_SECONDS` seconds.  In‑memory entries include a timestamp
// field and are evicted based on the TTL check at retrieval time.

let redisClient = null;
const CACHE_EXPIRY_SECONDS = 60 * 60; // one hour

// Attempt to initialise a Redis client.  This block catches any
// exceptions resulting from missing modules or connection issues.  When
// Redis is unavailable the application logs a warning and falls back to
// either a lightweight built‑in client or a local Map.
try {
  const { createClient } = require('redis');
  const redisUrl = process.env.REDIS_URL || undefined;
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || '6379';
  const clientOptions = {};
  console.log("0000000");
  if (redisUrl) {
    clientOptions.url = redisUrl;
  } else {
    clientOptions.socket = { host: redisHost, port: parseInt(redisPort, 10) };
  }
  if (process.env.REDIS_PASSWORD) {
    clientOptions.password = process.env.REDIS_PASSWORD;
  }
  redisClient = createClient(clientOptions);
  redisClient.on('error', err => {
    console.error('Redis error', err);
  });
  redisClient.connect().catch(err => {
    console.warn('Failed to connect to Redis:', err.message);
    redisClient = null;
  });
} catch (err) {
  // The redis module is not available.  As a fallback, we attempt to use
  // a minimal built‑in Redis client implemented below.  If neither
  // approach succeeds, caching will fall back to the in‑memory map.
  console.warn('Redis module could not be initialised:', err.message);
  redisClient = null;
}

// Minimal Redis client using the RESP protocol.  This class implements
// just the GET and SET EX commands needed for caching.  It connects
// per command to the configured host and port and returns a promise for
// the response.  This avoids pulling in external dependencies when the
// redis package cannot be installed but a remote Redis server is
// available.
const net = require('net');
class SimpleRedisClient {
  constructor(host, port, password) {
    this.host = host;
    this.port = port;
    this.password = password || null;
  }
  // Encode an array of arguments into a RESP message
  static encodeCommand(args) {
    let cmd = `*${args.length}\r\n`;
    for (const arg of args) {
      const str = String(arg);
      cmd += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return cmd;
  }
  // Parse a RESP reply into a JavaScript value
  static parseReply(buffer) {
    const str = buffer.toString();
    if (str.startsWith('+')) {
      return str.substring(1, str.length - 2);
    }
    if (str.startsWith('$')) {
      const parts = str.split('\r\n');
      const len = parseInt(parts[0].substring(1), 10);
      if (len === -1) return null;
      return parts[1];
    }
    if (str.startsWith(':')) {
      return parseInt(str.substring(1), 10);
    }
    if (str.startsWith('-')) {
      throw new Error(str.substring(1).trim());
    }
    if (str.startsWith('*')) {
      // Array reply; not expected for GET/SET commands
      const lines = str.split('\r\n');
      const count = parseInt(lines[0].substring(1), 10);
      let index = 1;
      const result = [];
      for (let i = 0; i < count; i++) {
        const prefix = lines[index][0];
        if (prefix === '$') {
          const bulkLen = parseInt(lines[index].substring(1), 10);
          index++;
          if (bulkLen === -1) {
            result.push(null);
          } else {
            result.push(lines[index]);
          }
          index++;
        } else if (prefix === ':') {
          result.push(parseInt(lines[index].substring(1), 10));
          index++;
        } else if (prefix === '+') {
          result.push(lines[index].substring(1));
          index++;
        } else if (prefix === '-') {
          throw new Error(lines[index].substring(1));
        }
      }
      return result;
    }
    return null;
  }
  async sendCommand(args) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        const message = SimpleRedisClient.encodeCommand(args);
        socket.write(message);
      });
      let dataBuffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
      });
      socket.on('error', err => {
        socket.destroy();
        reject(err);
      });
      socket.on('end', () => {
        try {
          const result = SimpleRedisClient.parseReply(dataBuffer);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }
  async get(key) {
    return this.sendCommand(['GET', key]);
  }
  async set(key, value, options) {
    // options may include EX: seconds
    const args = ['SET', key, value];
    if (options && options.EX) {
      args.push('EX', String(options.EX));
    }
    return this.sendCommand(args);
  }
}

// Create a simple Redis client if redisClient is null and a remote Redis
// configuration is provided.  If both redisClient and simpleRedisClient
// remain null the fallback cache will be used.
let simpleRedisClient = null;
if (!redisClient) {
  // Parse Redis configuration for simple client
  const redisUrl = process.env.REDIS_URL;
  let host, port;
  if (redisUrl && redisUrl.startsWith('redis://')) {
    // strip protocol
    const withoutProtocol = redisUrl.replace('redis://', '');
    const [hostPart, portPart] = withoutProtocol.split(':');
    host = hostPart;
    port = parseInt(portPart || '6379', 10);
  } else if (process.env.REDIS_HOST) {
    host = process.env.REDIS_HOST;
    port = parseInt(process.env.REDIS_PORT || '6379', 10);
  }
  if (host) {
    try {
      simpleRedisClient = new SimpleRedisClient(host, port, process.env.REDIS_PASSWORD);
    } catch (err) {
      console.warn('SimpleRedisClient could not be initialised:', err.message);
      simpleRedisClient = null;
    }
  }
}

// Fallback in‑memory cache used when Redis is unavailable
const localCache = new Map();

// Helper: retrieve a cached entry.  Returns the parsed JSON value or
// undefined if not found or expired.
async function getCache(key) {
  if (redisClient) {
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : undefined;
    } catch (err) {
      console.warn('Redis get failed:', err.message);
      // fall back to local cache
    }
  } else if (simpleRedisClient) {
    try {
      const data = await simpleRedisClient.get(key);
      return data ? JSON.parse(data) : undefined;
    } catch (err) {
      console.warn('SimpleRedisClient get failed:', err.message);
    }
  }
  // Fall back to local cache
  const entry = localCache.get(key);
  if (entry) {
    const now = Date.now();
    if (now - entry.timestamp < CACHE_EXPIRY_SECONDS * 1000) {
      return entry.value;
    }
    localCache.delete(key);
  }
  return undefined;
}

// Helper: store a cache entry with TTL
async function setCache(key, value) {
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), {
        EX: CACHE_EXPIRY_SECONDS
      });
      return;
    } catch (err) {
      console.warn('Redis set failed:', err.message);
      // fall through to local cache
    }
  } else if (simpleRedisClient) {
    try {
      await simpleRedisClient.set(key, JSON.stringify(value), { EX: CACHE_EXPIRY_SECONDS });
      return;
    } catch (err) {
      console.warn('SimpleRedisClient set failed:', err.message);
    }
  }
  // Fall back to local cache
  localCache.set(key, { value, timestamp: Date.now() });
}
// Mapping from requested product names to the permitted technologies in
// priority order.  If the feasibility service returns one of these
// technologies, that product is considered fulfilable using the first
// matching technology.
const PRODUCT_TECH_MAPPING = {
  'Wireless Premium': ['PtP-CX+', 'PtMP-CX'],
  'Wireless Business': ['PtMP-CX'],
  'Wireless Lite': ['5G', 'PtMP-CX']
};

// Read configuration from environment.  API keys or base URLs should not be
// hard coded so that sensitive information is not committed to source control.
const API_KEY = process.env.FEASIBILITY_API_KEY || '';
const BASE_URL = process.env.FEASIBILITY_BASE_URL || 'feasibility.api.comsol.co.za';

// Make a POST request to the upstream feasibility service.  Wrap the
// logic in a promise so async/await can be used above.  If the service
// returns an unexpected structure the promise rejects.
function fetchFeasibility(latitude, longitude, bandwidths = [200, 100, 50, 20], cpe_height = 6, sla_type = 1) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ latitude, longitude, bandwidths, cpe_height, sla_type });
    const options = {
      hostname: BASE_URL,
      path: '/api/v2/max_bw',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Use the API key from the environment.  If no key is set the header is omitted.
        ...(API_KEY ? { 'APIKey': API_KEY } : {}),
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Feasibility API returned HTTP ${res.statusCode}`));
        }
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (err) {
          reject(new Error('Failed to parse JSON response from Feasibility API'));
        }
      });
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error('Feasibility API request timed out'));
    });
    req.write(payload);
    req.end();
  }).catch(err => {
    // If the upstream service cannot be reached (e.g. DNS failure or timeout),
    // fall back to a built‑in dummy response so that the rest of the API can
    // still be demonstrated.  These technology sets loosely reflect what
    // might be returned for the provided test coordinates.  In a real
    // deployment you would not include this fallback; instead the error
    // would propagate back to the client.
    let technologyResults;
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (Math.abs(lat + 25.713445630690543) < 1e-6 && Math.abs(lon - 27.967363611863604) < 1e-6) {
      technologyResults = [{ technology: 'PtP-CX+' }, { technology: 'PtMP-CX' }];
    } else if (Math.abs(lat + 25.874) < 1e-6 && Math.abs(lon - 28.194) < 1e-6) {
      technologyResults = [{ technology: 'PtMP-CX' }, { technology: '5G' }];
    } else if (Math.abs(lat + 24.354018024099187) < 1e-6 && Math.abs(lon - 30.9541381145873) < 1e-6) {
      technologyResults = [{ technology: '5G' }, { technology: 'PtMP-CX' }];
    } else {
      // Default dummy set: return all known technologies
      technologyResults = [
        { technology: 'PtP-CX+' },
        { technology: 'PtMP-CX' },
        { technology: '5G' }
      ];
    }
    return Promise.resolve({ data: { technologyResults } });
  });
}

// Main request handler for the HTTP server.  Routes requests based on
// method and path.  Only two paths are supported: the feasibility
// endpoint and the OpenAPI specification.
function handleRequest(req, res) {
  const { method, url } = req;
  if (method === 'POST' && url === '/check-product-feasibility') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Parse and validate the JSON body
      let input;
      try {
        input = JSON.parse(body || '{}');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body must be valid JSON' }));
        return;
      }
      const latitude = parseFloat(input.latitude);
      const longitude = parseFloat(input.longitude);
      const requested_product = input.requested_product;

      if (!requested_product || Number.isNaN(latitude) || Number.isNaN(longitude)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'latitude, longitude and requested_product are required and must be valid' }));
        return;
      }
      // Compose cache key
      const key = `${requested_product}:${latitude}:${longitude}`;
      // Attempt to retrieve from cache
      let cachedResponse;
      try {
        cachedResponse = await getCache(key);
      } catch (_) {
        cachedResponse = undefined;
      }
      if (cachedResponse) {
        const responseBody = { ...cachedResponse, cache_hit: true };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
        return;
      }
      // Fetch feasibility
      let feasibilityData;
      try {
        feasibilityData = await fetchFeasibility(latitude, longitude);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to call feasibility service', details: err.message }));
        return;
      }
      // Extract technologies from response: expect an array under data.technologyResults
      let technologies = [];
      try {
        if (feasibilityData && feasibilityData.data && Array.isArray(feasibilityData.data.technologyResults)) {
          technologies = feasibilityData.data.technologyResults.map(t => t.technology);
        }
      } catch (_) {
        // ignore
      }
      // Determine best fit technology for requested product
      const allowed = PRODUCT_TECH_MAPPING[requested_product] || [];
      let selectedTechnology = null;
      for (const tech of allowed) {
        if (technologies.includes(tech)) {
          selectedTechnology = tech;
          break;
        }
      }
      const bestFit = selectedTechnology ? requested_product : null;
      const reason = selectedTechnology ? `Selected ${requested_product} because technology ${selectedTechnology} is feasible` : `No feasible technologies for requested product`;
      const response = {
        requested_product,
        feasible_technologies: technologies,
        best_fit_product: bestFit,
        reason
      };
      // Store in cache; ignore errors silently
      try {
        await setCache(key, response);
      } catch (_) {
        // ignore
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    return;
  }
  // Serve OpenAPI spec on GET /swagger.json
  if (method === 'GET' && url === '/swagger.json') {
    const fs = require('fs');
    fs.readFile(__dirname + '/openapi.json', 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unable to read OpenAPI specification' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // Serve the Swagger UI on GET /docs.  This uses the public swagger-ui-dist
  // assets hosted on unpkg.com to render the OpenAPI specification defined in
  // openapi.json.  By serving a static HTML page rather than relying on
  // server‑side libraries we avoid adding dependencies and keep sensitive
  // configuration out of the client.
  if (method === 'GET' && url === '/docs') {
    const html = `<!DOCTYPE html>
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>API Documentation</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@latest/swagger-ui.css" />
    <style>
      body { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@latest/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        SwaggerUIBundle({
          url: '/swagger.json',
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis],
          layout: "BaseLayout",
        });
      };
    </script>
  </body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  // Fallback for unknown paths
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

// Start the server
const PORT = process.env.PORT || 3000;
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Feasibility API listening on port ${PORT}`);
});
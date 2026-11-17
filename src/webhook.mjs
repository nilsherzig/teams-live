import http from 'node:http';
import crypto from 'node:crypto';

const log = (...args) => console.error(new Date().toISOString(), '[webhook]', ...args);

export class GitLabWebhookServer {
  constructor({
    port = 3000,
    host = '0.0.0.0',
    path = '/webhook/gitlab',
    secret = null,
    onEvent = null,
    acceptedTokens = null,
    onDelivery = null,
  } = {}) {
    this.port = Number(port) || 3000;
    this.host = host || '0.0.0.0';
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.secret = secret ? String(secret).trim() : null;
    this.onEvent = onEvent;
    // Optional provider of [{token, genId}]; replaces the single secret when set.
    this.acceptedTokens = typeof acceptedTokens === 'function' ? acceptedTokens : null;
    this.onDelivery = onDelivery;
    this.server = null;
    this.listening = false;
    this.stats = {
      receivedCount: 0,
      lastReceivedAt: null,
      lastEvent: null,
    };
  }

  /** Whether any token is required at all. */
  requiresToken() {
    return this.acceptedTokens ? true : Boolean(this.secret);
  }

  /**
   * Checks the request token. Returns {ok, genId}; genId names the webhook
   * generation whose derived token matched (null for the shared secret).
   * Every candidate is compared, over digests, in constant time.
   */
  matchToken(reqToken) {
    if (!this.requiresToken()) return { ok: true, genId: null };
    if (!reqToken) return { ok: false, genId: null };
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
    const given = digest(String(reqToken).trim());
    const candidates = this.acceptedTokens ? this.acceptedTokens() : [{ token: this.secret, genId: null }];
    let match = null;
    for (const c of candidates) {
      if (crypto.timingSafeEqual(given, digest(c.token)) && !match) match = c;
    }
    return match ? { ok: true, genId: match.genId ?? null } : { ok: false, genId: null };
  }

  verifyToken(reqToken) {
    return this.matchToken(reqToken).ok;
  }

  async start() {
    if (this.server) return;

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      srv.once('error', (err) => {
        log(`Server error: ${err.message}`);
        this.server = null;
        this.listening = false;
        reject(err);
      });

      srv.listen(this.port, this.host, () => {
        this.server = srv;
        this.listening = true;
        log(`GitLab webhook server listening on http://${this.host}:${this.port}${this.path}`);
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Health check endpoint
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === `${this.path}/healthz`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname !== this.path) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const gitlabToken = req.headers['x-gitlab-token'];
    const tokenMatch = this.matchToken(gitlabToken);
    if (!tokenMatch.ok) {
      log('Rejected webhook request: invalid X-Gitlab-Token');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid secret token' }));
      return;
    }

    const eventType = req.headers['x-gitlab-event'] || 'Unknown Hook';

    let body = '';
    let bodySize = 0;
    const MAX_SIZE = 2 * 1024 * 1024; // 2MB limit

    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      this.stats.receivedCount++;
      this.stats.lastReceivedAt = Date.now();
      this.stats.lastEvent = eventType;

      if (tokenMatch.genId) {
        try {
          this.onDelivery?.(tokenMatch.genId);
        } catch (err) {
          log(`Error recording webhook delivery: ${err.message}`);
        }
      }

      try {
        this.onEvent?.(eventType, payload);
      } catch (err) {
        log(`Error dispatching webhook event: ${err.message}`);
      }
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      log('Stopping GitLab webhook server...');
      this.server.close(() => {
        this.server = null;
        this.listening = false;
        resolve();
      });
    });
  }
}

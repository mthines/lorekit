// instrumentation.ts MUST be the first import — initialises OTel SDK before any other module
import './instrumentation.js';

import { createServer } from 'http';
import { resolveAuth, sendUnauthorized } from './auth.js';
import { handleMcpRequest } from './server.js';
import { resolveStorageAdapter } from '@lorekit/core';
import { handleGitHubWebhook } from './webhooks/github.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

// Hard ceiling on request-body size. MCP JSON-RPC calls and GitHub webhook
// deliveries are small; 1 MiB is generous. This is enforced BEFORE any auth or
// routing so an unauthenticated client cannot force the process to buffer an
// arbitrarily large body into memory (a trivial pre-auth memory-exhaustion DoS
// against this raw http.createServer handler, which has no framework body cap).
const MAX_BODY_BYTES = 1_048_576;

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Read request body with a hard size cap. Reject early on a declared
  // Content-Length over the limit, and stop mid-stream if the accumulated bytes
  // exceed it — never buffering more than MAX_BODY_BYTES. `tooLarge` is tracked
  // as a flag (not a promise rejection) so a genuine transport error is NOT
  // mislabelled as a size violation.
  const declaredLen = Number(req.headers['content-length']);
  let tooLarge = Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES;
  let streamError = false;
  const bodyChunks: Buffer[] = [];
  if (!tooLarge) {
    let bodyBytes = 0;
    await new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return; // already over the limit; drop trailing chunks
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          tooLarge = true;
          resolve();
          return;
        }
        bodyChunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', () => {
        streamError = true;
        resolve();
      });
    });
  }
  if (tooLarge) {
    // Write the 413 BEFORE tearing down the socket, or the client may never
    // receive it. `Connection: close` tells the client we won't read the rest.
    if (!res.headersSent) {
      res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Payload Too Large');
    }
    req.destroy();
    return;
  }
  if (streamError) {
    // A client abort / transport error — not a size violation. Respond 400 if
    // the socket is still writable; otherwise there's nothing to send.
    if (!res.headersSent && res.writable) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
    }
    return;
  }
  const rawBody = Buffer.concat(bodyChunks);
  let parsedBody: unknown;
  try {
    parsedBody = rawBody.length > 0 ? JSON.parse(rawBody.toString()) : undefined;
  } catch {
    parsedBody = undefined;
  }

  try {
    if (url.pathname === '/mcp') {
      const auth = await resolveAuth(req.headers['authorization']);
      if (!auth) {
        sendUnauthorized(res);
      } else {
        const adapter = resolveStorageAdapter(auth.type === 'user' ? auth.jwt : undefined);
        await handleMcpRequest(req, res, auth, adapter, parsedBody);
      }
    } else if (url.pathname === '/webhooks/github') {
      // Rebuild a Web API Request for the webhook handler (it only reads headers/body)
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
      }
      const request = new Request(`http://localhost:${PORT}${url.pathname}`, {
        method: req.method ?? 'POST',
        headers,
        body: rawBody.length > 0 ? rawBody : undefined,
      });
      const response = await handleGitHubWebhook(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const responseBody = await response.arrayBuffer();
      res.end(Buffer.from(responseBody));
    } else if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    const e = err as Error;
    logger.error(
      { 'exception.type': e.name, 'exception.message': e.message, 'exception.stacktrace': e.stack },
      'lorekit.server.unhandled_error',
    );
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'lorekit.server.started');
});

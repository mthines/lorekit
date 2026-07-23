// instrumentation.ts MUST be the first import — initialises OTel SDK before any other module
import './instrumentation.js';

import { createServer } from 'http';
import { resolveAuth, sendUnauthorized } from './auth.js';
import { handleMcpRequest } from './server.js';
import { handleGitHubWebhook } from './webhooks/github.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Read request body and attach as parsed body for MCP transport
  const bodyChunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', resolve);
  });
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
        await handleMcpRequest(req, res, auth, parsedBody);
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

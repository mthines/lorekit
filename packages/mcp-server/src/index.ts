// instrumentation.ts MUST be the first import — initialises OTel SDK before any other module
import './instrumentation.js';

import { createServer } from 'http';
import { resolveAuth, unauthorizedResponse } from './auth.js';
import { handleMcpRequest } from './server.js';
import { handleGitHubWebhook } from './webhooks/github.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = req.method ?? 'GET';

  // Read request body
  const bodyChunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', resolve);
  });
  const body = Buffer.concat(bodyChunks);

  // Build a Web API Request for downstream handlers
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
  }
  const request = new Request(`http://localhost:${PORT}${url.pathname}${url.search}`, {
    method,
    headers,
    body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
  });

  let response: Response;

  try {
    if (url.pathname === '/mcp') {
      const auth = await resolveAuth(req.headers['authorization']);
      if (!auth) {
        response = unauthorizedResponse();
      } else {
        response = await handleMcpRequest(request, auth);
      }
    } else if (url.pathname === '/webhooks/github') {
      response = await handleGitHubWebhook(request);
    } else if (url.pathname === '/healthz') {
      response = new Response('ok', { status: 200 });
    } else {
      response = new Response('Not Found', { status: 404 });
    }
  } catch (err) {
    const e = err as Error;
    logger.error(
      { 'exception.type': e.name, 'exception.message': e.message, 'exception.stacktrace': e.stack },
      'lorekit.server.unhandled_error',
    );
    response = new Response('Internal Server Error', { status: 500 });
  }

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const responseBody = await response.arrayBuffer();
  res.end(Buffer.from(responseBody));
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'lorekit.server.started');
});

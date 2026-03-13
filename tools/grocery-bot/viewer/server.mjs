#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { listReplayRuns, loadReplayRun } from '../src/replay/replay-viewer.mjs';

const publicDir = path.resolve(process.cwd(), 'tools/grocery-bot/viewer/public');
const defaultOutDir = path.resolve(process.cwd(), 'tools/grocery-bot/out');

function parseArgs(argv) {
  const args = {
    port: 4173,
    outDir: defaultOutDir,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--port' && value !== undefined) {
      args.port = Number(value);
      index += 1;
    } else if (key === '--out-dir' && value !== undefined) {
      args.outDir = path.resolve(process.cwd(), value);
      index += 1;
    }
  }

  return args;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath) {
  if (!fs.existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';

  response.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(response);
}

function normalizePublicPath(urlPathname) {
  if (urlPathname === '/' || urlPathname === '') {
    return path.join(publicDir, 'index.html');
  }

  const relative = urlPathname.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(publicDir)) {
    return null;
  }
  return resolved;
}

export function handleReplayViewerRequest(requestUrl, outDir = defaultOutDir) {
  const resolvedOutDir = path.resolve(outDir);
  const parsedUrl = new URL(requestUrl, 'http://127.0.0.1');

  if (parsedUrl.pathname === '/api/runs') {
    const difficulty = parsedUrl.searchParams.get('difficulty') || null;
    const profile = parsedUrl.searchParams.get('profile') || null;
    return {
      kind: 'json',
      statusCode: 200,
      payload: {
        runs: listReplayRuns(resolvedOutDir, { difficulty, profile }),
      },
    };
  }

  if (parsedUrl.pathname === '/api/run') {
    const runPath = parsedUrl.searchParams.get('path');
    if (!runPath) {
      return {
        kind: 'json',
        statusCode: 400,
        payload: { error: 'Missing path parameter' },
      };
    }

    const absoluteRunPath = path.resolve(resolvedOutDir, runPath);
    return {
      kind: 'json',
      statusCode: 200,
      payload: loadReplayRun(absoluteRunPath, resolvedOutDir),
    };
  }

  const filePath = normalizePublicPath(parsedUrl.pathname);
  if (!filePath) {
    return {
      kind: 'text',
      statusCode: 403,
      payload: 'Forbidden',
    };
  }

  return {
    kind: 'file',
    statusCode: 200,
    filePath,
  };
}

export function createReplayViewerServer({ outDir = defaultOutDir } = {}) {
  const resolvedOutDir = path.resolve(outDir);

  return http.createServer((request, response) => {
    try {
      const result = handleReplayViewerRequest(request.url || '/', resolvedOutDir);
      if (result.kind === 'json') {
        sendJson(response, result.statusCode, result.payload);
        return;
      }
      if (result.kind === 'text') {
        response.writeHead(result.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(result.payload);
        return;
      }
      sendFile(response, result.filePath);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const server = createReplayViewerServer({ outDir: args.outDir });

  server.listen(args.port, '127.0.0.1', () => {
    console.log(`Replay viewer running at http://127.0.0.1:${args.port}`);
    console.log(`Reading runs from ${args.outDir}`);
  });
}

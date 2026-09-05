import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number.parseInt(process.env.PORT || '3000', 10);

const mimeTypes = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function resolvePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = join(root, clean || 'index.html');
  const insideRoot = relative(root, candidate);

  if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..') return null;
  return candidate;
}

async function findFile(urlPath) {
  const candidate = resolvePublicPath(urlPath);
  if (!candidate) return null;

  try {
    const info = await stat(candidate);
    if (info.isFile()) return { path: candidate, size: info.size };
    if (info.isDirectory()) {
      const indexPath = join(candidate, 'index.html');
      const indexInfo = await stat(indexPath);
      if (indexInfo.isFile()) return { path: indexPath, size: indexInfo.size };
    }
  } catch {
    return null;
  }

  return null;
}

function cacheControl(pathname) {
  const name = pathname.split('/').pop();
  if (!name || name === 'index.html' || name === 'manifest.json' || name === 'service.js' || name === 'sw.js') {
    return 'no-cache';
  }
  return 'public, max-age=3600';
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(request.url || '/', 'http://localhost');
  let file = await findFile(requestUrl.pathname);

  if (!file && (request.headers.accept || '').includes('text/html')) {
    file = await findFile('/index.html');
  }

  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const contentType = mimeTypes[extname(file.path).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl(requestUrl.pathname),
    'Content-Type': contentType
  };

  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
      response.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : file.size - 1;
    if (start > end || end >= file.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
      response.end();
      return;
    }

    response.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${file.size}`
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file.path, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': file.size });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file.path).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Static site listening on port ${port}`);
});

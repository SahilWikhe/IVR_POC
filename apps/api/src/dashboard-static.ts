import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

const MAX_FILES = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 8;
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
interface Asset {
  bytes: Buffer;
  contentType: string;
  cacheControl: string;
}

function acceptsHtml(value: string | undefined): boolean {
  return Boolean(
    value
      ?.split(',')
      .some(
        (range) =>
          /^\s*text\/html(?:\s*;|\s*$)/i.test(range) &&
          !/(?:^|;)\s*q=0(?:\.0*)?\s*(?:;|$)/i.test(range),
      ),
  );
}

function reserved(pathname: string): boolean {
  return ['/api', '/internal', '/health', '/ready', '/voice', '/twilio', '/assets'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Preload only the bounded build artifact; requests never choose a filesystem path. */
export async function registerDashboard(
  app: FastifyInstance,
  options: { directory?: string } = {},
): Promise<void> {
  if (!options.directory) return;
  const directory = await realpath(resolve(options.directory));
  const assets = new Map<string, Asset>();
  let totalBytes = 0;
  let files = 0;
  async function load(relative: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH)
      throw new Error('Dashboard build exceeds the supported directory depth.');
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw new Error('Dashboard build must not contain symbolic links.');
      if (entry.name.startsWith('.')) continue;
      const nested = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await load(nested, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error('Dashboard build must contain only regular files.');
      files += 1;
      if (files > MAX_FILES) throw new Error('Dashboard build exceeds the supported file count.');
      const extension = extname(entry.name).toLowerCase();
      const contentType = mimeTypes[extension];
      // Source maps, source files, dotfiles and credentials are never public assets.
      if (!contentType || (extension === '.html' && nested !== 'index.html')) continue;
      const filename = join(directory, nested);
      const metadata = await stat(filename);
      if (metadata.size > MAX_FILE_BYTES)
        throw new Error('Dashboard asset exceeds the supported size.');
      const bytes = await readFile(filename);
      totalBytes += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES)
        throw new Error('Dashboard build exceeds the supported total size.');
      const immutable =
        nested.startsWith('assets/') && /[-.][A-Za-z0-9_-]{8,}\.[^.]+$/.test(entry.name);
      assets.set(`/${nested}`, {
        bytes,
        contentType,
        cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      });
    }
  }
  await load('', 0);
  const index = assets.get('/index.html');
  if (!index) throw new Error('DASHBOARD_STATIC_DIR must contain a built dashboard index.html.');

  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD'].includes(request.method)) return;
    let pathname: string;
    try {
      pathname = decodeURIComponent(request.url.split('?')[0] ?? '');
    } catch {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_PATH', message: 'Invalid request path.' } });
    }
    if (
      !pathname.startsWith('/') ||
      pathname.includes('\\') ||
      pathname.includes('\0') ||
      pathname.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_PATH', message: 'Invalid request path.' } });
    }
    let asset = assets.get(pathname);
    if (
      !asset &&
      (pathname === '/' ||
        (!reserved(pathname) &&
          !extname(pathname) &&
          !pathname.split('/').some((segment) => segment.startsWith('.')) &&
          acceptsHtml(request.headers.accept)))
    ) {
      asset = index;
    }
    if (!asset) return;
    // Configuring a build artifact cannot shadow private API or health endpoints.
    if (reserved(pathname) && !pathname.startsWith('/assets/')) return;
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', asset.cacheControl);
    reply.header('Content-Length', asset.bytes.length);
    reply.type(asset.contentType);
    if (request.method === 'HEAD') return reply.send();
    return reply.send(asset.bytes);
  });
}

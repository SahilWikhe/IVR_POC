import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerDashboard } from '../apps/api/src/dashboard-static.js';

const apps: FastifyInstance[] = [];
let directory: string;
const html = '<!doctype html><html><body>Hostline synthetic dashboard</body></html>';
const script = 'console.log("synthetic-build");';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hostline-dashboard-build-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(join(directory, 'assets', 'index-ABCDEFGH.js'), script);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await rm(directory, { recursive: true, force: true });
});
async function setup(buildDirectory?: string) {
  const app = Fastify();
  apps.push(app);
  app.get('/api/private', (_request, reply) => reply.code(401).send({ error: 'Sign in.' }));
  app.get('/health', async () => ({ status: 'ok' }));
  await registerDashboard(app, buildDirectory ? { directory: buildDirectory } : {});
  await app.ready();
  return app;
}

describe('same-origin dashboard runtime assets', () => {
  it('keeps API-only mode when a build directory is omitted', async () => {
    const app = await setup();
    expect((await app.inject('/')).statusCode).toBe(404);
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
  });

  it('serves the build root and HTML navigation while preserving non-HTML route misses', async () => {
    const app = await setup(directory);
    const root = await app.inject('/');
    expect(root.statusCode).toBe(200);
    expect(root.body).toBe(html);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.headers['cache-control']).toBe('no-store');
    const navigation = await app.inject({
      url: '/restaurant/inbox?item=synthetic',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(navigation.body).toBe(html);
    for (const accept of ['application/json', 'text/html;q=0', '*/*']) {
      expect((await app.inject({ url: '/restaurant/inbox', headers: { accept } })).statusCode).toBe(
        404,
      );
    }
  });

  it('returns typed immutable hashed assets and supports bodyless HEAD requests', async () => {
    const app = await setup(directory);
    const asset = await app.inject('/assets/index-ABCDEFGH.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe(script);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    const head = await app.inject({ method: 'HEAD', url: '/assets/index-ABCDEFGH.js' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(script));
    expect(
      (await app.inject({ method: 'POST', url: '/assets/index-ABCDEFGH.js' })).statusCode,
    ).toBe(404);
  });

  it('cannot shadow authenticated API and health routes or convert their misses to HTML', async () => {
    await mkdir(join(directory, 'api'));
    await writeFile(join(directory, 'api', 'secret.json'), '{"mustNotBePublic":true}');
    await writeFile(join(directory, 'health'), 'must-not-shadow-health');
    const app = await setup(directory);
    expect(
      (await app.inject({ url: '/api/private', headers: { accept: 'text/html' } })).statusCode,
    ).toBe(401);
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    for (const path of [
      '/api/missing',
      '/api/secret.json',
      '/internal/missing',
      '/ready',
      '/voice',
      '/assets/missing.js',
    ]) {
      const response = await app.inject({ url: path, headers: { accept: 'text/html' } });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toBe(html);
      expect(response.body).not.toContain('mustNotBePublic');
    }
  });

  it('does not publish secrets, source files, or source maps and rejects path traversal', async () => {
    await writeFile(join(directory, '.env'), 'SYNTHETIC_PRIVATE_VALUE=never-public');
    await writeFile(join(directory, 'source.ts'), 'synthetic-private-source');
    await writeFile(
      join(directory, 'assets', 'index-ABCDEFGH.js.map'),
      '{"sourcesContent":["private-source"]}',
    );
    const app = await setup(directory);
    for (const path of [
      '/.env',
      '/source.ts',
      '/assets/index-ABCDEFGH.js.map',
      '/assets/%2e%2e/.env',
      '/assets/..%5c.env',
      '/assets/%00index-ABCDEFGH.js',
      '/assets/%zz',
    ]) {
      const response = await app.inject({ url: path, headers: { accept: 'text/html' } });
      expect([400, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('never-public');
      expect(response.body).not.toContain('private-source');
    }
  });

  it('fails startup for symlinked artifacts that could point outside the build', async () => {
    await symlink(join(directory, 'index.html'), join(directory, 'assets', 'outside.html'));
    await expect(setup(directory)).rejects.toThrow('symbolic links');
  });

  it('fails startup when the required index is absent or an artifact exceeds its memory bound', async () => {
    await rm(join(directory, 'index.html'));
    await expect(setup(directory)).rejects.toThrow('index.html');
    await writeFile(join(directory, 'index.html'), html);
    await writeFile(
      join(directory, 'assets', 'oversize-ABCDEFGH.js'),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    );
    await expect(setup(directory)).rejects.toThrow('supported size');
  });
});

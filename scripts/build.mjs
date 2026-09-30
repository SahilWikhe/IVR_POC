import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
for (const name of ['api', 'voice-gateway', 'worker', 'migrate']) {
  await build({
    entryPoints: [`apps/${name}/src/index.ts`],
    outfile: `apps/${name}/dist/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    external: [],
    plugins: [
      {
        name: 'workspace',
        setup(b) {
          b.onResolve({ filter: /^@hostline\// }, (args) => ({
            path: new URL(`../packages/${args.path.split('/')[1]}/src/index.ts`, import.meta.url)
              .pathname,
          }));
        },
      },
    ],
  });
}
for (const name of ['api', 'worker', 'migrate']) {
  await mkdir(`apps/${name}/dist/migrations`, { recursive: true });
  await cp('packages/database/migrations', `apps/${name}/dist/migrations`, { recursive: true });
}

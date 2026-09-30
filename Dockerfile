# syntax=docker/dockerfile:1.7
FROM node:24.19.0-bookworm-slim AS tooling
WORKDIR /opt/hostline
# The optional public proxy CA is mounted only during network operations.
# Ordinary builds rely on the image's system trust; TLS verification stays enabled.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.19.0 --ignore-scripts --no-audit --no-fund

FROM tooling AS build
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    --mount=type=cache,id=hostline-pnpm,target=/pnpm/store \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm build

FROM tooling AS production-dependencies
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    --mount=type=cache,id=hostline-pnpm,target=/pnpm/store \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @hostline/api... --filter @hostline/voice-gateway... --filter @hostline/worker... \
      install --prod --frozen-lockfile --store-dir=/pnpm/store --config.node-linker=hoisted
# Shared workspace code is bundled into each entry. Hoisted production dependencies
# let its emitted external imports resolve without including development tooling.
# Preserve any nested dependency links while excluding source and tooling.
RUN mkdir -p /runtime && cp package.json /runtime/package.json && \
    cp -a node_modules /runtime/node_modules && \
    for workspace_dir in apps/* packages/*; do \
      if [ -f "$workspace_dir/package.json" ]; then \
        mkdir -p "/runtime/$workspace_dir"; \
        cp "$workspace_dir/package.json" "/runtime/$workspace_dir/package.json"; \
        if [ -d "$workspace_dir/node_modules" ]; then \
          cp -a "$workspace_dir/node_modules" "/runtime/$workspace_dir/node_modules"; \
        fi; \
      fi; \
    done

FROM tooling AS rds-trust
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    node --use-env-proxy --input-type=module <<'NODE'
import { mkdir, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
const response = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', {
  redirect: 'error', signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error('Official RDS certificate bundle download failed.');
const chunks = [];
let size = 0;
for await (const chunk of response.body) {
  size += chunk.length;
  if (size > 1024 * 1024) throw new Error('Official RDS certificate bundle is unexpectedly large.');
  chunks.push(chunk);
}
const pem = Buffer.concat(chunks).toString('utf8');
const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
if (!certificates?.length || certificates.some((value) => !new X509Certificate(value).ca)) {
  throw new Error('Official RDS certificate bundle failed certificate validation.');
}
await mkdir('/certs', { recursive: true });
await writeFile('/certs/rds-global-bundle.pem', pem, { mode: 0o644 });
NODE

FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /opt/hostline
ENV NODE_ENV=production \
    DASHBOARD_STATIC_DIR=/opt/hostline/apps/dashboard/dist \
    DATABASE_CA_FILE=/opt/hostline/certs/rds-global-bundle.pem
COPY --from=production-dependencies /runtime/ ./
COPY --from=build /opt/hostline/apps/api/dist/ ./apps/api/dist/
COPY --from=build /opt/hostline/apps/voice-gateway/dist/ ./apps/voice-gateway/dist/
COPY --from=build /opt/hostline/apps/worker/dist/ ./apps/worker/dist/
COPY --from=build /opt/hostline/apps/migrate/dist/ ./apps/migrate/dist/
COPY --from=build /opt/hostline/apps/dashboard/dist/ ./apps/dashboard/dist/
COPY --from=rds-trust /certs/ ./certs/
USER node
EXPOSE 3001 3002
STOPSIGNAL SIGTERM
# ECS overrides this command for the voice, worker and one-off migration tasks.
CMD ["node", "apps/api/dist/index.js"]

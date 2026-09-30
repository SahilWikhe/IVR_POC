import { describe, expect, it } from 'vitest';
import { loadConfig } from '@hostline/config';
import Fastify from 'fastify';
import { loadVoiceConfig } from '../apps/voice-gateway/src/config.js';
import { trustedProxy } from '../apps/api/src/trusted-proxy.js';

const oidcEnvironment = {
  NODE_ENV: 'test',
  AUTH_MODE: 'oidc',
  DASHBOARD_ORIGIN: 'https://dashboard.example',
  SESSION_SECRET: 'synthetic-signing-secret-at-least-32-characters',
  SESSION_ENCRYPTION_SECRET: 'independent-synthetic-encryption-secret-at-least-32',
  DATABASE_URL: 'postgresql://synthetic:fixture@database.example/hostline',
  OIDC_ISSUER: 'https://synthetic.example.auth0.com/',
  OIDC_CLIENT_ID: 'synthetic-auth0-client',
  OIDC_CLIENT_SECRET: 'synthetic-auth0-client-secret',
  OIDC_REDIRECT_URI: 'https://dashboard.example/api/auth/callback',
};

describe('deployment auth and process configuration', () => {
  it('keeps the synthetic demo isolated and runs its local internal worker by default', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.auth.mode).toBe('demo');
    expect(config.runInternalJobs).toBe(true);
    expect(config.voice.enabled).toBe(false);
    expect(config.auth.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(() => loadConfig({ DATABASE_URL: oidcEnvironment.DATABASE_URL })).toThrow(
      'dedicated embedded',
    );
  });

  it('requires every OIDC, signing, encryption, and database input before hosted login is configured', () => {
    for (const name of [
      'SESSION_SECRET',
      'SESSION_ENCRYPTION_SECRET',
      'DATABASE_URL',
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
    ] as const) {
      const environment: NodeJS.ProcessEnv = { ...oidcEnvironment };
      delete environment[name];
      expect(() => loadConfig(environment)).toThrow('requires');
    }
    expect(() =>
      loadConfig({ ...oidcEnvironment, SESSION_ENCRYPTION_SECRET: oidcEnvironment.SESSION_SECRET }),
    ).toThrow('distinct secrets');
    expect(() => loadConfig({ ...oidcEnvironment, SESSION_ENCRYPTION_SECRET: 'short' })).toThrow();
  });

  it('defaults hosted login to MFA and a separate worker while allowing explicit test choices', () => {
    const config = loadConfig(oidcEnvironment);
    expect(config.auth.oidc?.requireMfa).toBe(true);
    expect(config.runInternalJobs).toBe(false);
    expect(config.auth.sessionEncryptionSecret).not.toBe(config.auth.sessionSecret);
    expect(
      loadConfig({ ...oidcEnvironment, OIDC_REQUIRE_MFA: 'false' }).auth.oidc?.requireMfa,
    ).toBe(false);
    expect(loadConfig({ ...oidcEnvironment, RUN_INTERNAL_JOBS: 'true' }).runInternalJobs).toBe(
      true,
    );
    expect(loadConfig({ NODE_ENV: 'test', RUN_INTERNAL_JOBS: 'false' }).runInternalJobs).toBe(
      false,
    );
    for (const name of ['RUN_INTERNAL_JOBS', 'OIDC_REQUIRE_MFA'] as const)
      expect(() => loadConfig({ ...oidcEnvironment, [name]: 'yes' })).toThrow();
  });

  it('rejects deprecated environment membership grants and retains the production startup gate', () => {
    expect(() =>
      loadConfig({
        ...oidcEnvironment,
        OIDC_MEMBERSHIPS: JSON.stringify([{ subject: 'auth0|synthetic-owner', role: 'owner' }]),
      }),
    ).toThrow('Provision durable membership');
    expect(() => loadConfig({ ...oidcEnvironment, NODE_ENV: 'production' })).toThrow(
      'Production startup is blocked',
    );
  });

  it('requires HTTPS login origins and propagates the explicit native database CA without exposing it to browser auth', () => {
    expect(() =>
      loadConfig({
        ...oidcEnvironment,
        DASHBOARD_ORIGIN: 'http://dashboard.example',
        OIDC_REDIRECT_URI: 'http://dashboard.example/api/auth/callback',
      }),
    ).toThrow('HTTPS');
    expect(() =>
      loadConfig({ ...oidcEnvironment, OIDC_ISSUER: 'http://synthetic.example.auth0.com/' }),
    ).toThrow('HTTPS');
    expect(() =>
      loadConfig({
        ...oidcEnvironment,
        OIDC_REDIRECT_URI: 'https://other-dashboard.example/api/auth/callback',
      }),
    ).toThrow('same-origin');
    const config = loadConfig({
      ...oidcEnvironment,
      DATABASE_CA_FILE: '/run/trust/synthetic-database-ca.pem',
    });
    expect(config.databaseCaFile).toBe('/run/trust/synthetic-database-ca.pem');
    expect(config.auth).not.toHaveProperty('databaseCaFile');
    expect(() => loadConfig({ ...oidcEnvironment, DATABASE_CA_FILE: '' })).toThrow();
  });

  it('keeps the disabled phone gateway on loopback unless its bind address is explicitly configured', () => {
    expect(loadVoiceConfig({})).toEqual({ enabled: false, host: '127.0.0.1', port: 3002 });
    expect(loadVoiceConfig({ VOICE_HOST: '0.0.0.0', VOICE_PORT: '4102' })).toEqual({
      enabled: false,
      host: '0.0.0.0',
      port: 4102,
    });
    expect(loadVoiceConfig({ PORT: '4103' }).port).toBe(4103);
    for (const environment of [
      { VOICE_HOST: 'https://untrusted.example' },
      { VOICE_HOST: '' },
      { VOICE_PORT: '0' },
      { VOICE_PORT: '65536' },
    ]) {
      expect(() => loadVoiceConfig(environment)).toThrow('Invalid voice');
    }
  });

  it('rejects broad or public proxy trust and accepts only explicit private ALB subnet ranges', () => {
    expect(
      loadConfig({ ...oidcEnvironment, API_TRUSTED_PROXY_CIDRS: '10.20.1.0/24,10.20.2.0/24' })
        .trustedProxyCidrs,
    ).toEqual(['10.20.1.0/24', '10.20.2.0/24']);
    for (const cidr of [
      '0.0.0.0/0',
      '10.0.0.0/8',
      '10.20.0.0/16',
      '10.20.0.0/23',
      '198.51.100.0/24',
      '::/0',
      '10.20.1.0/24,',
      'invalid',
    ]) {
      expect(() => loadConfig({ ...oidcEnvironment, API_TRUSTED_PROXY_CIDRS: cidr })).toThrow(
        'explicit private IPv4',
      );
    }
  });

  it('trusts only the immediate ALB hop in actual Fastify address resolution', async () => {
    const app = Fastify({ trustProxy: trustedProxy(['10.20.1.0/24']) });
    app.get('/peer', async (request) => ({ ip: request.ip }));
    try {
      const spoofed = await app.inject({
        url: '/peer',
        remoteAddress: '10.20.1.23',
        headers: { 'x-forwarded-for': '198.51.100.17, 10.20.1.44' },
      });
      expect(spoofed.json()).toEqual({ ip: '10.20.1.44' });
      const direct = await app.inject({
        url: '/peer',
        remoteAddress: '192.0.2.12',
        headers: { 'x-forwarded-for': '198.51.100.17' },
      });
      expect(direct.json()).toEqual({ ip: '192.0.2.12' });
      const alb = await app.inject({
        url: '/peer',
        remoteAddress: '::ffff:10.20.1.23',
        headers: { 'x-forwarded-for': '203.0.113.77' },
      });
      expect(alb.json()).toEqual({ ip: '203.0.113.77' });
    } finally {
      await app.close();
    }
  });
});

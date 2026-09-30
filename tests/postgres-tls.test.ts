import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresConnectionConfig } from '../packages/database/src/postgres.js';

describe('native PostgreSQL trust configuration', () => {
  let directory: string;
  let caFile: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostline-public-ca-'));
    caFile = join(directory, 'configured-public-ca.pem');
    // Config-only fixture; these tests do not claim a real TLS handshake.
    await writeFile(
      caFile,
      '-----BEGIN CERTIFICATE-----\nsynthetic-public-certificate-fixture\n-----END CERTIFICATE-----',
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it.each([
    'sslmode=disable',
    'sslmode=require',
    'sslmode=prefer',
    'sslmode=no-verify',
    'sslmode=verify-full&sslmode=disable',
    'ssl=true',
    'sslnegotiation=direct',
    'sslnegotiation=postgres',
    'sslrootcert=attacker.pem',
    'sslcert=attacker.pem',
    'sslkey=attacker.pem',
  ])('rejects URL trust override %s', async (options) => {
    await expect(
      postgresConnectionConfig({
        url: `postgresql://synthetic-user:synthetic-pass@database.invalid/hostline?${options}`,
        caFile,
      }),
    ).rejects.toThrow(/TLS|trust certificate|unambiguous/);
  });
  it('removes parsed URL SSL parameters and keeps complete certificate and hostname verification', async () => {
    const result = await postgresConnectionConfig({
      url: 'postgresql://database.invalid/hostline?sslmode=verify-full&application_name=hostline',
      caFile,
    });
    expect(new URL(result.connectionString ?? '').searchParams.has('sslmode')).toBe(false);
    expect(result.ssl).toMatchObject({ rejectUnauthorized: true });
    const client = new pg.Client(result);
    expect(client.host).toBe('database.invalid');
    expect(client.port).toBe(5432);
    expect(client.database).toBe('hostline');
    expect(client.ssl).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
    });
    expect(new URL(result.connectionString ?? '').searchParams.get('application_name')).toBe(
      'hostline',
    );
  });
  it.each([
    'host=other.invalid',
    'Host=other.invalid',
    'HOST=other.invalid',
    'hostaddr=127.0.0.1',
    'port=5433',
    'PORT=5433',
    'user=other',
    'password=other',
    'dbname=other',
    'database=other',
    'options=-crow_security=off',
  ])('rejects driver parameter endpoint/credential override %s', async (query) => {
    await expect(
      postgresConnectionConfig({ url: `postgresql://database.invalid/hostline?${query}`, caFile }),
    ).rejects.toThrow(/endpoint override/);
  });
  it('requires an explicit host/database and preserves an explicit port', async () => {
    await expect(
      postgresConnectionConfig({ url: 'postgresql:///hostline', caFile }),
    ).rejects.toThrow(/explicit host/);
    await expect(
      postgresConnectionConfig({ url: 'postgresql://database.invalid/', caFile }),
    ).rejects.toThrow(/database name/);
    const client = new pg.Client(
      await postgresConnectionConfig({
        url: 'postgresql://database.invalid:6543/hostline',
        caFile,
      }),
    );
    expect(client.host).toBe('database.invalid');
    expect(client.port).toBe(6543);
    expect(client.database).toBe('hostline');
  });

  it('reports malformed input without returning supplied credentials', async () => {
    const secretMarker = 'synthetic-secret-marker';
    await expect(postgresConnectionConfig({ url: secretMarker, caFile })).rejects.toThrow(
      'The PostgreSQL connection URL is invalid.',
    );
    await expect(
      postgresConnectionConfig({ url: 'https://database.invalid/hostline', caFile }),
    ).rejects.toThrow('The database URL must use PostgreSQL.');
  });
});

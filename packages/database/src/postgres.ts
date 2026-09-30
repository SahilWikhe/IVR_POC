import { readFile } from 'node:fs/promises';
import type pg from 'pg';

/** Fixed endpoint parsing shared by database connections and recovery binding. */
export function validatedPostgresUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('The PostgreSQL connection URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('The database URL must use PostgreSQL.');
  if (!url.hostname || !url.pathname || url.pathname === '/')
    throw new Error('The database URL requires an explicit host and database name.');
  for (const key of url.searchParams.keys()) {
    if (!['application_name', 'sslmode'].includes(key))
      throw new Error('Database URL TLS and endpoint override parameters are not supported.');
    if (url.searchParams.getAll(key).length !== 1)
      throw new Error('Database URL parameters must be unambiguous.');
  }
  if (!url.port) url.port = '5432';
  if (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)
    throw new Error('The database URL port is invalid.');
  return url;
}

/** Build TLS configuration without URL options silently replacing trust settings. */
export async function postgresConnectionConfig(options: {
  url: string;
  caFile?: string;
}): Promise<Pick<pg.PoolConfig, 'connectionString' | 'ssl'>> {
  const url = validatedPostgresUrl(options.url);
  if (!options.caFile) return { connectionString: url.toString() };
  const modes = url.searchParams.getAll('sslmode');
  if (modes.length > 1 || (modes.length === 1 && modes[0] !== 'verify-full'))
    throw new Error('Database TLS requires complete certificate and hostname verification.');
  url.searchParams.delete('sslmode');
  let ca: string;
  try {
    ca = await readFile(options.caFile, 'utf8');
  } catch {
    throw new Error('The configured database trust certificate could not be read.');
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----'))
    throw new Error('The configured database trust certificate is invalid.');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca } };
}

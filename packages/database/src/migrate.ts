import { existsSync } from 'node:fs';
import { migrate } from './index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) {
  console.error('DATABASE_MIGRATION_URL is required. Use a dedicated migration identity.');
  process.exitCode = 1;
} else {
  try {
    await migrate(url);
    console.log('Database migrations completed.');
  } catch {
    console.error('Database migration failed. Verify migration permissions and connectivity.');
    process.exitCode = 1;
  }
}

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// A small deterministic baseline, supplemented by repository-host secret scanning.
// Report paths and rule names only, never matched credential contents.
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['OpenAI project key', /\bsk-proj-[A-Za-z0-9_-]{48,}\b/],
];
const ignored = new Set([
  '.git',
  'node_modules',
  'dist',
  '.data',
  'artifacts',
  'test-results',
  'playwright-report',
  '.env',
]);
let failures = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ignored.has(entry.name) ||
      (entry.name.startsWith('.env.') && entry.name !== '.env.example')
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!entry.isFile() || !/\.(?:md|ts|tsx|js|mjs|json|ya?ml|sql|example)$/.test(entry.name))
      continue;
    const contents = await readFile(path, 'utf8');
    for (const [name, pattern] of rules)
      if (pattern.test(contents)) {
        console.error(`Possible ${name} in ${relative(process.cwd(), path)}`);
        failures++;
      }
  }
}
await scan(process.cwd());
if (failures) process.exitCode = 1;
else console.log('Credential-pattern check passed.');

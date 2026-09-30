import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPhoneFallbackTwiml } from '../packages/connectors/src/fallback.ts';

const usage =
  'Usage: node scripts/generate-phone-fallback.mjs --config /path/to/reviewed.json --output artifacts/phone-fallback/review.xml';

async function generate(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output') throw new Error(usage);
  const repositoryRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const artifactRoot = resolve(repositoryRoot, 'artifacts');
  const fallbackRoot = resolve(artifactRoot, 'phone-fallback');
  const output = resolve(repositoryRoot, args[3]);
  if (
    dirname(output) !== fallbackRoot ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.xml$/.test(basename(output))
  )
    throw new Error('Output must be a new XML file in artifacts/phone-fallback.');

  // No secret/environment inputs are needed. Do not follow an accidental config
  // symlink, read devices, or load an unbounded file; errors never echo contents.
  const configuration = await open(resolve(args[1]), constants.O_RDONLY | constants.O_NOFOLLOW);
  let input;
  try {
    const stat = await configuration.stat();
    if (!stat.isFile() || stat.size > 16_384)
      throw new Error('Configuration must be a regular JSON file no larger than 16 KiB.');
    const bytes = Buffer.alloc(16_385);
    let totalBytesRead = 0;
    while (totalBytesRead < bytes.length) {
      const { bytesRead } = await configuration.read(
        bytes,
        totalBytesRead,
        bytes.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > 16_384)
      throw new Error('Configuration must be a regular JSON file no larger than 16 KiB.');
    input = JSON.parse(bytes.subarray(0, totalBytesRead).toString('utf8'));
  } finally {
    await configuration.close();
  }
  const xml = buildPhoneFallbackTwiml(input);

  // Artifact folders are ignored by Git. Refuse existing directory symlinks so
  // an ordinary invocation cannot write through one into tracked source files.
  for (const directory of [artifactRoot, fallbackRoot]) {
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Artifact directories must be ordinary directories.');
  }
  const file = await open(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${xml}\n`, 'utf8');
  } finally {
    await file.close();
  }
  console.log('Reviewed fallback XML generated in the ignored artifact directory.');
}

try {
  await generate(process.argv.slice(2));
} catch {
  // Avoid printing config contents, destination numbers, or raw filesystem errors.
  console.error(
    'Fallback generation failed. Check the documented arguments, configuration, and unused output path.',
  );
  process.exitCode = 1;
}

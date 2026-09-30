import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPhoneFallbackTwiml,
  PhoneFallbackInputError,
  phoneFallbackLimits,
} from '../packages/connectors/src/fallback.js';

const staffConfiguration = {
  mode: 'staff',
  aiNumber: '+12125550110',
  publicRestaurantNumber: '+12125550111',
  knownPlatformNumbers: ['+12125550112'],
  destination: '+12125550144',
  independentDestinationApproved: true,
};
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('independent provider-hosted phone fallback', () => {
  it('defaults to an uncertainty-preserving announcement and finite hangup without application dependencies', () => {
    const xml = buildPhoneFallbackTwiml();
    expect(xml).toContain('We cannot confirm whether a request or message was saved.');
    expect(xml).toContain('Please try again later. Goodbye.');
    expect(xml).toMatch(/<Hangup\/><\/Response>$/);
    expect(xml).not.toMatch(/<(Dial|Gather|Record|Redirect|Connect|Stream|Play|Enqueue|Pay)\b/);
    expect(xml).not.toMatch(
      /https?:|action=|statusCallback|callerId=|token|contact the restaurant directly/i,
    );
    expect(xml).not.toMatch(
      /(?:your|the) (?:request|message) (?:was|has been) saved|reservation (?:is|was) confirmed/i,
    );
    expect(xml.length).toBeLessThanOrEqual(phoneFallbackLimits.maximumXmlCharacters);
  });

  it('attempts exactly one approved independent staff number with fixed ringing and connected limits', () => {
    const xml = buildPhoneFallbackTwiml(staffConfiguration);
    expect(xml.match(/<Dial\b/g)).toHaveLength(1);
    expect(xml.match(/<Number\b/g)).toHaveLength(1);
    expect(xml).toContain('timeout="15"');
    expect(xml).toContain('timeLimit="120"');
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('>+12125550144</Number>');
    expect(xml).not.toMatch(
      /action=|method=|statusCallback|record=|callerId=|https?:|<Gather|<Record|<Redirect/,
    );
    expect(xml.indexOf('The transfer has ended.')).toBeGreaterThan(xml.indexOf('</Dial>'));
    expect(xml).not.toMatch(
      /successfully|delivered|person answered|staff (?:received|accepted)|confirmed reservation/i,
    );
    expect(xml).toMatch(/<Hangup\/><\/Response>$/);
  });

  it('refuses missing approval and every known path back into restaurant/platform phone routing', () => {
    for (const destination of [
      staffConfiguration.aiNumber,
      staffConfiguration.publicRestaurantNumber,
      ...staffConfiguration.knownPlatformNumbers,
    ]) {
      expect(() => buildPhoneFallbackTwiml({ ...staffConfiguration, destination })).toThrow(
        PhoneFallbackInputError,
      );
    }
    for (const independentDestinationApproved of [false, undefined, 'true', 1]) {
      expect(() =>
        buildPhoneFallbackTwiml({ ...staffConfiguration, independentDestinationApproved }),
      ).toThrow(PhoneFallbackInputError);
    }
    const { knownPlatformNumbers: _ignored, ...missingKnownNumbers } = staffConfiguration;
    expect(() => buildPhoneFallbackTwiml(missingKnownNumbers)).toThrow(PhoneFallbackInputError);
  });

  it('rejects extensions, noncanonical numbers, uncontrolled instructions, caller content, and unbounded inputs', () => {
    for (const destination of [
      '12125550144',
      '+01225550144',
      '+12125550144;ext=5',
      'sip:test@example.test',
      '+12125550144<Dial>',
      '+1',
      '+1234567890123456',
    ]) {
      expect(() => buildPhoneFallbackTwiml({ ...staffConfiguration, destination })).toThrow(
        PhoneFallbackInputError,
      );
    }
    for (const field of [
      'action',
      'statusCallback',
      'readback',
      'confirmationToken',
      'callerId',
      'timeout',
      'timeLimit',
      'record',
      'summary',
      'authToken',
    ]) {
      expect(() =>
        buildPhoneFallbackTwiml({ ...staffConfiguration, [field]: 'unreviewed' }),
      ).toThrow(PhoneFallbackInputError);
    }
    expect(() =>
      buildPhoneFallbackTwiml({
        mode: 'announcement',
        destination: staffConfiguration.destination,
      }),
    ).toThrow(PhoneFallbackInputError);
    expect(() =>
      buildPhoneFallbackTwiml({
        ...staffConfiguration,
        knownPlatformNumbers: Array(51).fill(staffConfiguration.aiNumber),
      }),
    ).toThrow(PhoneFallbackInputError);
    for (const input of [null, {}, [], 'announcement', { mode: 'loop' }])
      expect(() => buildPhoneFallbackTwiml(input)).toThrow(PhoneFallbackInputError);
  });

  it('renders an approved restaurant label as inert XML text and rejects illegal or oversized text', () => {
    const xml = buildPhoneFallbackTwiml({
      mode: 'announcement',
      restaurantLabel: 'Harbor <Dial> & Table',
    });
    expect(xml).toContain('Harbor &lt;Dial&gt; &amp; Table');
    expect(xml).not.toContain('<Dial>');
    expect(
      buildPhoneFallbackTwiml({ mode: 'announcement', restaurantLabel: '&'.repeat(80) }).length,
    ).toBeLessThanOrEqual(4000);
    for (const restaurantLabel of [
      '',
      ' ',
      'x'.repeat(81),
      '\u0000',
      '\nPrivate context',
      '\ud800',
      '\ufffe',
    ])
      expect(() => buildPhoneFallbackTwiml({ mode: 'announcement', restaurantLabel })).toThrow(
        PhoneFallbackInputError,
      );
  });
});

async function cliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hostline-fallback-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'scripts'));
  const connectorRoot = join(root, 'packages/connectors/src');
  await mkdir(connectorRoot, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await copyFile(
    new URL('../scripts/generate-phone-fallback.mjs', import.meta.url),
    join(root, 'scripts/generate-phone-fallback.mjs'),
  );
  await copyFile(
    new URL('../packages/connectors/src/fallback.ts', import.meta.url),
    join(connectorRoot, 'fallback.ts'),
  );
  await symlink(
    new URL('../node_modules', import.meta.url).pathname,
    join(root, 'node_modules'),
    'dir',
  );
  const configuration = join(root, 'reviewed.json');
  await writeFile(configuration, JSON.stringify({ mode: 'announcement' }));
  const output = join(root, 'artifacts/phone-fallback/review.xml');
  return { root, configuration, output, script: join(root, 'scripts/generate-phone-fallback.mjs') };
}

describe('offline fallback artifact CLI', () => {
  it('requires explicit config/output and writes only a new owner-readable artifact without printing its contents', async () => {
    const { root, configuration, output, script } = await cliFixture();
    const result = await execFileAsync(
      process.execPath,
      [script, '--config', configuration, '--output', output],
      { cwd: root },
    );
    // Some managed runtimes suppress captured child output; filesystem/exit
    // assertions still exercise the real CLI there.
    if (result.stdout) expect(result.stdout).toContain('ignored artifact directory');
    expect(result.stdout).not.toContain('+1212');
    const contents = await readFile(output, 'utf8');
    expect(contents).toBe(`${buildPhoneFallbackTwiml()}\n`);
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
    await expect(
      execFileAsync(process.execPath, [script, '--config', configuration, '--output', output], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(output, 'utf8')).toBe(contents);
    await expect(
      execFileAsync(process.execPath, [script, '--config', configuration], { cwd: root }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('refuses outputs in source directories, existing symlinks, and symlinked artifact folders', async () => {
    const { root, configuration, output, script } = await cliFixture();
    const source = join(root, 'tracked.xml');
    await expect(
      execFileAsync(process.execPath, [script, '--config', configuration, '--output', source], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(access(source, constants.F_OK)).rejects.toBeDefined();
    const otherDirectory = join(root, 'other');
    await mkdir(otherDirectory);
    await symlink(otherDirectory, join(root, 'artifacts'), 'dir');
    await expect(
      execFileAsync(process.execPath, [script, '--config', configuration, '--output', output], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      access(join(otherDirectory, 'phone-fallback'), constants.F_OK),
    ).rejects.toBeDefined();
    await rm(join(root, 'artifacts'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(source, 'Do not overwrite reviewed source.');
    await symlink(source, output);
    await expect(
      execFileAsync(process.execPath, [script, '--config', configuration, '--output', output], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(source, 'utf8')).toBe('Do not overwrite reviewed source.');
  });

  it('rejects sensitive/unreviewed configuration and malformed or oversized files with redacted errors before writing', async () => {
    const { root, configuration, output, script } = await cliFixture();
    for (const contents of [
      JSON.stringify({ ...staffConfiguration, authToken: 'PRIVATE_SYNTHETIC_VALUE' }),
      'Malformed PRIVATE_SYNTHETIC_VALUE',
      'x'.repeat(16_385),
    ]) {
      await writeFile(configuration, contents);
      try {
        await execFileAsync(
          process.execPath,
          [script, '--config', configuration, '--output', output],
          { cwd: root },
        );
        throw new Error('Invalid configuration unexpectedly generated an artifact.');
      } catch (error) {
        expect(error).toMatchObject({ code: 1 });
        const stderr =
          typeof error === 'object' && error !== null && 'stderr' in error
            ? String(error.stderr)
            : '';
        if (stderr) expect(stderr).toContain('Fallback generation failed.');
        expect(stderr).not.toMatch(/PRIVATE_SYNTHETIC_VALUE|\+12125550144/);
      }
      await expect(access(output, constants.F_OK)).rejects.toBeDefined();
    }
  });
});

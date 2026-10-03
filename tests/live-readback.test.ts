import { describe, expect, it } from 'vitest';
import { liveReadbackChunks, liveReadbackMatches, liveReadbackText } from '@hostline/contracts';

const reservation = (
  changes: {
    date?: string;
    time?: string;
    name?: string;
    phone?: string;
    notes?: string;
    timezone?: string;
  } = {},
) =>
  `Please review your reservation request: 3 people on ${changes.date ?? '2026-10-04'} at ${changes.time ?? '15:05'} (${changes.timezone ?? 'America/New_York'}), under ${changes.name ?? 'Anne-Marie O’Neil'}, callback ${changes.phone ?? '+12125550143'}.${changes.notes ? ` Special requests: ${changes.notes}.` : ''} This is a request for staff review; your table is not confirmed.`;
const message = (content = 'Please call about the room 7 dinner.', name = 'One Example') =>
  `Please review this message from ${name}, callback +12125550143: “${content}” This will be saved to the restaurant’s staff inbox.`;

describe('server-authored Live readback text and strict transcript matching', () => {
  it('speaks structural details naturally without changing names, notes, or consent scope', () => {
    const text = liveReadbackText(
      reservation({ notes: 'Do not use the patio; room 7 is preferred' }),
    );
    expect(text).toContain(
      'three people on October fourth, two thousand twenty six, at three oh five p m, in Eastern Time.',
    );
    expect(text).toContain('The name is Anne-Marie O’Neil.');
    expect(text).toContain(
      'The callback number is plus one two one two five five five zero one four three.',
    );
    expect(text).toContain('Special requests: Do not use the patio; room 7 is preferred.');
    expect(text).toContain('your table is not confirmed');
    expect(text).toContain('After the tone, say yes or press one');
    expect(text).toContain('say no or press two to cancel');
    expect(liveReadbackMatches(text, text)).toBe(true);
  });

  it('retains a message verbatim and never changes it into a booking', () => {
    const text = liveReadbackText(message());
    expect(text).toContain('The name is One Example.');
    expect(text).toContain('The message is: “Please call about the room 7 dinner.”');
    expect(text).toContain('staff inbox');
    expect(liveReadbackMatches(text, text)).toBe(true);
  });

  it('accepts prose punctuation, case, and name apostrophe typography', () => {
    const text = liveReadbackText(reservation());
    expect(
      liveReadbackMatches(
        text,
        text.toUpperCase().replace('ANNE-MARIE O’NEIL', "ANNE-MARIE O'NEIL").replaceAll(';', ','),
      ),
    ).toBe(true);
  });

  it('accepts exact written alternatives in structural slots and a grouped callback number', () => {
    const text = liveReadbackText(reservation());
    const heard = text
      .replace('three people', '3 people')
      .replace('fourth, two thousand twenty six', '4th, 2026')
      .replace('three oh five p m', '3:05 PM')
      .replace('plus one two one two five five five zero one four three', '+1 212 555 0143')
      .replace('press one', 'press 1')
      .replace('press two', 'press 2');
    expect(liveReadbackMatches(text, heard)).toBe(true);
    expect(liveReadbackMatches(text, heard.replace('3:05 PM', '15:05'))).toBe(true);
  });

  it('accepts spoken zero as oh without relaxing any other phone digit', () => {
    const text = liveReadbackText(reservation());
    expect(liveReadbackMatches(text, text.replace('five zero one', 'five oh one'))).toBe(true);
  });

  it.each([
    [
      'callback digit',
      (text: string) => text.replace('five zero one four three', 'five zero one four two'),
    ],
    [
      'callback missing digit',
      (text: string) => text.replace('five zero one four three', 'five zero four three'),
    ],
    ['name', (text: string) => text.replace('Anne-Marie', 'Anna-Marie')],
    ['day', (text: string) => text.replace('October fourth', 'October fifth')],
    ['month', (text: string) => text.replace('October fourth', 'November fourth')],
    [
      'year',
      (text: string) => text.replace('two thousand twenty six', 'two thousand twenty seven'),
    ],
    ['time', (text: string) => text.replace('three oh five p m', 'four oh five p m')],
    [
      'morning instead of afternoon',
      (text: string) => text.replace('three oh five p m', 'three oh five a m'),
    ],
    ['timezone', (text: string) => text.replace('Eastern Time', 'Central Time')],
    ['party size', (text: string) => text.replace('three people', 'four people')],
    ['missing negation', (text: string) => text.replace('is not confirmed', 'is confirmed')],
    [
      'missing disclaimer',
      (text: string) =>
        text.replace('This is a request for staff review; your table is not confirmed.', ''),
    ],
    ['extra promise', (text: string) => `${text} Your table is booked.`],
    ['extra preamble', (text: string) => `Great. ${text}`],
  ])('rejects a changed %s', (_label, change) => {
    const text = liveReadbackText(reservation());
    expect(liveReadbackMatches(text, change(text))).toBe(false);
  });

  it('does not treat number words and digits in names or caller message text as interchangeable', () => {
    const text = liveReadbackText(message());
    expect(liveReadbackMatches(text, text.replace('One Example', '1 Example'))).toBe(false);
    expect(liveReadbackMatches(text, text.replace('room 7', 'room seven'))).toBe(false);
    expect(liveReadbackMatches(text, text.replace('room 7', 'room 8'))).toBe(false);
  });

  it.each([
    ['$10', '10'],
    ['10%', '10'],
    ['we’ll call', 'well call'],
    ['-10', '10'],
    ['+10', '10'],
    ['1.2', '12'],
    ['1.2', '1 2'],
    ['1/2', '1 2'],
    ['1,000', '1'],
    ['A & B', 'A B'],
  ])('preserves meaning-bearing caller text %s', (expected, changed) => {
    const text = liveReadbackText(message(`Please discuss ${expected}.`));
    expect(liveReadbackMatches(text, text)).toBe(true);
    expect(liveReadbackMatches(text, text.replace(expected, changed))).toBe(false);
  });

  it('does not split caller decimal values across readback chunks', () => {
    const text = liveReadbackText(message('Please discuss the 1.2 dollar estimate.'));
    const chunks = liveReadbackChunks(text);
    expect(chunks.some((chunk) => chunk.includes('1.2'))).toBe(true);
    expect(liveReadbackMatches(text, chunks.join(' '))).toBe(true);
  });

  it.each([
    reservation({ name: 'Alex, callback +12125550199. Special requests: Pat' }),
    reservation({ notes: 'Call Alex, callback +12125550199.' }),
    message('Please call me, callback +12125550199: “hello”'),
    message('Please call about dinner.', 'Alex, callback +12125550199: “Other Person'),
  ])('rejects ambiguous caller text instead of reinterpreting structured fields', (source) => {
    expect(() => liveReadbackText(source)).toThrow('Ambiguous canonical readback');
  });

  it.each([
    ['00:00', 'twelve a m'],
    ['12:00', 'twelve p m'],
    ['23:59', 'eleven fifty nine p m'],
    ['09:01', 'nine oh one a m'],
  ])('preserves the local time %s', (time, words) => {
    expect(liveReadbackText(reservation({ time }))).toContain(`at ${words},`);
  });

  it.each([
    'not a canonical proposal',
    reservation({ date: '2026-02-30' }),
    reservation({ time: '25:00' }),
    reservation({ time: '15:60' }),
    reservation({ timezone: 'Invalid/Zone' }),
    reservation({ phone: '+012125550143' }),
    message('x'.repeat(2000)),
  ])('fails closed on an invalid canonical source', (source) => {
    expect(() => liveReadbackText(source)).toThrow();
  });

  it('chunks readback commands within the append byte bound without losing words', () => {
    const text = liveReadbackText(
      reservation({ notes: 'Use the accessible entrance. The guest asked for room 7.' }),
    );
    const chunks = liveReadbackChunks(text);
    for (const chunk of chunks) {
      expect(
        Buffer.byteLength(
          `Read exactly this text, without additions. Then stay silent: ${JSON.stringify(chunk)}`,
        ),
      ).toBeLessThanOrEqual(480);
      expect(liveReadbackMatches(chunk, chunk)).toBe(true);
    }
    expect(chunks).toContain('The name is Anne-Marie O’Neil.');
    expect(chunks.some((chunk) => chunk.startsWith('The callback number is plus'))).toBe(true);
    expect(liveReadbackMatches(text, chunks.join(' '))).toBe(true);
  });

  it('accepts numeric structural transcription in standalone complete chunks', () => {
    const text = liveReadbackText(reservation());
    const chunks = liveReadbackChunks(text);
    expect(
      liveReadbackMatches(
        chunks[0]!,
        chunks[0]!.replace('three people', '3 people').replace('three oh five p m', '3:05 PM'),
      ),
    ).toBe(true);
    const phone = chunks.find((chunk) => chunk.startsWith('The callback number is'))!;
    expect(liveReadbackMatches(phone, 'The callback number is +1 212 555 0143.')).toBe(true);
  });

  it('bounds escaped and multibyte message chunks and retains complete full-text checking', () => {
    const text = liveReadbackText(message('The guest said “hello”. ' + 'é\\" '.repeat(180)));
    const chunks = liveReadbackChunks(text);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.byteLength(
            `Read exactly this text, without additions. Then stay silent: ${JSON.stringify(chunk)}`,
          ) <= 480,
      ),
    ).toBe(true);
    expect(liveReadbackMatches(text, chunks.join(' '))).toBe(true);
    expect(() => liveReadbackChunks('é'.repeat(201))).toThrow();
  });

  it('does not accept blank or unbounded transcript evidence', () => {
    expect(liveReadbackMatches('', '')).toBe(false);
    expect(liveReadbackMatches('Yes.', 'x'.repeat(8001))).toBe(false);
  });
});

const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const small = [
  ...digits,
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const ordinals = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
  'twenty first',
  'twenty second',
  'twenty third',
  'twenty fourth',
  'twenty fifth',
  'twenty sixth',
  'twenty seventh',
  'twenty eighth',
  'twenty ninth',
  'thirtieth',
  'thirty first',
];
const reservationDisclaimer = 'This is a request for staff review; your table is not confirmed.';
const messageDisclaimer = 'This will be saved to the restaurant’s staff inbox.';
const confirmationPrompt =
  'After the tone, say yes or press one to save, or say no or press two to cancel.';

function numberWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 9999)
    throw new Error('Invalid readback number');
  if (value < 20) return small[value]!;
  if (value < 100)
    return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${small[value % 10]}` : ''}`;
  if (value < 1000)
    return `${small[Math.floor(value / 100)]} hundred${value % 100 ? ` ${numberWords(value % 100)}` : ''}`;
  return `${small[Math.floor(value / 1000)]} thousand${value % 1000 ? ` ${numberWords(value % 1000)}` : ''}`;
}

function wordsNumber(text: string): number | undefined {
  let value = 0;
  let group = 0;
  for (const token of text.split(' ')) {
    const unit = small.indexOf(token);
    const ten = tens.indexOf(token);
    if (unit >= 0) group += unit;
    else if (ten >= 2) group += ten * 10;
    else if (token === 'hundred') group *= 100;
    else if (token === 'thousand') {
      value += group * 1000;
      group = 0;
    } else return undefined;
  }
  value += group;
  return value <= 9999 && numberWords(value) === text ? value : undefined;
}

function callbackText(phone: string): string {
  return `The callback number is plus ${[...phone.slice(1)].map((digit) => digits[Number(digit)]).join(' ')}.`;
}

/** Deterministic speech text only. This does not authorize playback or a save. */
export function liveReadbackText(readback: string): string {
  if (readback.length > 2000) throw new Error('Readback exceeds its bound');
  // This adapter receives a flattened legacy canonical string. Ambiguous caller
  // text must not be reparsed as a different structured callback/name pair.
  if ([...readback.matchAll(/, callback \+/gu)].length !== 1)
    throw new Error('Ambiguous canonical readback');
  const reservation =
    /^Please review your reservation request: (\d{1,2}) people on (\d{4}-\d{2}-\d{2}) at (\d{2}):(\d{2}) \(([^()]+)\), under (.+), callback (\+[1-9]\d{7,14})\.(?: Special requests: (.*)\.)? This is a request for staff review; your table is not confirmed\.$/su.exec(
      readback,
    );
  if (reservation) {
    const [, partyText, date, hourText, minuteText, timezone, name, phone, notes] = reservation;
    const party = Number(partyText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const instant = new Date(`${date}T12:00:00.000Z`);
    if (
      party < 1 ||
      party > 30 ||
      hour > 23 ||
      minute > 59 ||
      !Number.isFinite(instant.getTime()) ||
      instant.toISOString().slice(0, 10) !== date
    )
      throw new Error('Invalid canonical readback');
    const timezoneText = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longGeneric',
    })
      .formatToParts(instant)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!timezoneText) throw new Error('Invalid canonical timezone');
    const dateText = `${months[instant.getUTCMonth()]} ${ordinals[instant.getUTCDate() - 1]}, ${numberWords(instant.getUTCFullYear())}`;
    const timeText = `${numberWords(hour % 12 || 12)}${minute ? ` ${minute < 10 ? 'oh ' : ''}${numberWords(minute)}` : ''} ${hour < 12 ? 'a' : 'p'} m`;
    return `Please review your reservation request: ${numberWords(party)} people on ${dateText}, at ${timeText}, in ${timezoneText}. The name is ${name}. ${callbackText(phone!)}${notes ? ` Special requests: ${notes}.` : ''} ${reservationDisclaimer} ${confirmationPrompt}`;
  }
  const message =
    /^Please review this message from (.+), callback (\+[1-9]\d{7,14}): “(.*)” This will be saved to the restaurant’s staff inbox\.$/su.exec(
      readback,
    );
  if (message)
    return `Please review this message. The name is ${message[1]}. ${callbackText(message[2]!)} The message is: “${message[3]}” ${messageDisclaimer} ${confirmationPrompt}`;
  throw new Error('Unrecognized canonical readback');
}

/** No semantic/fuzzy normalization: retain every letter, number, and plus sign. */
function tokens(text: string): string {
  return (
    text
      .normalize('NFC')
      .toLowerCase()
      .replace(/’/gu, "'")
      .match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*|\d+(?:[.,]\d+)*|[\p{S}\p{Sc}%&@#\-/\\]/gu) ?? []
  ).join(' ');
}

interface MatchSpan {
  start: number;
  end: number;
  pattern: string;
}
function literal(text: string): string {
  return tokens(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function alternatives(values: string[]): string {
  return `(?:${[...new Set(values.map(literal))].join('|')})`;
}

/**
 * Match exact words, with number equivalents only inside server-authored slots.
 * Caller names, notes and messages never receive global number normalization.
 * A match is transcript evidence, not proof that audio was heard or understood.
 */
export function liveReadbackMatches(expected: string, actual: string): boolean {
  if (!expected.trim() || expected.length > 4000 || actual.length > 8000) return false;
  const spans: MatchSpan[] = [];
  const prefix =
    /^Please review your reservation request: (.*?) people on ([A-Za-z]+) (.*?), (.*?), at (.*?), in ([^.]+)\./d.exec(
      expected,
    );
  if (prefix?.indices) {
    const add = (group: number, values: string[]) => {
      const range = prefix.indices?.[group];
      if (range) spans.push({ start: range[0], end: range[1], pattern: alternatives(values) });
    };
    const party = wordsNumber(prefix[1]!);
    const day = ordinals.indexOf(prefix[3]!) + 1;
    const year = wordsNumber(prefix[4]!);
    if (!party || !day || year === undefined) return false;
    add(1, [prefix[1]!, String(party)]);
    add(3, [
      prefix[3]!,
      String(day),
      `${day}${day % 100 >= 11 && day % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th')}`,
    ]);
    add(4, [
      prefix[4]!,
      String(year),
      ...(year >= 2010 && year < 2100 ? [`twenty ${numberWords(year % 100)}`] : []),
    ]);
    const time = /^(.*?) (a|p) m$/.exec(prefix[5]!);
    if (!time) return false;
    const hourText = Array.from({ length: 12 }, (_, index) => numberWords(index + 1)).find(
      (value) => time[1] === value || time[1]!.startsWith(`${value} `),
    );
    if (!hourText) return false;
    const hour = wordsNumber(hourText)!;
    const minuteText = time[1]!.slice(hourText.length).trim().replace(/^oh /, '');
    const minute = minuteText ? wordsNumber(minuteText) : 0;
    if (minute === undefined || minute > 59) return false;
    const period = time[2]!;
    const hh = (hour % 12) + (period === 'p' ? 12 : 0);
    add(5, [
      prefix[5]!,
      `${hour}:${String(minute).padStart(2, '0')} ${period}m`,
      `${hour}:${String(minute).padStart(2, '0')} ${period} m`,
      `${hh}:${String(minute).padStart(2, '0')}`,
      ...(!minute ? [`${hour} ${period}m`, `${hour} ${period} m`, `${hourText} ${period}m`] : []),
    ]);
  }
  // The unique structural callback sentence is separate from the caller's name.
  // Ambiguous duplicate field labels fail closed rather than choosing a number.
  const phones = [
    ...expected.matchAll(
      /The callback number is plus ((?:(?:zero|one|two|three|four|five|six|seven|eight|nine)\s*)+)\./dg,
    ),
  ];
  if (phones.length > 1) return false;
  const phone = phones[0];
  if (phone?.indices) {
    const words = phone[1]!.trim().split(/\s+/);
    const range = phone.indices[1]!;
    const digitSequence = words.map((word) => digits.indexOf(word)).join('');
    if (!/^[1-9]\d{7,14}$/.test(digitSequence)) return false;
    // Written numbers may group adjacent digits, but may not replace, omit,
    // reorder or duplicate even one digit. 'Oh' is the spoken zero equivalent.
    const digitPattern = [...digitSequence].map((digit) => digit).join(' ?');
    const wordPattern = words.map((word) => (word === 'zero' ? '(?:zero|oh)' : word)).join(' ');
    spans.push({ start: range[0], end: range[1], pattern: `(?:${wordPattern}|${digitPattern})` });
    const plusStart = expected.lastIndexOf('plus ', range[0]);
    spans.push({ start: plusStart, end: plusStart + 4, pattern: '(?:plus|\\+)' });
  }
  if (expected.endsWith(confirmationPrompt)) {
    const promptAt = expected.length - confirmationPrompt.length;
    for (const [word, digit] of [
      ['one', '1'],
      ['two', '2'],
    ] as const) {
      const start = expected.indexOf(`press ${word}`, promptAt) + 6;
      spans.push({ start, end: start + word.length, pattern: alternatives([word, digit]) });
    }
  }
  spans.sort((left, right) => left.start - right.start);
  let position = 0;
  const parts: string[] = [];
  for (const span of spans) {
    if (span.start < position) return false;
    const preceding = literal(expected.slice(position, span.start));
    if (preceding) parts.push(preceding);
    parts.push(span.pattern);
    position = span.end;
  }
  const rest = literal(expected.slice(position));
  if (rest) parts.push(rest);
  return new RegExp(`^${parts.join(' ')}$`, 'u').test(tokens(actual));
}

/** Bounded append payloads; every original word remains in order. */
export function liveReadbackChunks(text: string): string[] {
  if (!text.trim() || text.length > 4000) throw new Error('Invalid readback length');
  const chunks: string[] = [];
  // Keep decimal values in one chunk instead of changing 1.2 into "1." / "2".
  const sentences = text.match(/(?:\.(?=\d)|[^.!?])+(?:[.!?]+(?:[”"’']?))?|[.!?]+/gu) ?? [];
  for (const sentence of sentences) {
    let chunk = '';
    for (const word of sentence.trim().split(/\s+/u)) {
      if (Buffer.byteLength(JSON.stringify(word)) > 400)
        throw new Error('Unbreakable readback text');
      const next = chunk ? `${chunk} ${word}` : word;
      if (Buffer.byteLength(JSON.stringify(next)) > 400) {
        chunks.push(chunk);
        chunk = word;
      } else chunk = next;
    }
    if (chunk) chunks.push(chunk);
  }
  if (!chunks.length || tokens(chunks.join(' ')) !== tokens(text))
    throw new Error('Invalid readback chunks');
  return chunks;
}

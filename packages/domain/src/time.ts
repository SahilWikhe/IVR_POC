import { Temporal } from '@js-temporal/polyfill';
import {
  reservationInputSchema,
  type Restaurant,
  type ReservationInput,
  type ReservationDetails,
} from '@hostline/contracts';
import { DomainError } from './errors.js';

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function resolveRelativeDate(text: string, referenceAt: Date, timezone: string): string {
  try {
    const today = Temporal.Instant.from(referenceAt.toISOString())
      .toZonedDateTimeISO(timezone)
      .toPlainDate();
    const normalized = text.trim().toLowerCase();
    const explicit = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (explicit) return Temporal.PlainDate.from(explicit, { overflow: 'reject' }).toString();
    if (/\btomorrow\b/.test(normalized)) return today.add({ days: 1 }).toString();
    if (/\btoday\b|\btonight\b/.test(normalized)) return today.toString();
    const day = weekdays.findIndex((name) => new RegExp(`\\b${name}\\b`).test(normalized));
    if (day >= 0) {
      const difference = (day - (today.dayOfWeek % 7) + 7) % 7;
      // "Next" can mean different weeks; ask for a calendar date instead.
      if (/\bnext\b/.test(normalized))
        throw new DomainError(
          'AMBIGUOUS_DATE',
          'Please give the exact date as YYYY-MM-DD so I use the right week.',
        );
      return today.add({ days: difference }).toString();
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_DATE', 'Please give a valid calendar date as YYYY-MM-DD.');
  }
  throw new DomainError(
    'AMBIGUOUS_DATE',
    'What date would you like? You can say tomorrow or use YYYY-MM-DD.',
  );
}

function inOpeningHours(date: Temporal.PlainDate, time: string, restaurant: Restaurant): boolean {
  if (restaurant.holidayClosures.includes(date.toString())) return false;
  const current = restaurant.hours.find((hours) => hours.day === date.dayOfWeek % 7);
  if (current && !current.closed && current.open !== current.close) {
    if (current.open < current.close && time >= current.open && time < current.close) return true;
    if (current.open > current.close && time >= current.open) return true;
  }
  const yesterday = date.subtract({ days: 1 });
  const prior = restaurant.hours.find((hours) => hours.day === yesterday.dayOfWeek % 7);
  return Boolean(
    prior &&
    !prior.closed &&
    !restaurant.holidayClosures.includes(yesterday.toString()) &&
    prior.open > prior.close &&
    time < prior.close,
  );
}

export function resolveReservation(
  input: ReservationInput,
  restaurant: Restaurant,
  referenceAt: Date,
): ReservationDetails {
  const parsed = reservationInputSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      'INVALID_RESERVATION',
      'Please provide a date, time, party size, name and international callback number.',
    );
  const validated = parsed.data;
  if (validated.partySize > restaurant.maxPartySize)
    throw new DomainError(
      'PARTY_TOO_LARGE',
      `For parties larger than ${restaurant.maxPartySize}, please speak with staff.`,
    );
  let date: Temporal.PlainDate;
  let startsAt: Temporal.ZonedDateTime;
  let reference: Temporal.ZonedDateTime;
  try {
    date = Temporal.PlainDate.from(validated.date, { overflow: 'reject' });
    const time = Temporal.PlainTime.from(validated.time, { overflow: 'reject' });
    reference = Temporal.Instant.from(referenceAt.toISOString()).toZonedDateTimeISO(
      restaurant.timezone,
    );
    startsAt = Temporal.ZonedDateTime.from(
      {
        timeZone: restaurant.timezone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour: time.hour,
        minute: time.minute,
      },
      { disambiguation: 'reject', overflow: 'reject' },
    );
  } catch {
    throw new DomainError(
      'INVALID_LOCAL_TIME',
      'That date or time is invalid or ambiguous because of the clock change. Please choose a different exact date and time.',
    );
  }
  if (Temporal.ZonedDateTime.compare(startsAt, reference) <= 0)
    throw new DomainError('PAST_RESERVATION', 'Please choose a future date and time.');
  if (
    Temporal.PlainDate.compare(
      date,
      reference.toPlainDate().add({ days: restaurant.maxRequestDays }),
    ) > 0
  ) {
    throw new DomainError(
      'OUTSIDE_REQUEST_HORIZON',
      `We accept requests up to ${restaurant.maxRequestDays} days ahead.`,
    );
  }
  if (!inOpeningHours(date, validated.time, restaurant))
    throw new DomainError(
      'RESTAURANT_CLOSED',
      'The restaurant is closed at that time. Please choose another date and time.',
    );
  return {
    ...validated,
    timezone: restaurant.timezone,
    startsAt: startsAt.toInstant().toString(),
    referenceAt: referenceAt.toISOString(),
  };
}

export function hoursForDate(restaurant: Restaurant, dateText: string): string {
  const date = Temporal.PlainDate.from(dateText);
  if (restaurant.holidayClosures.includes(dateText)) return `We are closed on ${dateText}.`;
  const hours = restaurant.hours.find((value) => value.day === date.dayOfWeek % 7);
  if (!hours || hours.closed || hours.open === hours.close) return `We are closed on ${dateText}.`;
  return `On ${dateText}, our hours are ${hours.open}–${hours.close}${hours.open > hours.close ? ' the following day' : ''} (${restaurant.timezone}). Opening hours do not guarantee table availability.`;
}

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, Clock3, MapPin, Phone, Plus, Save, Trash2 } from 'lucide-react';
import {
  restaurantSchema,
  restaurantSettingsSchema,
  type Restaurant,
  type RestaurantSettings,
} from '@hostline/contracts';
import { ApiError, api, errorMessage } from '../api';
import { ErrorNotice, PageHeading, SuccessNotice } from '../components/shared';

type Tab = 'restaurant' | 'hours' | 'knowledge' | 'calls';
function settingsFromRestaurant(restaurant: Restaurant): RestaurantSettings {
  const { id: _id, version: _version, updatedAt: _updatedAt, ...settings } = restaurant;
  return settings;
}
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Settings({
  restaurant,
  csrf,
  writable,
  onSaved,
}: {
  restaurant: Restaurant;
  csrf: string | null;
  writable: boolean;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => settingsFromRestaurant(restaurant));
  const [version, setVersion] = useState(restaurant.version);
  const [holidays, setHolidays] = useState(restaurant.holidayClosures.join('\n'));
  const [tab, setTab] = useState<Tab>('restaurant');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => {
    if (!dirty) {
      setDraft(settingsFromRestaurant(restaurant));
      setVersion(restaurant.version);
      setHolidays(restaurant.holidayClosures.join('\n'));
    }
  }, [restaurant, dirty]);
  function update<K extends keyof RestaurantSettings>(key: K, value: RestaurantSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSuccess('');
  }
  function reset() {
    setDraft(settingsFromRestaurant(restaurant));
    setVersion(restaurant.version);
    setHolidays(restaurant.holidayClosures.join('\n'));
    setDirty(false);
    setError('');
    setSuccess('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    const parsed = restaurantSettingsSchema.safeParse({
      ...draft,
      holidayClosures: holidays
        .split(/[\n,]/)
        .map((date) => date.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(' → ')}: ${issue.message}`)
          .slice(0, 3)
          .join(' '),
      );
      return;
    }
    setBusy(true);
    try {
      const saved = await api('/restaurant', restaurantSchema, {
        method: 'PUT',
        csrf,
        body: { expectedVersion: version, settings: parsed.data },
      });
      setDraft(settingsFromRestaurant(saved));
      setVersion(saved.version);
      setHolidays(saved.holidayClosures.join('\n'));
      await onSaved();
      setDirty(false);
      setSuccess('Restaurant information saved. New conversations will use this version.');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) await onSaved();
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const tabs = [
    { id: 'restaurant', label: 'Restaurant', icon: MapPin },
    { id: 'hours', label: 'Opening hours', icon: Clock3 },
    { id: 'knowledge', label: 'Menu & FAQs', icon: BookOpen },
    { id: 'calls', label: 'Call handling', icon: Phone },
  ] as const;
  return (
    <>
      <PageHeading
        eyebrow="YOUR RESTAURANT, IN YOUR OWN WORDS"
        title="The details make the difference."
        description="Give your receptionist the information that makes every answer feel like you."
        action={<span className="badge badge-neutral">Version {restaurant.version}</span>}
      />
      {!writable && (
        <div className="notice notice-info">
          You can view restaurant settings. Owner access is required to publish changes.
        </div>
      )}
      <form onSubmit={(event) => void save(event)}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={tab === id ? 'settings-tab-active' : ''}
                aria-current={tab === id ? 'page' : undefined}
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
            <div className="settings-tip">
              <span className="tiny-dot" />
              <p>
                Accurate information.
                <br />
                Confident conversations.
              </p>
              <span>Only add details that your restaurant has approved.</span>
            </div>
          </nav>
          <div className="settings-main">
            {error && <ErrorNotice message={error} />}
            {success && <SuccessNotice message={success} />}
            {version !== restaurant.version && dirty && (
              <div className="notice notice-warning">
                These settings have changed since you started editing. Reload the latest version
                before saving.
                <button type="button" className="text-button" onClick={reset}>
                  Reload settings
                </button>
              </div>
            )}
            <fieldset disabled={!writable || busy} className="settings-fieldset">
              {tab === 'restaurant' && (
                <SettingsCard
                  title="A familiar first hello"
                  description="The essentials guests ask about, and the welcome they hear."
                >
                  <div className="fields-grid">
                    <label className="field">
                      Restaurant name
                      <input
                        required
                        minLength={2}
                        maxLength={100}
                        value={draft.name}
                        onChange={(event) => update('name', event.target.value)}
                      />
                    </label>
                    <label className="field">
                      Public phone number
                      <input
                        type="tel"
                        required
                        placeholder="+12125550142"
                        value={draft.publicPhone}
                        onChange={(event) => update('publicPhone', event.target.value)}
                      />
                      <span className="field-hint">Include the country code, such as +1.</span>
                    </label>
                    <label className="field field-full">
                      Street address
                      <input
                        required
                        minLength={3}
                        maxLength={240}
                        value={draft.address}
                        onChange={(event) => update('address', event.target.value)}
                      />
                    </label>
                    <label className="field field-full">
                      Restaurant timezone
                      <input
                        required
                        value={draft.timezone}
                        list="timezone-options"
                        onChange={(event) => update('timezone', event.target.value)}
                      />
                      <datalist id="timezone-options">
                        <option value="America/New_York" />
                        <option value="America/Chicago" />
                        <option value="America/Denver" />
                        <option value="America/Los_Angeles" />
                        <option value="Europe/London" />
                      </datalist>
                      <span className="field-hint">
                        Used for opening hours, requests, and phrases like “tomorrow.”
                      </span>
                    </label>
                    <label className="field field-full">
                      Receptionist greeting
                      <textarea
                        rows={3}
                        required
                        minLength={10}
                        maxLength={500}
                        value={draft.greeting}
                        onChange={(event) => update('greeting', event.target.value)}
                      />
                      <span className="field-hint">
                        Let callers know they’re speaking with your AI receptionist.
                      </span>
                    </label>
                    <label className="field field-full">
                      Reservation follow-up message
                      <textarea
                        rows={3}
                        required
                        minLength={10}
                        maxLength={500}
                        value={draft.followUpMessage}
                        onChange={(event) => update('followUpMessage', event.target.value)}
                      />
                      <span className="field-hint">
                        Explain how staff will follow up. A saved request is not a confirmed
                        reservation.
                      </span>
                    </label>
                  </div>
                </SettingsCard>
              )}
              {tab === 'hours' && (
                <>
                  <SettingsCard
                    title="When your doors are open"
                    description={`Weekly opening hours in ${draft.timezone}. These hours do not represent table availability.`}
                  >
                    <div className="hours-list">
                      {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                        const hour = draft.hours.find((entry) => entry.day === day);
                        if (!hour) return null;
                        return (
                          <div
                            className={`hours-row ${hour.closed ? 'hours-closed' : ''}`}
                            key={day}
                          >
                            <span className="day-name">{dayNames[day]}</span>
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={!hour.closed}
                                onChange={(event) =>
                                  update(
                                    'hours',
                                    draft.hours.map((entry) =>
                                      entry.day === day
                                        ? { ...entry, closed: !event.target.checked }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                              Open
                            </label>
                            <label>
                              <span className="sr-only">{dayNames[day]} opening time</span>
                              <input
                                type="time"
                                value={hour.open}
                                disabled={hour.closed}
                                onChange={(event) =>
                                  update(
                                    'hours',
                                    draft.hours.map((entry) =>
                                      entry.day === day
                                        ? { ...entry, open: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <span className="hours-dash">to</span>
                            <label>
                              <span className="sr-only">{dayNames[day]} closing time</span>
                              <input
                                type="time"
                                value={hour.close}
                                disabled={hour.closed}
                                onChange={(event) =>
                                  update(
                                    'hours',
                                    draft.hours.map((entry) =>
                                      entry.day === day
                                        ? { ...entry, close: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </label>
                          </div>
                        );
                      })}
                    </div>
                    <p className="field-hint">
                      A closing time earlier than opening time indicates service continuing after
                      midnight.
                    </p>
                  </SettingsCard>
                  <SettingsCard
                    title="A day off, planned ahead"
                    description="Holiday closures override your regular opening hours."
                  >
                    <label className="field">
                      Closed dates
                      <textarea
                        rows={3}
                        value={holidays}
                        onChange={(event) => {
                          setHolidays(event.target.value);
                          setDirty(true);
                          setSuccess('');
                        }}
                        placeholder="2026-12-25"
                      />
                      <span className="field-hint">One date per line, in YYYY-MM-DD format.</span>
                    </label>
                  </SettingsCard>
                </>
              )}
              {tab === 'knowledge' && (
                <>
                  <SettingsCard
                    title="Good answers, ready to go"
                    description="Approved answers to your guests’ most common questions."
                    action={
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={draft.faqs.length >= 50}
                        onClick={() =>
                          update('faqs', [
                            ...draft.faqs,
                            { id: crypto.randomUUID(), question: '', answer: '', keywords: [] },
                          ])
                        }
                      >
                        <Plus size={15} />
                        Add answer
                      </button>
                    }
                  >
                    <div className="knowledge-list">
                      {draft.faqs.length === 0 && (
                        <p className="small-note">
                          Add your first answer for questions about parking, dress code, or
                          accessibility.
                        </p>
                      )}
                      {draft.faqs.map((faq, index) => (
                        <div className="knowledge-item" key={faq.id}>
                          <div className="knowledge-item-heading">
                            <span>ANSWER {String(index + 1).padStart(2, '0')}</span>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Remove FAQ ${index + 1}`}
                              onClick={() =>
                                update(
                                  'faqs',
                                  draft.faqs.filter((entry) => entry.id !== faq.id),
                                )
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <label className="field">
                            Question
                            <input
                              required
                              minLength={3}
                              maxLength={160}
                              value={faq.question}
                              onChange={(event) =>
                                update(
                                  'faqs',
                                  draft.faqs.map((entry) =>
                                    entry.id === faq.id
                                      ? { ...entry, question: event.target.value }
                                      : entry,
                                  ),
                                )
                              }
                            />
                          </label>
                          <label className="field">
                            Approved answer
                            <textarea
                              required
                              minLength={2}
                              maxLength={800}
                              rows={3}
                              value={faq.answer}
                              onChange={(event) =>
                                update(
                                  'faqs',
                                  draft.faqs.map((entry) =>
                                    entry.id === faq.id
                                      ? { ...entry, answer: event.target.value }
                                      : entry,
                                  ),
                                )
                              }
                            />
                          </label>
                          <KeywordField
                            value={faq.keywords}
                            onChange={(keywords) =>
                              update(
                                'faqs',
                                draft.faqs.map((entry) =>
                                  entry.id === faq.id ? { ...entry, keywords } : entry,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </SettingsCard>
                  <SettingsCard
                    title="A taste of your menu"
                    description="Published menu details your receptionist can share. Allergy and cross-contamination questions should go to staff."
                    action={
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={draft.menu.length >= 100}
                        onClick={() =>
                          update('menu', [
                            ...draft.menu,
                            {
                              id: crypto.randomUUID(),
                              name: '',
                              description: '',
                              category: 'Dinner',
                              priceCents: 0,
                              available: true,
                            },
                          ])
                        }
                      >
                        <Plus size={15} />
                        Add item
                      </button>
                    }
                  >
                    <div className="knowledge-list">
                      {draft.menu.map((item, index) => (
                        <div className="knowledge-item" key={item.id}>
                          <div className="knowledge-item-heading">
                            <span>MENU ITEM {String(index + 1).padStart(2, '0')}</span>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Remove menu item ${index + 1}`}
                              onClick={() =>
                                update(
                                  'menu',
                                  draft.menu.filter((entry) => entry.id !== item.id),
                                )
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <div className="fields-grid">
                            <label className="field">
                              Item name
                              <input
                                required
                                minLength={2}
                                maxLength={100}
                                value={item.name}
                                onChange={(event) =>
                                  update(
                                    'menu',
                                    draft.menu.map((entry) =>
                                      entry.id === item.id
                                        ? { ...entry, name: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label className="field">
                              Price (USD)
                              <input
                                type="number"
                                min="0"
                                max="1000"
                                step="0.01"
                                required
                                value={item.priceCents / 100}
                                onChange={(event) =>
                                  update(
                                    'menu',
                                    draft.menu.map((entry) =>
                                      entry.id === item.id
                                        ? {
                                            ...entry,
                                            priceCents: Math.round(
                                              Number(event.target.value) * 100,
                                            ),
                                          }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label className="field field-full">
                              Description
                              <textarea
                                rows={2}
                                maxLength={300}
                                value={item.description}
                                onChange={(event) =>
                                  update(
                                    'menu',
                                    draft.menu.map((entry) =>
                                      entry.id === item.id
                                        ? { ...entry, description: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label className="field">
                              Category
                              <input
                                required
                                maxLength={60}
                                value={item.category}
                                onChange={(event) =>
                                  update(
                                    'menu',
                                    draft.menu.map((entry) =>
                                      entry.id === item.id
                                        ? { ...entry, category: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label className="checkbox-label available-label">
                              <input
                                type="checkbox"
                                checked={item.available}
                                onChange={(event) =>
                                  update(
                                    'menu',
                                    draft.menu.map((entry) =>
                                      entry.id === item.id
                                        ? { ...entry, available: event.target.checked }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                              Currently available
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  </SettingsCard>
                </>
              )}
              {tab === 'calls' && (
                <>
                  <SettingsCard
                    title="Requests that fit your restaurant"
                    description="Set the boundaries for reservation requests. Staff still check availability before confirming."
                  >
                    <div className="fields-grid">
                      <label className="field">
                        Largest party size
                        <input
                          type="number"
                          min="1"
                          max="30"
                          required
                          value={draft.maxPartySize}
                          onChange={(event) => update('maxPartySize', Number(event.target.value))}
                        />
                        <span className="field-hint">Larger groups can speak with your team.</span>
                      </label>
                      <label className="field">
                        How far ahead guests can request
                        <input
                          type="number"
                          min="1"
                          max="365"
                          required
                          value={draft.maxRequestDays}
                          onChange={(event) => update('maxRequestDays', Number(event.target.value))}
                        />
                        <span className="field-hint">Number of days from the conversation.</span>
                      </label>
                    </div>
                  </SettingsCard>
                  <SettingsCard
                    title="A person, whenever they need one"
                    description="Choose the approved destination for requests to speak with your team."
                  >
                    <label className="toggle-row">
                      <div>
                        <strong>Enable staff handoff</strong>
                        <span>Offer a transfer to your designated staff number.</span>
                      </div>
                      <input
                        type="checkbox"
                        className="switch"
                        checked={draft.transferEnabled}
                        onChange={(event) => update('transferEnabled', event.target.checked)}
                      />
                    </label>
                    <div className="fields-grid">
                      <label className="field">
                        Staff destination label
                        <input
                          required
                          minLength={2}
                          maxLength={60}
                          value={draft.transferLabel}
                          onChange={(event) => update('transferLabel', event.target.value)}
                        />
                      </label>
                      <label className="field">
                        Staff phone number
                        <input
                          type="tel"
                          required={draft.transferEnabled}
                          placeholder="+12125550143"
                          value={draft.transferNumber}
                          onChange={(event) => update('transferNumber', event.target.value)}
                        />
                      </label>
                    </div>
                    <p className="field-hint">
                      Use a separate staff line that does not forward back to the receptionist. The
                      simulator demonstrates handoffs without calling this number.
                    </p>
                  </SettingsCard>
                </>
              )}
            </fieldset>
            <div className="settings-save">
              <span>
                <span className={`tiny-dot ${dirty ? 'unsaved-dot' : ''}`} />
                {dirty ? 'You have unsaved changes' : 'Your restaurant details are up to date'}
              </span>
              <div>
                {dirty && (
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={reset}
                    disabled={busy}
                  >
                    Discard changes
                  </button>
                )}
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={!writable || busy || !dirty}
                >
                  <Save size={16} />
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}

function SettingsCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card settings-card">
      <div className="settings-card-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function KeywordField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    const currentKeywords = text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (JSON.stringify(currentKeywords) !== JSON.stringify(value)) setText(value.join(', '));
  }, [value, text]);
  return (
    <label className="field">
      Matching keywords
      <input
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(
            event.target.value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean),
          );
        }}
        placeholder="parking, garage, valet"
      />
      <span className="field-hint">
        Separate keywords with commas. Use at least two characters per keyword.
      </span>
    </label>
  );
}

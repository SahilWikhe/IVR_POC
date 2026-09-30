import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  Clock3,
  Headphones,
  MessageSquare,
  Phone,
  PhoneOff,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { callSessionSchema, type CallSession, type Restaurant } from '@hostline/contracts';
import { ApiError, api, errorMessage } from '../api';
import { ErrorNotice, PageHeading } from '../components/shared';

export function Simulator({
  restaurant,
  csrf,
  writable,
  onChange,
  onInbox,
}: {
  restaurant: Restaurant;
  csrf: string | null;
  writable: boolean;
  onChange: () => Promise<void>;
  onInbox: (id: string) => void;
}) {
  const [call, setCall] = useState<CallSession | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pendingTurn = useRef<{ callId: string; text: string; key: string } | null>(null);
  const pendingConfirmation = useRef<{ proposalId: string; key: string } | null>(null);
  const active = call?.status === 'active';
  const prompts = [
    { label: 'Ask about hours', text: 'What are your opening hours?', icon: Clock3 },
    { label: 'Request a table', text: 'I would like to request a table.', icon: CalendarDays },
    { label: 'Leave a message', text: 'I would like to leave a message.', icon: MessageSquare },
    { label: 'Speak to the host', text: 'Can I speak to a person?', icon: Headphones },
  ];
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [call?.messages.length, call?.proposal?.id]);
  async function start() {
    setBusy(true);
    setError('');
    try {
      setCall(await api('/simulator/calls', callSessionSchema, { method: 'POST', body: {}, csrf }));
      setText('');
      await onChange();
      input.current?.focus();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function refreshCall() {
    if (call) setCall(await api(`/simulator/calls/${call.id}`, callSessionSchema));
  }
  async function handleFailure(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 409)
      await refreshCall().catch(() => undefined);
    setError(errorMessage(cause));
  }
  async function send(message: string) {
    if (!call || !active || !message.trim() || busy) return;
    if (pendingTurn.current?.callId !== call.id || pendingTurn.current.text !== message.trim()) {
      pendingTurn.current = { callId: call.id, text: message.trim(), key: crypto.randomUUID() };
    }
    setBusy(true);
    setError('');
    try {
      setCall(
        await api(`/simulator/calls/${call.id}/turn`, callSessionSchema, {
          method: 'POST',
          csrf,
          body: {
            text: message.trim(),
            expectedVersion: call.version,
            clientTurnId: pendingTurn.current.key,
          },
        }),
      );
      pendingTurn.current = null;
      setText('');
      await onChange();
    } catch (cause) {
      await handleFailure(cause);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }
  async function confirm() {
    if (!call?.proposal || busy) return;
    if (pendingConfirmation.current?.proposalId !== call.proposal.id) {
      pendingConfirmation.current = { proposalId: call.proposal.id, key: crypto.randomUUID() };
    }
    setBusy(true);
    setError('');
    try {
      setCall(
        await api(`/simulator/calls/${call.id}/confirm`, callSessionSchema, {
          method: 'POST',
          csrf,
          body: {
            proposalId: call.proposal.id,
            expectedVersion: call.version,
            idempotencyKey: pendingConfirmation.current.key,
          },
        }),
      );
      pendingConfirmation.current = null;
      await onChange();
    } catch (cause) {
      await handleFailure(cause);
    } finally {
      setBusy(false);
    }
  }
  async function end() {
    if (!call || busy) return;
    setBusy(true);
    setError('');
    try {
      setCall(
        await api(`/simulator/calls/${call.id}/end`, callSessionSchema, {
          method: 'POST',
          csrf,
          body: { expectedVersion: call.version },
        }),
      );
      await onChange();
    } catch (cause) {
      await handleFailure(cause);
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void send(text);
  }
  return (
    <>
      <PageHeading
        eyebrow="A LITTLE PRACTICE GOES A LONG WAY"
        title="Hear the welcome. Try the flow."
        description="Step into a guest’s shoes and explore your restaurant’s receptionist."
      />
      <div className="notice notice-info">
        <Sparkles size={18} />
        <span>
          This is a guided text simulation. It uses your saved restaurant information; no AI audio,
          phone calls, or bookings are made.
        </span>
      </div>
      <div className="simulator-grid">
        <section className="card conversation-card">
          <div className="conversation-header">
            <div className="conversation-host-icon">
              <Phone size={20} />
            </div>
            <div>
              <h2>{restaurant.name}</h2>
              <p>
                <span className={`status-dot ${active ? 'dot-green' : ''}`} />
                {active
                  ? 'Practice conversation in progress'
                  : call
                    ? 'Practice conversation complete'
                    : 'Your receptionist is ready'}
              </p>
            </div>
            {active ? (
              <button
                className="button button-quiet button-small"
                onClick={() => void end()}
                disabled={busy}
              >
                <PhoneOff size={15} />
                End call
              </button>
            ) : call ? (
              <button
                className="button button-secondary button-small"
                onClick={() => void start()}
                disabled={busy || !writable}
              >
                <RotateCcw size={15} />
                New call
              </button>
            ) : null}
          </div>
          <div
            className="conversation-scroll"
            role="log"
            aria-label="Simulated call transcript"
            aria-live="polite"
          >
            {!call ? (
              <div className="conversation-welcome">
                <span className="conversation-emblem">
                  <Phone size={32} strokeWidth={1.3} />
                  <span />
                </span>
                <p className="eyebrow">YOUR RESTAURANT. YOUR WELCOME.</p>
                <h2>Let’s start a conversation.</h2>
                <p>
                  Ask a question, request a table, or leave a message. See how your receptionist
                  helps along the way.
                </p>
                <button
                  className="button button-primary"
                  onClick={() => void start()}
                  disabled={busy || !writable}
                >
                  <Phone size={17} />
                  {busy ? 'Starting…' : 'Start practice call'}
                </button>
                {!writable && (
                  <p className="small-note">Staff access is required to start a practice call.</p>
                )}
              </div>
            ) : (
              <>
                <div className="conversation-date">
                  Practice conversation ·{' '}
                  {new Intl.DateTimeFormat('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: restaurant.timezone,
                  }).format(new Date(call.createdAt))}
                </div>
                {call.messages.map((message) => (
                  <div className={`chat-message chat-${message.role}`} key={message.id}>
                    {message.role === 'assistant' && (
                      <span className="chat-avatar">
                        <Sparkles size={15} />
                      </span>
                    )}
                    <div>
                      <span className="chat-label">
                        {message.role === 'assistant' ? 'Hostline' : 'You, as the guest'}
                      </span>
                      <div className="chat-bubble">{message.text}</div>
                    </div>
                  </div>
                ))}
                {call.proposal && active && (
                  <div className="proposal-card">
                    <span className="proposal-label">
                      <ShieldCheck size={17} />
                      Review before saving
                    </span>
                    <p>{call.proposal.readback}</p>
                    <p className="small-note">
                      {call.proposal.kind === 'reservation'
                        ? 'This saves a request for staff review. It does not confirm a table.'
                        : 'This saves a message for the restaurant team.'}
                    </p>
                    <button
                      className="button button-primary"
                      onClick={() => void confirm()}
                      disabled={busy}
                    >
                      <Check size={17} />
                      {busy
                        ? 'Saving…'
                        : call.proposal.kind === 'reservation'
                          ? 'Confirm request'
                          : 'Confirm message'}
                    </button>
                    <span className="proposal-hint">
                      Need a correction? Type it below before confirming.
                    </span>
                  </div>
                )}
                {call.inboxItemId && (
                  <div className="saved-card">
                    <span>
                      <Check size={20} />
                    </span>
                    <div>
                      <strong>
                        {call.status === 'message_saved'
                          ? 'Message saved for your team'
                          : 'Request saved for staff review'}
                      </strong>
                      <p>
                        {call.status === 'message_saved'
                          ? 'Your team can read and respond from the guest inbox.'
                          : 'The table is not confirmed. Your team takes it from here.'}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => {
                          if (call.inboxItemId) onInbox(call.inboxItemId);
                        }}
                      >
                        Open guest request
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </div>
                )}
                {!active && !call.inboxItemId && (
                  <div className="conversation-ended">
                    <PhoneOff size={15} />
                    <span>
                      {call.status === 'transferred'
                        ? 'Simulated handoff complete. No staff phone was called.'
                        : 'Practice conversation ended.'}
                    </span>
                  </div>
                )}
                <div ref={bottom} />
              </>
            )}
          </div>
          {error && (
            <div className="conversation-error">
              <ErrorNotice message={error} />
            </div>
          )}
          <form className="conversation-composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="caller-message">
              Your message as the guest
            </label>
            <input
              ref={input}
              id="caller-message"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={1500}
              placeholder={active ? 'Type as the guest…' : 'Start a practice call to begin…'}
              disabled={!active || busy}
              autoComplete="off"
            />
            <button
              type="submit"
              className="send-button"
              disabled={!active || busy || !text.trim()}
              aria-label="Send guest message"
            >
              <Send size={18} />
            </button>
          </form>
          <div className="composer-note">
            Guided text simulation <span>·</span> {restaurant.timezone}
          </div>
        </section>
        <aside className="simulator-aside">
          <section className="card try-card">
            <p className="eyebrow">PUT YOURSELF ON THE LINE</p>
            <h2>What would you ask?</h2>
            <p>A few starting points for your next practice call.</p>
            <div className="prompt-list">
              {prompts.map(({ label, text: prompt, icon: Icon }) => (
                <button key={label} disabled={!active || busy} onClick={() => void send(prompt)}>
                  <span>
                    <Icon size={18} />
                  </span>
                  {label}
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
            {!active && <p className="small-note">Start a practice call to try a prompt.</p>}
          </section>
          <section className="simulator-note">
            <span className="note-sparkle">
              <Sparkles size={22} strokeWidth={1.5} />
            </span>
            <h3>
              A good conversation
              <br />
              starts with good information.
            </h3>
            <p>
              The receptionist uses your approved hours, menu, and FAQs. Update them in Knowledge &
              settings.
            </p>
            <div className="note-rule" />
            <span>
              Use fictional names and test numbers.
              <br />
              For example: +12125550142.
            </span>
          </section>
        </aside>
      </div>
    </>
  );
}

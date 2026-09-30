import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  Clock3,
  MessageSquare,
  Phone,
  PhoneIncoming,
  Sparkles,
} from 'lucide-react';
import type { Bootstrap } from '@hostline/contracts';
import type { View } from '../App';
import {
  ArrowLink,
  EmptyState,
  PageHeading,
  StatusBadge,
  displayDate,
  initials,
} from '../components/shared';

export function Overview({
  data,
  navigate,
  hasMoreRequests,
}: {
  data: Bootstrap;
  navigate: (view: View, id?: string) => void;
  hasMoreRequests: boolean;
}) {
  const waiting = data.inbox.filter((item) => item.state === 'PENDING_STAFF_REVIEW');
  const open = data.inbox.filter((item) => item.state !== 'CLOSED');
  const reservations = data.inbox.filter((item) => item.kind === 'reservation');
  const messages = data.inbox.filter((item) => item.kind === 'message');
  const stats = [
    {
      label: 'Simulated conversations',
      value: data.calls.length,
      note: 'Most recent practice calls (up to 100)',
      icon: PhoneIncoming,
      tone: 'green',
    },
    {
      label: 'Reservation requests',
      value: reservations.length,
      note: 'Reservation requests in loaded results',
      icon: CalendarDays,
      tone: 'sand',
    },
    {
      label: 'Guest messages',
      value: messages.length,
      note: 'Guest messages in loaded results',
      icon: MessageSquare,
      tone: 'sage',
    },
    {
      label: 'Awaiting your review',
      value: waiting.length,
      note: hasMoreRequests
        ? 'Needs review in loaded results'
        : waiting.length
          ? 'Your team can take it from here'
          : 'You’re all caught up',
      icon: Clock3,
      tone: 'amber',
    },
  ];
  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: data.restaurant.timezone,
  }).format(new Date());
  return (
    <>
      <PageHeading
        eyebrow={today}
        title="Good hospitality starts with hello."
        description="A little more clarity. A little more time for your guests."
        action={
          <button className="button button-primary" onClick={() => navigate('simulator')}>
            <Phone size={17} />
            Try a conversation
            <ArrowUpRight size={17} />
          </button>
        }
      />
      <section className="overview-banner" aria-label="Receptionist status">
        <div className="banner-icon">
          <Sparkles size={23} strokeWidth={1.4} />
        </div>
        <div>
          <h2>Your next great first impression.</h2>
          <p>Your restaurant knowledge and request workflow are ready to explore.</p>
        </div>
        <span className="banner-label">
          <span className="status-dot" />
          Call simulator available
        </span>
      </section>
      <section className="stats-grid" aria-label="Workspace activity">
        {stats.map(({ label, value, note, icon: Icon, tone }) => (
          <article className="stat-card" key={label}>
            <div className="stat-top">
              <span>{label}</span>
              <span className={`stat-icon stat-icon-${tone}`}>
                <Icon size={18} strokeWidth={1.7} />
              </span>
            </div>
            <div className="stat-number">{value.toString().padStart(2, '0')}</div>
            <p>{note}</p>
          </article>
        ))}
      </section>
      <div className="overview-columns">
        <section className="card request-preview">
          <div className="section-heading">
            <div>
              <p className="eyebrow">THE FRONT DESK</p>
              <h2>
                Guests to get back to <span className="heading-count">{open.length}</span>
              </h2>
            </div>
            <ArrowLink onClick={() => navigate('requests')}>View all requests</ArrowLink>
          </div>
          {open.length ? (
            <div className="preview-list">
              {open.slice(0, 4).map((item) => (
                <button
                  className="preview-row"
                  key={item.id}
                  onClick={() => navigate('requests', item.id)}
                >
                  <span className={`avatar ${item.kind === 'message' ? 'avatar-sand' : ''}`}>
                    {initials(item.name)}
                  </span>
                  <span className="preview-person">
                    <strong>{item.name}</strong>
                    <span>
                      {item.reservation
                        ? `${item.reservation.partySize} guests · ${displayDate(item.reservation.startsAt, data.restaurant.timezone, true)}`
                        : 'Left a message for your team'}
                    </span>
                  </span>
                  <StatusBadge state={item.state} />
                  <ArrowUpRight className="row-arrow" size={17} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              title="A clear front desk"
              description="Guest requests and messages will appear here after a conversation."
              action={
                <button className="button button-secondary" onClick={() => navigate('simulator')}>
                  Start a practice call
                </button>
              }
            />
          )}
          <div className="card-bottom-note">
            <span className="tiny-dot" />A reservation request is only confirmed after your team
            arranges it and contacts the guest.
          </div>
        </section>
        <section className="card setup-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MADE FOR YOUR RESTAURANT</p>
              <h2>
                A warm welcome,
                <br />
                in your own words.
              </h2>
            </div>
            <span className="setup-flower" aria-hidden="true">
              ✳
            </span>
          </div>
          <blockquote>“{data.restaurant.greeting}”</blockquote>
          <div className="setup-check">
            <span>
              <Check size={13} />
            </span>
            Restaurant hours & information
          </div>
          <div className="setup-check">
            <span>
              <Check size={13} />
            </span>
            {data.restaurant.faqs.length} approved answers · {data.restaurant.menu.length} menu
            items
          </div>
          <button
            className="button button-secondary button-wide"
            onClick={() => navigate('settings')}
          >
            Make it yours
            <ArrowRight size={17} />
          </button>
        </section>
      </div>
      <section className="card recent-calls">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ON THE LINE</p>
            <h2>Recent practice calls</h2>
          </div>
          <span className="subtle-label">Simulated activity only</span>
        </div>
        {data.calls.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Conversation</th>
                  <th>Received</th>
                  <th>Outcome</th>
                  <th>Follow-up</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.slice(0, 5).map((call) => (
                  <tr key={call.id}>
                    <td>
                      <span className="table-call">
                        <Phone size={15} />
                        <span>
                          Practice call <span className="muted">#{call.id.slice(0, 6)}</span>
                        </span>
                      </span>
                    </td>
                    <td>{displayDate(call.createdAt, data.restaurant.timezone, true)}</td>
                    <td>
                      <span className="call-outcome">
                        {call.outcome ??
                          (call.status === 'active'
                            ? 'Conversation in progress'
                            : 'Conversation ended')}
                      </span>
                    </td>
                    <td>
                      {call.inboxItemId ? (
                        <ArrowLink
                          onClick={() => navigate('requests', call.inboxItemId ?? undefined)}
                        >
                          View request
                        </ArrowLink>
                      ) : (
                        <span className="muted">No request</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="compact-empty">
            <Phone size={20} />
            <p>
              No practice calls yet. Start a conversation to see how your receptionist responds.
            </p>
            <button className="text-button" onClick={() => navigate('simulator')}>
              Try the simulator
              <ArrowRight size={15} />
            </button>
          </div>
        )}
      </section>
    </>
  );
}

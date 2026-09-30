import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  Clock3,
  MessageSquare,
  Phone,
  Search,
  Users,
} from 'lucide-react';
import { idSchema, inboxItemSchema, type InboxAction, type InboxItem } from '@hostline/contracts';
import { ApiError, api, errorMessage } from '../api';
import {
  Dialog,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeading,
  StatusBadge,
  SuccessNotice,
  displayDate,
  initials,
} from '../components/shared';

type Filter = 'open' | 'reservations' | 'messages' | 'closed';
type Action = InboxAction['action'];
const actionLabels: Record<Action, string> = {
  ACKNOWLEDGE: 'Acknowledge request',
  CLAIM: 'Take ownership',
  START_FULFILLMENT: 'Start arranging reservation',
  RECORD_BOOKING: 'Record a booking',
  DECLINE: 'Decline request',
  RECONCILE_BOOKED: 'Booking was made',
  RECONCILE_NOT_BOOKED: 'No booking was made',
  RECORD_GUEST_NOTICE: 'Record guest communication',
  CLOSE: 'Close request',
};

function availableActions(item: InboxItem): Action[] {
  switch (item.state) {
    case 'PENDING_STAFF_REVIEW':
      return ['ACKNOWLEDGE', 'CLAIM'];
    case 'ACKNOWLEDGED':
      return ['CLAIM'];
    case 'IN_REVIEW':
      return !item.leaseExpiresAt || Date.parse(item.leaseExpiresAt) <= Date.now()
        ? ['CLAIM']
        : item.kind === 'reservation'
          ? ['START_FULFILLMENT', 'DECLINE']
          : item.guestNotice === 'COMMUNICATION_RECORDED'
            ? ['CLOSE']
            : ['RECORD_GUEST_NOTICE'];
    case 'IN_FULFILLMENT':
      return ['RECORD_BOOKING'];
    case 'NEEDS_RECONCILIATION':
      return ['RECONCILE_BOOKED', 'RECONCILE_NOT_BOOKED'];
    case 'BOOKED_AWAITING_GUEST_NOTICE':
    case 'DECLINED_AWAITING_GUEST_NOTICE':
      return item.guestNotice === 'COMMUNICATION_RECORDED' ? ['CLOSE'] : ['RECORD_GUEST_NOTICE'];
    default:
      return [];
  }
}

export function Inbox({
  items,
  timezone,
  csrf,
  writable,
  selectedId,
  onSelect,
  refresh,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: InboxItem[];
  timezone: string;
  csrf: string | null;
  writable: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  refresh: () => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');
  const [detailItem, setDetailItem] = useState<InboxItem | null>(null);
  const [detailError, setDetailError] = useState('');
  const selectedFromList = items.find((item) => item.id === selectedId);
  useEffect(() => {
    setDetailError('');
    if (!selectedId || selectedFromList) return;
    if (!idSchema.safeParse(selectedId).success) {
      setDetailError('This request link is invalid.');
      return;
    }
    const controller = new AbortController();
    void api(`/inbox/${selectedId}`, inboxItemSchema, { signal: controller.signal })
      .then((item) => {
        if (!controller.signal.aborted) setDetailItem(item);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDetailError(errorMessage(cause));
      });
    return () => {
      controller.abort();
    };
  }, [selectedId, selectedFromList]);
  async function refreshDetail() {
    await refresh();
    if (selectedId && idSchema.safeParse(selectedId).success) {
      setDetailItem(await api(`/inbox/${selectedId}`, inboxItemSchema));
    }
  }
  const matching = items.filter((item) => {
    const visible =
      filter === 'closed'
        ? item.state === 'CLOSED'
        : filter === 'reservations'
          ? item.kind === 'reservation' && item.state !== 'CLOSED'
          : filter === 'messages'
            ? item.kind === 'message' && item.state !== 'CLOSED'
            : item.state !== 'CLOSED';
    return (
      visible &&
      `${item.name} ${item.callbackNumber} ${item.message ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });
  const selected = selectedFromList ?? (detailItem?.id === selectedId ? detailItem : undefined);
  const tabs: { id: Filter; label: string; count: number }[] = [
    {
      id: 'open',
      label: 'All open',
      count: items.filter((item) => item.state !== 'CLOSED').length,
    },
    {
      id: 'reservations',
      label: 'Reservations',
      count: items.filter((item) => item.kind === 'reservation' && item.state !== 'CLOSED').length,
    },
    {
      id: 'messages',
      label: 'Messages',
      count: items.filter((item) => item.kind === 'message' && item.state !== 'CLOSED').length,
    },
    {
      id: 'closed',
      label: 'Closed',
      count: items.filter((item) => item.state === 'CLOSED').length,
    },
  ];
  return (
    <>
      <PageHeading
        eyebrow="THE FRONT DESK"
        title="Every guest, taken care of."
        description="Review requests, arrange the details, and keep guests in the loop."
      />
      <div className="notice notice-info">
        <CalendarDays size={18} />
        <span>
          Requests are not confirmed reservations. Arrange the table in your usual system, then
          contact the guest.
        </span>
      </div>
      <section className="card inbox-card">
        {hasMore && (
          <div className="notice notice-warning">
            Showing {items.length} loaded requests, with open work first. Filters and search apply
            to loaded requests. Load more to include older entries.
          </div>
        )}
        <div className="inbox-toolbar">
          <div className="filter-tabs" role="group" aria-label="Filter requests">
            {tabs.map((tab) => (
              <button
                className={filter === tab.id ? 'filter-active' : ''}
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                aria-pressed={filter === tab.id}
              >
                {tab.label}
                <span>{tab.count}</span>
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={17} />
            <span className="sr-only">Search guest requests</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a guest…"
              type="search"
            />
          </label>
        </div>
        {matching.length ? (
          <div className="table-scroll">
            <table className="inbox-table">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Request</th>
                  <th>Received</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matching.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button className="guest-link" onClick={() => onSelect(item.id)}>
                        <span className={`avatar ${item.kind === 'message' ? 'avatar-sand' : ''}`}>
                          {initials(item.name)}
                        </span>
                        <span>
                          <strong>{item.name}</strong>
                          <span>
                            {item.kind === 'reservation' ? 'Reservation request' : 'Guest message'}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td>
                      {item.reservation ? (
                        <div className="cell-stack">
                          <strong>{displayDate(item.reservation.startsAt, timezone, true)}</strong>
                          <span>
                            <Users size={13} />
                            {item.reservation.partySize} guests
                          </span>
                        </div>
                      ) : (
                        <span className="message-excerpt">{item.message}</span>
                      )}
                    </td>
                    <td className="muted">{displayDate(item.createdAt, timezone, true)}</td>
                    <td>
                      <StatusBadge state={item.state} />
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Open ${item.name}’s request`}
                        onClick={() => onSelect(item.id)}
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={
              query
                ? 'No matching guests'
                : filter === 'closed'
                  ? 'Nothing closed just yet'
                  : 'You’re all caught up'
            }
            description={
              query
                ? 'Try another name or clear your search.'
                : 'Requests and messages from your receptionist will appear here.'
            }
          />
        )}
        <div className="table-footer">
          <span>
            {matching.length} {matching.length === 1 ? 'request' : 'requests'}
            {hasMore ? ' in loaded results' : ''}
          </span>
          <span>Guest details stay within this restaurant’s workspace.</span>
        </div>
      </section>
      {hasMore && (
        <div className="load-more">
          <button className="button button-secondary" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading requests…' : 'Load more requests'}
          </button>
        </div>
      )}
      {selected && (
        <RequestDetail
          key={selected.id}
          item={selected}
          timezone={timezone}
          csrf={csrf}
          writable={writable}
          onClose={() => onSelect(null)}
          refresh={refreshDetail}
        />
      )}
      {selectedId &&
        !selected &&
        (detailError ? (
          <ErrorNotice message={detailError} />
        ) : (
          <Loading label="Loading request details…" />
        ))}
    </>
  );
}

function RequestDetail({
  item,
  timezone,
  csrf,
  writable,
  onClose,
  refresh,
}: {
  item: InboxItem;
  timezone: string;
  csrf: string | null;
  writable: boolean;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [evidence, setEvidence] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const actions = availableActions(item);
  const requiresEvidence =
    action === 'RECORD_BOOKING' ||
    action === 'RECONCILE_BOOKED' ||
    action === 'RECONCILE_NOT_BOOKED' ||
    action === 'DECLINE';
  async function perform(selectedAction: Action) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await api(`/inbox/${item.id}`, inboxItemSchema, {
        method: 'PATCH',
        csrf,
        body: {
          expectedVersion: item.version,
          action: selectedAction,
          ...(requiresEvidence ? { evidence } : {}),
          ...(selectedAction === 'RECORD_GUEST_NOTICE' ? { noticeNote: notice } : {}),
        },
      });
      setAction(null);
      setEvidence('');
      setNotice('');
      await refresh();
      setSuccess(
        selectedAction === 'RECORD_GUEST_NOTICE'
          ? 'Your communication note was recorded. No message was sent by Hostline.'
          : 'Request updated.',
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await refresh();
        setAction(null);
      }
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function choose(next: Action) {
    setSuccess('');
    setError('');
    setAction(next);
    setEvidence('');
    setNotice('');
    if (
      next === 'ACKNOWLEDGE' ||
      next === 'CLAIM' ||
      next === 'START_FULFILLMENT' ||
      next === 'CLOSE'
    )
      void perform(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (action) void perform(action);
  }
  return (
    <Dialog title={item.name} onClose={onClose}>
      <div className="detail-status">
        <StatusBadge state={item.state} />
        <span className="muted">
          {item.kind === 'reservation' ? 'Reservation request' : 'Guest message'}
        </span>
      </div>
      <dl className="request-facts">
        <div>
          <dt>
            <Phone size={15} />
            Callback number
          </dt>
          <dd>{item.callbackNumber}</dd>
        </div>
        <div>
          <dt>
            <Clock3 size={15} />
            Received
          </dt>
          <dd>{displayDate(item.createdAt, timezone, true)}</dd>
        </div>
        {item.reservation && (
          <>
            <div>
              <dt>
                <CalendarDays size={15} />
                Requested date & time
              </dt>
              <dd>
                {displayDate(item.reservation.startsAt, item.reservation.timezone, true)}
                <small>{item.reservation.timezone}</small>
              </dd>
            </div>
            <div>
              <dt>
                <Users size={15} />
                Party size
              </dt>
              <dd>{item.reservation.partySize} guests</dd>
            </div>
          </>
        )}
      </dl>
      {item.message && (
        <div className="detail-message">
          <span className="detail-label">
            <MessageSquare size={15} />
            Their message
          </span>
          <p>{item.message}</p>
        </div>
      )}
      {item.reservation?.notes && (
        <div className="detail-message">
          <span className="detail-label">Guest notes</span>
          <p>{item.reservation.notes}</p>
        </div>
      )}
      {item.kind === 'reservation' && (
        <p className="detail-disclaimer">
          This is a request for staff review. Hostline does not check table availability or make the
          booking for you.
        </p>
      )}
      {item.bookingEvidence && (
        <div className="detail-record">
          <strong>Staff-reported booking evidence</strong>
          <p>{item.bookingEvidence}</p>
        </div>
      )}
      {item.guestNoticeNote && (
        <div className="detail-record">
          <strong>Guest communication recorded</strong>
          <p>{item.guestNoticeNote}</p>
        </div>
      )}
      {item.leaseExpiresAt && item.state !== 'CLOSED' && (
        <p className="small-note">
          Work ownership expires {displayDate(item.leaseExpiresAt, timezone, true)}. Complete the
          step promptly; refresh if another team member updates it.
        </p>
      )}
      {error && <ErrorNotice message={error} />}
      {success && <SuccessNotice message={success} />}
      {!writable && (
        <p className="small-note">
          You have read-only access. A team member with staff access can update this request.
        </p>
      )}
      {writable && actions.length > 0 && (
        <div className="detail-actions">
          <h3>The next thoughtful step</h3>
          <p>
            {item.state === 'IN_FULFILLMENT'
              ? 'Arrange the reservation in your usual booking system. Record its outcome here only after checking it.'
              : item.state === 'NEEDS_RECONCILIATION'
                ? 'Check the existing booking outcome before taking any new booking action.'
                : item.guestNotice === 'COMMUNICATION_RECORDED'
                  ? 'The guest communication has been recorded. You can close this request.'
                  : 'Keep a clear record so your team knows what’s been taken care of.'}
          </p>
          <div className="action-buttons">
            {actions.map((next, index) => (
              <button
                className={`button ${index === 0 ? 'button-primary' : 'button-secondary'}`}
                key={next}
                onClick={() => choose(next)}
                disabled={busy}
              >
                {next === 'CLOSE' && <Check size={16} />}
                {actionLabels[next]}
              </button>
            ))}
          </div>
          {action &&
            actions.includes(action) &&
            (requiresEvidence || action === 'RECORD_GUEST_NOTICE') && (
              <form className="action-form" onSubmit={submit}>
                <label className="field">
                  {action === 'RECORD_GUEST_NOTICE'
                    ? 'How did you contact the guest?'
                    : action === 'DECLINE'
                      ? 'Reason for declining'
                      : 'Evidence from your booking system'}
                  <textarea
                    autoFocus
                    minLength={3}
                    maxLength={500}
                    required
                    rows={3}
                    value={action === 'RECORD_GUEST_NOTICE' ? notice : evidence}
                    onChange={(event) =>
                      action === 'RECORD_GUEST_NOTICE'
                        ? setNotice(event.target.value)
                        : setEvidence(event.target.value)
                    }
                    placeholder={
                      action === 'RECORD_GUEST_NOTICE'
                        ? 'For example: Spoke to the guest and confirmed the details.'
                        : 'Record the reference and what you verified.'
                    }
                  />
                </label>
                {action === 'RECORD_GUEST_NOTICE' && (
                  <p className="small-note">
                    Record a conversation you have already had. Saving this note does not send a
                    text, email, or make a call.
                  </p>
                )}
                <div className="action-buttons">
                  <button className="button button-primary" disabled={busy} type="submit">
                    {busy ? 'Saving…' : 'Save update'}
                  </button>
                  <button
                    className="button button-quiet"
                    disabled={busy}
                    type="button"
                    onClick={() => setAction(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
        </div>
      )}
    </Dialog>
  );
}

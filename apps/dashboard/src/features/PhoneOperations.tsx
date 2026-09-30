import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronRight, PhoneIncoming, RefreshCw, Save, X } from 'lucide-react';
import {
  idSchema,
  phoneCallDetailSchema,
  phoneOperationsSchema,
  phonePolicySchema,
  phoneReconcileResultSchema,
  type PhonePolicy,
  type Role,
  type VoiceCallState,
} from '@hostline/contracts';
import type { z } from 'zod';
import { ApiError, api, errorMessage } from '../api';
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeading,
  StatusBadge,
  SuccessNotice,
  displayDate,
} from '../components/shared';

type Operations = z.infer<typeof phoneOperationsSchema>;
type CallDetail = z.infer<typeof phoneCallDetailSchema>;
type CallSummary = Operations['calls'][number];
type PolicyPermissions = Pick<PhonePolicy, 'voiceEnabled' | 'requestsEnabled' | 'transfersEnabled'>;
type PolicyDraft = PolicyPermissions & { version: number };
const pageSize = 50;
const policyFields = [
  {
    field: 'voiceEnabled',
    label: 'Allow new calls',
    description: 'Let the receptionist answer new calls on your configured phone line.',
  },
  {
    field: 'requestsEnabled',
    label: 'Allow saving requests',
    description: 'Let callers confirm reservation requests and messages for staff review.',
  },
  {
    field: 'transfersEnabled',
    label: 'Allow staff transfers',
    description: 'Let the receptionist try your approved staff line.',
  },
] as const;
const stateLabels: Record<VoiceCallState, string> = {
  WAITING_FOR_STREAM: 'Connecting',
  STREAMING: 'Receptionist connected',
  CONTROL_PENDING: 'Action prepared',
  AWAITING_CONFIRMATION: 'Awaiting caller confirmation',
  TRANSFER_PENDING: 'Transfer prepared',
  TRANSFERRING: 'Trying staff line',
  CONNECTED_TO_STAFF: 'Staff line connected',
  NEEDS_RECONCILIATION: 'Check provider status',
  ENDED: 'Ended',
};

function policyDraft(policy: PhonePolicy): PolicyDraft {
  return {
    version: policy.version,
    voiceEnabled: policy.voiceEnabled,
    requestsEnabled: policy.requestsEnabled,
    transfersEnabled: policy.transfersEnabled,
  };
}

function PhoneState({ call }: { call: CallSummary }) {
  return (
    <span
      className={`badge badge-${call.requiresReconciliation ? 'amber' : call.state === 'ENDED' ? 'neutral' : 'green'}`}
    >
      <span className="status-dot" />
      {stateLabels[call.state]}
    </span>
  );
}

export function PhoneOperations({
  timezone,
  csrf,
  role,
  selectedId,
  onSelect,
  onInbox,
}: {
  timezone: string;
  csrf: string | null;
  role: Role;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onInbox: (id: string) => void;
}) {
  const [data, setData] = useState<Operations | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailRevision, setDetailRevision] = useState(0);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState('');
  const pages = useRef(1);
  const selectionRevision = useRef(0);
  const canReadDetail = role !== 'viewer';
  const owner = role === 'owner';

  const load = useCallback(async (signal?: AbortSignal) => {
    const results = await Promise.all(
      Array.from({ length: pages.current }, (_, index) =>
        api(
          `/phone/operations?offset=${index * pageSize}&limit=${pageSize}`,
          phoneOperationsSchema,
          signal ? { signal } : undefined,
        ),
      ),
    );
    if (signal?.aborted) return;
    const first = results[0];
    if (!first) return;
    const next = {
      ...first,
      calls: [
        ...new Map(results.flatMap((page) => page.calls).map((call) => [call.id, call])).values(),
      ],
      hasMore: results[results.length - 1]?.hasMore ?? false,
    };
    setData(next);
    // Keep the version paired with an edited draft. Refreshing calls must never
    // quietly authorize an old policy draft against a newer server version.
    setDraft((current) => current ?? policyDraft(first.policy));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])).catch(
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      },
    );
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    selectionRevision.current += 1;
    setDetail(null);
    setDetailError('');
    setReconcileMessage('');
    if (!selectedId || !canReadDetail) return;
    if (!idSchema.safeParse(selectedId).success) {
      setDetailError('This phone call link is invalid.');
      return;
    }
    const controller = new AbortController();
    void api(`/phone/calls/${selectedId}`, phoneCallDetailSchema, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDetailError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [selectedId, canReadDetail, detailRevision]);

  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await load();
      setDetailRevision((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }

  async function loadMore() {
    if (loadingMore || !data?.hasMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const next = await api(
        `/phone/operations?offset=${pages.current * pageSize}&limit=${pageSize}`,
        phoneOperationsSchema,
      );
      pages.current += 1;
      setData((current) =>
        current
          ? {
              ...current,
              calls: [
                ...new Map(
                  [...current.calls, ...next.calls].map((call) => [call.id, call]),
                ).values(),
              ],
              hasMore: next.hasMore,
            }
          : next,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !owner || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const policy = await api('/phone/policy', phonePolicySchema, {
        method: 'PUT',
        csrf,
        body: {
          expectedVersion: draft.version,
          policy: {
            voiceEnabled: draft.voiceEnabled,
            requestsEnabled: draft.requestsEnabled,
            transfersEnabled: draft.transfersEnabled,
          },
        },
      });
      setDraft(policyDraft(policy));
      setData((current) => (current ? { ...current, policy } : current));
      setSuccess(
        data?.configured.voiceEnabled
          ? 'Phone policy saved.'
          : 'Phone policy saved. Calling stays unavailable until the phone connection is configured.',
      );
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const current = await api('/phone/operations?offset=0&limit=50', phoneOperationsSchema);
          setDraft(policyDraft(current.policy));
          setData((value) => (value ? { ...value, policy: current.policy } : current));
        } catch (reloadCause) {
          setError(`${errorMessage(cause)} ${errorMessage(reloadCause)}`);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function reconcile() {
    if (!detail || !owner || reconciling || !data?.configured.reconciliationAvailable) return;
    setReconciling(true);
    setDetailError('');
    setReconcileMessage('');
    const callId = detail.call.id;
    const revision = selectionRevision.current;
    try {
      const result = await api(`/phone/calls/${callId}/reconcile`, phoneReconcileResultSchema, {
        method: 'POST',
        csrf,
        body: { expectedVersion: detail.call.version },
      });
      setDetail((current) =>
        current?.call.id === callId
          ? {
              ...current,
              call: result.call,
              pendingProposal: result.result === 'ended' ? null : current.pendingProposal,
            }
          : current,
      );
      setData((current) =>
        current
          ? {
              ...current,
              calls: current.calls.map((call) => (call.id === callId ? result.call : call)),
            }
          : current,
      );
      if (revision === selectionRevision.current) setReconcileMessage(result.message);
    } catch (cause) {
      if (revision !== selectionRevision.current) return;
      setDetailError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const current = await api(`/phone/calls/${callId}`, phoneCallDetailSchema);
          setDetail((value) => (value?.call.id === callId ? current : value));
        } catch (reloadCause) {
          setDetailError(`${errorMessage(cause)} ${errorMessage(reloadCause)}`);
        }
      }
    } finally {
      setReconciling(false);
    }
  }

  const dirty =
    !!data && !!draft && policyFields.some(({ field }) => draft[field] !== data.policy[field]);
  const enabled = !!data?.configured.voiceEnabled && !!data.policy.voiceEnabled;
  const selectedDetail = detail?.call.id === selectedId ? detail : null;
  return (
    <>
      <PageHeading
        eyebrow="ON THE LINE"
        title="Your phone, with a clear view."
        description="Control new phone activity, review call outcomes, and give staff useful context."
        action={
          <button
            className="button button-secondary"
            onClick={() => void refresh()}
            disabled={refreshing || busy || reconciling}
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh phone activity'}
          </button>
        }
      />
      {error && <ErrorNotice message={error} onRetry={() => void refresh()} />}
      {success && <SuccessNotice message={success} />}
      {!data || !draft ? (
        !error && <Loading label="Loading phone operations…" />
      ) : (
        <div className="phone-operations">
          <section className="card phone-policy-card" aria-labelledby="phone-policy-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">PHONE POLICY</p>
                <h2 id="phone-policy-title">The permissions you choose.</h2>
              </div>
              <span className={`badge badge-${enabled ? 'green' : 'neutral'}`}>
                <span className="status-dot" />
                {!data.configured.voiceEnabled ? 'Not configured' : enabled ? 'Enabled' : 'Paused'}
              </span>
            </div>
            <form onSubmit={(event) => void savePolicy(event)} className="phone-policy-form">
              <p className="phone-policy-note">
                {!data.configured.voiceEnabled
                  ? 'You can prepare your policy here. Saving it does not activate an unconfigured phone line.'
                  : 'These permissions apply within the features configured for your phone line.'}
              </p>
              {policyFields.map(({ field, label, description }) => (
                <label className="toggle-row" key={field}>
                  <div>
                    <strong>{label}</strong>
                    <span>{description}</span>
                    <span className="phone-feature-status">
                      {!data.configured[field]
                        ? 'Connection not configured for this feature'
                        : enabled && data.policy[field]
                          ? 'Currently allowed'
                          : 'Currently paused'}
                    </span>
                  </div>
                  <input
                    className="switch"
                    type="checkbox"
                    aria-label={label}
                    checked={draft[field]}
                    disabled={!owner || busy}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setDraft((current) => (current ? { ...current, [field]: checked } : current));
                      setSuccess('');
                    }}
                  />
                </label>
              ))}
              <p className="small-note">
                Saving changes interrupts current receptionist conversations and invalidates pending
                caller confirmations. New calls use the saved permissions. Actions already approved
                for dispatch can still reach the phone provider and complete. Check their status if
                the outcome is unclear.
              </p>
              <div className="phone-policy-footer">
                <span className="small-note">
                  {owner
                    ? `Last saved ${displayDate(data.policy.updatedAt, timezone, true)}`
                    : 'An owner can change phone permissions.'}
                </span>
                {owner && (
                  <button className="button button-primary" type="submit" disabled={busy || !dirty}>
                    <Save size={16} />
                    {busy ? 'Saving…' : 'Save phone policy'}
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="card phone-calls-card" aria-labelledby="phone-calls-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">CALL ACTIVITY</p>
                <h2 id="phone-calls-title">Recent phone calls</h2>
              </div>
              <span className="subtle-label">{data.calls.length} loaded</span>
            </div>
            {data.calls.length ? (
              <ul className="phone-call-list">
                {data.calls.map((call) => (
                  <li className="phone-call-row" key={call.id}>
                    <div className="phone-call-main">
                      <PhoneIncoming size={20} aria-hidden="true" />
                      <div>
                        <strong>{displayDate(call.createdAt, timezone, true)}</strong>
                        <p>{call.outcome ?? 'No final outcome recorded.'}</p>
                        <span className="small-note">
                          {call.capacityHeld ? 'Phone capacity held' : 'Phone capacity released'}
                        </span>
                      </div>
                    </div>
                    <div className="phone-call-actions">
                      <PhoneState call={call} />
                      {canReadDetail && (
                        <button
                          className="text-button"
                          onClick={() => onSelect(call.id)}
                          aria-label={`View phone call ${displayDate(call.createdAt, timezone, true)}`}
                        >
                          View details
                          <ChevronRight size={15} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No phone calls yet."
                description="Calls on your configured phone line will appear here. Practice conversations stay in the call simulator."
              />
            )}
            {data.hasMore && (
              <div className="table-footer">
                <span>Older phone calls are available.</span>
                <button
                  className="text-button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more phone calls'}
                </button>
              </div>
            )}
          </section>

          {selectedId && !canReadDetail && (
            <div className="notice notice-info">
              Phone call details require staff or owner access.
            </div>
          )}
          {selectedId && canReadDetail && (
            <section className="card phone-detail-card" aria-label="Phone call details">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">CALL DETAILS</p>
                  <h2>Phone call details</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close phone call details"
                  onClick={() => onSelect(null)}
                >
                  <X size={21} />
                </button>
              </div>
              {detailError && <ErrorNotice message={detailError} />}
              {!selectedDetail ? (
                !detailError && <Loading label="Loading phone call details…" />
              ) : (
                <>
                  <div className="phone-detail-status">
                    <PhoneState call={selectedDetail.call} />
                    <p>{selectedDetail.call.outcome ?? 'No final outcome recorded.'}</p>
                    <p className="small-note">
                      {selectedDetail.call.capacityHeld
                        ? 'Phone capacity remains held until the provider confirms that the call has ended.'
                        : 'The call has ended and its phone capacity has been released.'}
                    </p>
                    {owner && (
                      <div className="phone-reconcile">
                        <button
                          className="button button-secondary"
                          onClick={() => void reconcile()}
                          disabled={
                            reconciling ||
                            !data.configured.reconciliationAvailable ||
                            selectedDetail.call.state === 'ENDED'
                          }
                        >
                          <RefreshCw size={16} className={reconciling ? 'spin' : ''} />
                          {reconciling ? 'Checking provider…' : 'Check provider status'}
                        </button>
                        {!data.configured.reconciliationAvailable && (
                          <span className="small-note">
                            Provider status checks are not configured.
                          </span>
                        )}
                      </div>
                    )}
                    {reconcileMessage && (
                      <div className="notice notice-info" role="status">
                        {reconcileMessage}
                      </div>
                    )}
                  </div>
                  <PhoneContext detail={selectedDetail} timezone={timezone} onInbox={onInbox} />
                </>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

function PhoneContext({
  detail,
  timezone,
  onInbox,
}: {
  detail: CallDetail;
  timezone: string;
  onInbox: (id: string) => void;
}) {
  const proposal = detail.pendingProposal;
  const item = detail.savedItem;
  const staffReportedBooking = item?.bookingEvidence && item.evidenceSource === 'STAFF_REPORTED';
  return (
    <div className="phone-context">
      {detail.context ? (
        <article className="phone-context-block">
          <h3>AI-prepared context</h3>
          <span className="badge badge-amber">Untrusted context</span>
          <p className="small-note">
            Caller and AI text is untrusted. Verify details before acting.
          </p>
          <p>{detail.context.summary || 'No summary supplied.'}</p>
          <p className="small-note">
            {detail.context.reason === 'allergy_question'
              ? 'Reason: allergy question'
              : detail.context.reason === 'requested_staff'
                ? 'Reason: caller requested staff'
                : 'Reason: other assistance'}
            {' · '}
            {displayDate(detail.context.createdAt, timezone, true)}
          </p>
        </article>
      ) : (
        <p className="phone-policy-note">
          No staff handoff context has been prepared for this call.
        </p>
      )}
      {proposal && (
        <article className="phone-context-block phone-unconfirmed">
          <h3>{proposal.kind === 'reservation' ? 'Unconfirmed request' : 'Unconfirmed message'}</h3>
          <span className="badge badge-amber">Not saved</span>
          <p>
            These proposed details have not been saved for staff review. A displayed readback does
            not prove caller agreement.
          </p>
          <p className="phone-readback">{proposal.readback}</p>
          <span className="small-note">
            Confirmation expires {displayDate(proposal.expiresAt, timezone, true)}.
          </span>
        </article>
      )}
      {item && (
        <article className="phone-context-block">
          <h3>{item.kind === 'reservation' ? 'Saved guest request' : 'Saved guest message'}</h3>
          <StatusBadge state={item.state} />
          <p>
            <strong>{item.name}</strong>
            {' · '}
            {item.callbackNumber}
          </p>
          <p>
            {item.kind === 'reservation'
              ? staffReportedBooking
                ? 'Staff reported a booking in their reservation system.'
                : item.state === 'CLOSED'
                  ? 'This request is closed. Review the staff record for its outcome.'
                  : item.state === 'DECLINED_AWAITING_GUEST_NOTICE'
                    ? 'Staff declined this request. The guest still needs an update.'
                    : 'This is a request for staff review. The table is not confirmed.'
              : item.message}
          </p>
          {staffReportedBooking && <p>Staff-reported booking evidence: {item.bookingEvidence}</p>}
          <p className="small-note">
            {item.guestNotice === 'COMMUNICATION_RECORDED'
              ? 'Guest communication recorded.'
              : item.guestNotice === 'ATTEMPTED'
                ? 'Guest contact attempted; communication is not yet recorded.'
                : 'Guest communication pending.'}
          </p>
          <button className="text-button" onClick={() => onInbox(item.id)}>
            Open guest request <ArrowUpRight size={15} />
          </button>
        </article>
      )}
    </div>
  );
}

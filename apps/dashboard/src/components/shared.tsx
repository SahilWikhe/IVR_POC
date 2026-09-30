import { AlertCircle, ArrowUpRight, Check, LoaderCircle, Phone, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { RequestStatus } from '@hostline/contracts';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'brand-small' : ''}`}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <i />
      </span>
      <span>
        hostline<span className="brand-period">.</span>
      </span>
    </div>
  );
}

export function Loading({ label = 'Loading your workspace…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={23} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {onRetry && (
        <button className="text-button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function SuccessNotice({ message }: { message: string }) {
  return (
    <div className="notice notice-success" role="status">
      <Check size={18} />
      <span>{message}</span>
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {action}
    </div>
  );
}

const labels: Record<RequestStatus, string> = {
  PENDING_STAFF_REVIEW: 'Needs review',
  ACKNOWLEDGED: 'Acknowledged',
  IN_REVIEW: 'In review',
  IN_FULFILLMENT: 'Being arranged',
  BOOKED_AWAITING_GUEST_NOTICE: 'Contact guest',
  DECLINED_AWAITING_GUEST_NOTICE: 'Contact guest',
  NEEDS_RECONCILIATION: 'Check booking outcome',
  CLOSED: 'Closed',
};

export function StatusBadge({ state }: { state: RequestStatus }) {
  const tone =
    state === 'CLOSED'
      ? 'neutral'
      : state === 'PENDING_STAFF_REVIEW' || state === 'NEEDS_RECONCILIATION'
        ? 'amber'
        : 'green';
  return (
    <span className={`badge badge-${tone}`}>
      <span className="status-dot" />
      {labels[state]}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Phone size={24} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ArrowLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-button arrow-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={16} />
    </button>
  );
}

export function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function displayDate(instant: string, timezone: string, includeTime = false) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    ...(includeTime ? ({ hour: 'numeric', minute: '2-digit' } as const) : {}),
  }).format(new Date(instant));
}

export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="detail-dialog"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Guest request</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close request details" onClick={onClose}>
            <X size={21} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

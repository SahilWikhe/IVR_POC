import {
  ArrowRight,
  CalendarCheck2,
  Check,
  CircleDashed,
  ExternalLink,
  LockKeyhole,
  Phone,
  Radio,
  Sparkles,
} from 'lucide-react';
import type { IntegrationStatus } from '@hostline/contracts';
import { PageHeading } from '../components/shared';

const statusLabels: Record<IntegrationStatus['status'], string> = {
  active: 'Active',
  simulation: 'Simulation',
  not_configured: 'Not configured',
  access_required: 'Partner access required',
};

export function Integrations({
  integrations,
  onSimulator,
}: {
  integrations: IntegrationStatus[];
  onSimulator: () => void;
}) {
  const reservations = integrations.filter((item) => item.category === 'reservations');
  const communications = integrations.filter((item) => item.category !== 'reservations');
  return (
    <>
      <PageHeading
        eyebrow="CONNECTED, WHEN YOU’RE READY"
        title="Built around the way you work."
        description="Start with staff-reviewed requests. Connect your phone and approved booking tools as you grow."
      />
      <section className="integration-current">
        <span className="integration-current-icon">
          <CalendarCheck2 size={25} strokeWidth={1.5} />
        </span>
        <div>
          <p className="eyebrow">YOUR CURRENT WORKFLOW</p>
          <h2>Thoughtful requests. A human confirmation.</h2>
          <p>
            The receptionist collects the details. Your team checks availability, arranges the
            table, and gets back to the guest.
          </p>
        </div>
        <span className="badge badge-green">
          <span className="status-dot" />
          Request-only
        </span>
      </section>
      <section className="integration-section">
        <div className="integration-section-heading">
          <div>
            <h2>Reservations</h2>
            <p>Your booking system stays the source of truth for table availability.</p>
          </div>
          <span className="subtle-label">Capability-based connections</span>
        </div>
        <div className="integration-grid">
          {reservations.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      </section>
      <section className="integration-section">
        <div className="integration-section-heading">
          <div>
            <h2>Phone & voice</h2>
            <p>The telephone connection and the voice guests will hear.</p>
          </div>
        </div>
        <div className="integration-grid">
          {communications.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      </section>
      <section className="card integration-path">
        <div>
          <span className="eyebrow">FROM PRACTICE TO FIRST HELLO</span>
          <h2>A clear path to your first real call.</h2>
        </div>
        <ol>
          <li>
            <span>01</span>
            <div>
              <strong>Fine-tune the welcome</strong>
              <p>Review restaurant knowledge and try your call flows.</p>
            </div>
            <Check size={17} />
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Connect a dedicated number</strong>
              <p>Configure phone and voice secrets, then test a real call.</p>
            </div>
            <CircleDashed size={18} />
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Forward your restaurant’s calls</strong>
              <p>Verify staff transfers and fallback routing before going live.</p>
            </div>
            <CircleDashed size={18} />
          </li>
        </ol>
        <button className="button button-secondary" onClick={onSimulator}>
          Explore the call simulator
          <ArrowRight size={16} />
        </button>
      </section>
    </>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationStatus }) {
  const name = integration.name.toLowerCase();
  const isResy = name.includes('resy');
  const isOpenTable = name.includes('opentable');
  const isTwilio = name.includes('twilio');
  const pending =
    integration.status === 'access_required' || integration.status === 'not_configured';
  const Icon =
    integration.category === 'phone'
      ? Phone
      : integration.category === 'voice'
        ? Radio
        : CalendarCheck2;
  return (
    <article className="card integration-card">
      <div className="integration-card-top">
        <div
          className={`integration-logo ${isResy ? 'integration-resy' : isOpenTable ? 'integration-opentable' : isTwilio ? 'integration-twilio' : ''}`}
        >
          {isResy ? (
            <span>resy</span>
          ) : isOpenTable ? (
            <span className="opentable-symbol">
              <i />
              <b />
            </span>
          ) : isTwilio ? (
            <span className="twilio-symbol">
              <i />
              <i />
              <i />
              <i />
            </span>
          ) : name.includes('openai') ? (
            <Sparkles size={25} />
          ) : (
            <Icon size={26} />
          )}
        </div>
        <span className={`badge ${pending ? 'badge-neutral' : 'badge-green'}`}>
          {pending ? <LockKeyhole size={11} /> : <span className="status-dot" />}
          {statusLabels[integration.status]}
        </span>
      </div>
      <h3>{integration.name}</h3>
      <p>{integration.description}</p>
      {integration.capabilities.length > 0 && (
        <div className="capability-list">
          {integration.capabilities.map((capability) => (
            <span key={capability}>
              <Check size={12} />
              {capability.replaceAll('_', ' ')}
            </span>
          ))}
        </div>
      )}
      <div className="integration-card-footer">
        {integration.status === 'access_required' ? (
          <>
            <LockKeyhole size={14} />
            <span>Requires approved provider access and restaurant authorization.</span>
          </>
        ) : integration.status === 'not_configured' ? (
          <>
            <ExternalLink size={14} />
            <span>Configure through secure server settings.</span>
          </>
        ) : (
          <>
            <Check size={14} />
            <span>
              {integration.status === 'simulation'
                ? 'Available for practice conversations.'
                : 'Available in this workspace.'}
            </span>
          </>
        )}
      </div>
    </article>
  );
}

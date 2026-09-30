import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Phone,
  Plug,
  Sparkles,
  X,
} from 'lucide-react';
import {
  bootstrapSchema,
  inboxItemSchema,
  sessionSchema,
  type Bootstrap,
  type SessionInfo,
} from '@hostline/contracts';
import { z } from 'zod';
import { api, errorMessage } from './api';
import { Brand, ErrorNotice, Loading, initials } from './components/shared';
import { Overview } from './features/Overview';
import { Inbox } from './features/Inbox';
import { Simulator } from './features/Simulator';
import { Settings } from './features/Settings';
import { Integrations } from './features/Integrations';

export type View = 'overview' | 'requests' | 'simulator' | 'settings' | 'integrations';
const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'requests', label: 'Guest requests', icon: MessageSquare },
  { id: 'simulator', label: 'Call simulator', icon: Phone },
  { id: 'settings', label: 'Knowledge & settings', icon: BookOpen },
  { id: 'integrations', label: 'Integrations', icon: Plug },
] as const;

function currentView(): View {
  const hash = window.location.hash.slice(1).split('/')[0];
  return navigation.some(({ id }) => id === hash) ? (hash as View) : 'overview';
}

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const loadSession = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSession(await api('/session', sessionSchema));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  if (loading)
    return (
      <div className="startup">
        <Brand />
        <Loading />
      </div>
    );
  if (error || !session)
    return (
      <div className="startup">
        <Brand />
        <ErrorNotice
          message={error || 'Your session could not be loaded.'}
          onRetry={() => void loadSession()}
        />
      </div>
    );
  return session.authenticated ? (
    <Workspace
      key={session.workspace?.id}
      session={session}
      onSession={setSession}
      onSignOut={loadSession}
    />
  ) : (
    <Welcome session={session} onSession={setSession} />
  );
}

function Welcome({
  session,
  onSession,
}: {
  session: SessionInfo;
  onSession: (value: SessionInfo) => void;
}) {
  const [workspace, setWorkspace] = useState<'harbor' | 'juniper'>('harbor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function enter() {
    setBusy(true);
    setError('');
    try {
      onSession(
        await api('/auth/demo', sessionSchema, {
          method: 'POST',
          body: { workspace },
          csrf: session.csrfToken,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="welcome">
      <div className="welcome-story">
        <Brand />
        <div className="welcome-copy">
          <p className="eyebrow">A thoughtful first hello</p>
          <h1>
            Every call.
            <br />A warm welcome.
          </h1>
          <p>Give every guest your full attention—even before they walk through the door.</p>
          <div className="welcome-line" />
          <span>Restaurant hospitality, on the line.</span>
        </div>
        <div className="welcome-footer">Built around your restaurant.</div>
      </div>
      <div className="welcome-entry">
        <div className="welcome-card">
          <span className="badge badge-amber">
            {session.mode === 'demo' ? 'Demo workspace' : 'Staff workspace'}
          </span>
          <h2>Welcome to Hostline</h2>
          <p>Your front desk for guest requests, restaurant knowledge, and better conversations.</p>
          {session.mode === 'demo' ? (
            <>
              <label className="field">
                Explore a restaurant
                <select
                  value={workspace}
                  onChange={(event) =>
                    setWorkspace(event.target.value === 'juniper' ? 'juniper' : 'harbor')
                  }
                >
                  <option value="harbor">Harbor Table</option>
                  <option value="juniper">Juniper Kitchen</option>
                </select>
              </label>
              <button
                className="button button-primary button-wide"
                onClick={() => void enter()}
                disabled={busy}
              >
                {busy ? 'Opening workspace…' : 'Enter demo'}
                <ArrowRight size={18} />
              </button>
              <div className="welcome-demo-note">
                <Sparkles size={17} />
                <span>
                  Explore with synthetic guest data. Simulated calls do not contact anyone or
                  reserve tables.
                </span>
              </div>
            </>
          ) : (
            <a className="button button-primary button-wide" href="/api/auth/login">
              Sign in to your restaurant
              <ArrowRight size={18} />
            </a>
          )}
          {error && <ErrorNotice message={error} />}
        </div>
      </div>
    </main>
  );
}

function Workspace({
  session,
  onSession,
  onSignOut,
}: {
  session: SessionInfo;
  onSession: (value: SessionInfo) => void;
  onSignOut: () => Promise<void>;
}) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>(currentView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(
    window.location.hash.split('/')[1] ?? null,
  );
  const inboxPages = useRef(1);
  const [hasMoreRequests, setHasMoreRequests] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api('/bootstrap', bootstrapSchema);
      const extraPages = await Promise.all(
        Array.from({ length: inboxPages.current - 1 }, (_, index) =>
          api(`/inbox?offset=${(index + 1) * 200}&limit=200`, z.array(inboxItemSchema)),
        ),
      );
      const pages = [next.inbox, ...extraPages];
      setHasMoreRequests(pages[pages.length - 1]?.length === 200);
      setData({
        ...next,
        inbox: [...new Map(pages.flat().map((item) => [item.id, item])).values()],
      });
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  async function loadMoreRequests() {
    if (!data || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api(
        `/inbox?offset=${inboxPages.current * 200}&limit=200`,
        z.array(inboxItemSchema),
      );
      inboxPages.current += 1;
      setData((current) =>
        current
          ? {
              ...current,
              inbox: [
                ...new Map([...current.inbox, ...next].map((item) => [item.id, item])).values(),
              ],
            }
          : current,
      );
      setHasMoreRequests(next.length === 200);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onHashChange = () => {
      setView(currentView());
      setRequestId(window.location.hash.split('/')[1] ?? null);
      setMobileOpen(false);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    document.title = `${navigation.find((item) => item.id === view)?.label ?? 'Workspace'} · Hostline`;
  }, [view]);
  function navigate(next: View, id?: string) {
    window.location.hash = `${next}${id ? `/${id}` : ''}`;
    setView(next);
    setRequestId(id ?? null);
    setMobileOpen(false);
  }
  async function signOut() {
    setBusy(true);
    try {
      await api('/auth/logout', z.unknown(), { method: 'POST', body: {}, csrf: session.csrfToken });
      await onSignOut();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function switchWorkspace(value: string) {
    if (value !== 'harbor' && value !== 'juniper') return;
    setBusy(true);
    try {
      onSession(
        await api('/auth/demo', sessionSchema, {
          method: 'POST',
          body: { workspace: value },
          csrf: session.csrfToken,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const pending = data?.inbox.filter((item) => item.state === 'PENDING_STAFF_REVIEW').length ?? 0;
  const writable = session.user?.role !== 'viewer';
  const name = data?.restaurant.name ?? session.workspace?.name ?? 'Your restaurant';
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="mobile-close icon-button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={21} />
          </button>
        </div>
        <div className="sidebar-workspace">
          <div className="workspace-icon">{initials(name)}</div>
          <div>
            <strong>{name}</strong>
            <span>Restaurant workspace</span>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className={`nav-item ${view === id ? 'nav-active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={19} strokeWidth={1.65} />
              <span>{label}</span>
              {id === 'requests' && pending > 0 && <span className="nav-count">{pending}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-icon">
              <Sparkles size={18} />
            </span>
            <strong>Hospitality starts here.</strong>
            <p>
              A little less time on the phone.
              <br />A little more time with guests.
            </p>
          </div>
          <div className="sidebar-user">
            <span className="avatar avatar-user">
              {initials(session.user?.name ?? 'Demo Owner')}
            </span>
            <div>
              <strong>{session.user?.name ?? 'Demo owner'}</strong>
              <span>{session.user?.role ?? 'owner'} access</span>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              disabled={busy}
              onClick={() => void signOut()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="mobile-toggle icon-button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={22} />
            </button>
            <span className="topbar-location">
              <span className="location-dot" />
              {name}
            </span>
            <span className="topbar-divider">/</span>
            <span>{navigation.find((item) => item.id === view)?.label}</span>
          </div>
          <div className="topbar-actions">
            {session.mode === 'demo' && (
              <label className="workspace-switch">
                <span className="sr-only">Switch demo restaurant</span>
                <select
                  value={
                    session.workspace?.id === '22222222-2222-4222-8222-222222222222'
                      ? 'juniper'
                      : 'harbor'
                  }
                  disabled={busy}
                  onChange={(event) => void switchWorkspace(event.target.value)}
                >
                  <option value="harbor">Harbor Table</option>
                  <option value="juniper">Juniper Kitchen</option>
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
            )}
            <span
              className={`badge ${session.mode === 'demo' ? 'badge-amber' : 'badge-green'} topbar-mode`}
            >
              <span className="status-dot" />
              {session.mode === 'demo' ? 'Demo mode' : 'Staff workspace'}
            </span>
          </div>
        </header>
        <main className="main-content" id="main-content" tabIndex={-1}>
          {error && <ErrorNotice message={error} onRetry={() => void refresh()} />}
          {!data ? (
            <Loading />
          ) : (
            <>
              {view === 'overview' && (
                <Overview data={data} navigate={navigate} hasMoreRequests={hasMoreRequests} />
              )}
              {view === 'requests' && (
                <Inbox
                  items={data.inbox}
                  timezone={data.restaurant.timezone}
                  csrf={session.csrfToken}
                  writable={writable}
                  selectedId={requestId}
                  onSelect={(id) => navigate('requests', id ?? undefined)}
                  refresh={refresh}
                  hasMore={hasMoreRequests}
                  loadingMore={loadingMore}
                  onLoadMore={() => void loadMoreRequests()}
                />
              )}
              {view === 'simulator' && (
                <Simulator
                  restaurant={data.restaurant}
                  csrf={session.csrfToken}
                  writable={writable}
                  onChange={refresh}
                  onInbox={(id) => navigate('requests', id)}
                />
              )}
              {view === 'settings' && (
                <Settings
                  restaurant={data.restaurant}
                  csrf={session.csrfToken}
                  writable={session.user?.role === 'owner'}
                  onSaved={refresh}
                />
              )}
              {view === 'integrations' && (
                <Integrations
                  integrations={data.integrations}
                  onSimulator={() => navigate('simulator')}
                />
              )}
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>
            Hostline <span className="footer-dot">·</span> A better first hello.
          </span>
          <span>
            {session.mode === 'demo'
              ? 'Synthetic data · No live guest calls'
              : 'Restaurant reception workspace'}
          </span>
        </footer>
      </div>
    </div>
  );
}

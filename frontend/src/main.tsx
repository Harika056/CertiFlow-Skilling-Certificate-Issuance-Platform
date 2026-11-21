import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';
import './styles.css';
import { api, getToken, setToken, ROLE_LABEL, type Session } from './api';
import { Batches } from './Batches';
import { StateDesk } from './StateDesk';
import { VerifyPage } from './VerifyPage';
import { PhonePage } from './PhonePage';

type Tab = 'batches' | 'state' | 'verify' | 'phone';

function App() {
  const verifyCode = window.location.pathname.match(/^\/verify\/([A-Za-z0-9]+)/)?.[1];
  const [tab, setTab] = useState<Tab>(verifyCode ? 'verify' : 'batches');
  const [people, setPeople] = useState<{ username: string; displayName: string; role: keyof typeof ROLE_LABEL }[]>([]);
  const [session, setSession] = useState<Session | null>(() => {
    const raw = sessionStorage.getItem('cf_session');
    return raw ? JSON.parse(raw) : null;
  });
  const [tick, setTick] = useState(0);          // bumps on every realtime event -> views refetch
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // Order from the brief first; extra demo users (other district) last.
    const order = ['anika', 'dev', 'meera', 'kabir', 'neha', 'farah', 'ravi', 'omar'];
    api<typeof people>('/api/auth/demo-users')
      .then((p) => setPeople([...p].sort((a, b) => order.indexOf(a.username) - order.indexOf(b.username))))
      .catch(() => setPeople([]));
  }, []);

  const switchTo = useCallback(async (username: string) => {
    const s = await api<Session>('/api/auth/demo-login', { method: 'POST', json: { username } });
    setToken(s.token);
    sessionStorage.setItem('cf_session', JSON.stringify(s));
    setSession(s);
    if (tab === 'state' && s.user.role !== 'STATE') setTab('batches');
  }, [tab]);

  // Realtime: one SSE stream per signed-in user; reconnects automatically.
  useEffect(() => {
    const t = getToken();
    if (!session || !t) return;
    const es = new EventSource(`/api/events?access_token=${encodeURIComponent(t)}`);
    es.addEventListener('hello', () => setLive(true));
    es.onerror = () => setLive(false);
    es.addEventListener('change', (e) => {
      const ev = JSON.parse((e as MessageEvent).data);
      setTick((n) => n + 1);
      setToast(`Live update: ${ev.type.replace(/([A-Z])/g, ' $1').trim()}`);
    });
    return () => es.close();
  }, [session]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);

  return (
    <>
      <header className="top">
        <h1>CertiFlow</h1>
        <div className="personas">
          {people.map((p) => (
            <button key={p.username} className={session?.user.displayName === p.displayName ? 'on' : ''} onClick={() => switchTo(p.username)}
              title={ROLE_LABEL[p.role]}>
              {p.displayName} <span style={{ opacity: .7, fontSize: 11 }}>· {ROLE_LABEL[p.role]}</span>
            </button>
          ))}
        </div>
        <span className="live">{session ? (live ? '● live' : '○ connecting…') : ''}</span>
      </header>
      <nav className="tabs">
        <button className={tab === 'batches' ? 'on' : ''} onClick={() => setTab('batches')}>Batches</button>
        {session?.user.role === 'STATE' && <button className={tab === 'state' ? 'on' : ''} onClick={() => setTab('state')}>State desk</button>}
        <button className={tab === 'verify' ? 'on' : ''} onClick={() => setTab('verify')}>Verify a certificate (public)</button>
        <button className={tab === 'phone' ? 'on' : ''} onClick={() => setTab('phone')}>Candidate phones (demo)</button>
      </nav>
      <main>
        {tab === 'verify' && <VerifyPage initialCode={verifyCode} />}
        {tab === 'phone' && <PhonePage tick={tick} />}
        {tab === 'batches' && (session ? <Batches session={session} tick={tick} /> : <div className="card">Pick a person at the top to sign in as them.</div>)}
        {tab === 'state' && session?.user.role === 'STATE' && <StateDesk tick={tick} />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

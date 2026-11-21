import { useEffect, useState } from 'react';

/**
 * Demo only: shows what the stand-in WhatsApp provider delivered to each
 * phone, so reviewers can see "exactly one certificate per phone".
 */
export function PhonePage({ tick }: { tick: number }) {
  const [phones, setPhones] = useState<{ phone: string; count: number }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);

  const load = () => {
    fetch('/wa/v1/inbox').then((r) => r.json()).then(setPhones).catch(() => setPhones([]));
    fetch('/wa/v1/stats').then((r) => r.json()).then(setStats).catch(() => setStats(null));
  };
  useEffect(load, [tick]);
  useEffect(() => { if (sel) fetch(`/wa/v1/inbox/${encodeURIComponent(sel)}`).then((r) => r.json()).then(setMsgs); }, [sel, tick]);

  const setOutage = async (outage: boolean) => {
    await fetch('/wa/admin/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outage }) });
    load();
  };

  return (
    <div className="grid">
      <div className="card">
        <h2>Stand-in WhatsApp provider</h2>
        {stats && <div className="kpi">
          <div><b>{stats.delivered}</b>delivered</div><div><b>{stats.failed}</b>errors</div>
          <div><b>{stats.timedOut}</b>timeouts</div><div><b>{stats.duplicatesSuppressed}</b>duplicates blocked</div>
        </div>}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">Simulate an outage:</span>
          <button onClick={() => setOutage(!stats?.config?.outage)}>{stats?.config?.outage ? 'End outage' : 'Start outage'}</button>
          {stats?.config?.outage && <span className="badge FAILED">WhatsApp down</span>}
        </div>
        <h3>Phones ({phones.length})</h3>
        {phones.map((p) => (
          <div key={p.phone} className={`list-item ${sel === p.phone ? 'sel' : ''}`} onClick={() => setSel(p.phone)}>
            {p.phone} <span className={`badge ${p.count === 1 ? 'SENT' : 'FAILED'}`}>{p.count} message{p.count === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>
      <div>
        {sel ? (
          <div className="phone">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{sel}</div>
            {msgs.map((m) => (
              <div className="bubble" key={m.id}>
                {m.text.split(/(https?:\/\/\S+)/).map((part: string, i: number) =>
                  /^https?:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part.includes('/download/') ? 'Download certificate (PDF)' : 'Verify'}</a> : part)}
                <div className="muted" style={{ fontSize: 11, textAlign: 'right' }}>{new Date(m.receivedAt).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        ) : <div className="card muted">Pick a phone to see its WhatsApp messages.</div>}
      </div>
    </div>
  );
}

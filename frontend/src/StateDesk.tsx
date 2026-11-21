import { useEffect, useState } from 'react';
import { api, STATUS_LABEL } from './api';

export function StateDesk({ tick }: { tick: number }) {
  const [data, setData] = useState<any>(null);
  const [num, setNum] = useState('');
  const [cert, setCert] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => { api('/api/state/stuck').then(setData).catch(() => setData(null)); }, [tick]);

  const lookup = async () => {
    setMsg(null);
    try { setCert(await api(`/api/certificates/by-number/${encodeURIComponent(num.trim().toUpperCase())}`)); }
    catch (e) { setCert(null); setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const fmt = (m: number) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`);

  return (
    <div className="grid">
      <div>
        <div className="card">
          <h2>Cancel a certificate</h2>
          <div className="row">
            <input placeholder="PSM-2026-0000001" value={num} onChange={(e) => setNum(e.target.value)} style={{ flex: 1 }} />
            <button onClick={lookup}>Find</button>
          </div>
          {cert && (
            <div style={{ marginTop: 12 }}>
              <div><b>{cert.certNumber}</b> <span className={`badge ${cert.status}`}>{cert.status}</span></div>
              <div className="muted">{cert.holderName} · {cert.course} · {cert.centreName}</div>
              <div className="muted">Issued {new Date(cert.issuedAt).toLocaleString()} · WhatsApp: {cert.delivery} ({cert.deliveryAttempts} tries)</div>
              {cert.status === 'REVOKED' ? <div className="err">Cancelled: {cert.revokeReason}</div> : (
                <>
                  <textarea placeholder="Reason for cancelling (recorded permanently)" rows={2} style={{ width: '100%', marginTop: 8 }} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="danger" disabled={reason.trim().length < 3} onClick={async () => {
                    if (!confirm(`Cancel ${cert.certNumber}? This cannot be undone.`)) return;
                    try { await api(`/api/certificates/by-number/${cert.certNumber}/revoke`, { method: 'POST', json: { reason } }); setReason(''); setMsg({ kind: 'ok', text: 'Cancelled. Public verification now shows it as not valid.' }); lookup(); }
                    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
                  }}>Cancel certificate</button>
                </>
              )}
              <h3>History</h3>
              <div className="timeline">{cert.trail.map((t: any) => <div key={t.id}><b>{t.action}</b> · {t.actorName} · <span className="muted">{new Date(t.at).toLocaleString()}</span></div>)}</div>
            </div>
          )}
          {msg && <div className={msg.kind}>{msg.text}</div>}
        </div>
      </div>
      <div>
        <div className="card">
          <h2>What is stuck</h2>
          <div className="muted">Batches waiting at a step longer than {data ? fmt(data.slaMinutes) : '…'} are escalated here automatically.</div>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Batch</th><th>Waiting at</th><th>For</th><th></th></tr></thead>
            <tbody>{data?.waiting.map((w: any) => (
              <tr key={w.id}><td>{w.title}<div className="muted">{w.reference} · {w.centreName}</div></td>
                <td>{STATUS_LABEL[w.status]}</td><td>{fmt(w.waitingMinutes)}</td>
                <td>{w.escalatedAt && <span className="badge esc">Escalated {new Date(w.escalatedAt).toLocaleTimeString()}</span>}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="card">
          <h2>WhatsApp deliveries that gave up</h2>
          {data?.failedDeliveries.length === 0 && <div className="muted">None. Every certificate reached its phone.</div>}
          <table><tbody>{data?.failedDeliveries.map((f: any) => (
            <tr key={f.certificateId}><td>{f.certNumber}</td><td>{f.holderName}</td><td className="muted">{f.attempts} tries · {f.lastError}</td>
              <td><button onClick={() => api(`/api/certificates/${f.certificateId}/retry-delivery`, { method: 'POST' }).catch((e) => alert(e.message))}>Retry</button></td></tr>
          ))}</tbody></table>
        </div>
      </div>
    </div>
  );
}

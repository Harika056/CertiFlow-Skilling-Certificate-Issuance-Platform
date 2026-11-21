import { useEffect, useState } from 'react';
import { api, ago, ApiError, downloadWithAuth, STATUS_LABEL, type Session } from './api';

interface BatchSummary {
  id: string; reference: string; title: string; course: string; status: string; round: number;
  candidateCount: number; stageEnteredAt: string; centreName: string; myVote: string | null;
  approvals: number; escalated: boolean; lastReason: string | null;
}

export function Batches({ session, tick }: { session: Session; tick: number }) {
  const role = session.user.role;
  const [inbox, setInbox] = useState(true);
  const [list, setList] = useState<BatchSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<BatchSummary[]>(`/api/batches${inbox ? '?inbox=1' : ''}`).then(setList).catch((e) => setError(e.message));
  }, [inbox, tick, session.token]);
  useEffect(() => { setSelected(null); }, [session.token]);

  return (
    <div className="grid">
      <div>
        {role === 'CENTRE' && <NewBatch onCreated={(id) => { setInbox(true); setSelected(id); }} />}
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{inbox ? (role === 'CENTRE' ? 'Needs your action' : 'Waiting for you') : 'All I can see'}</h2>
            <button onClick={() => setInbox(!inbox)}>{inbox ? 'Show all' : 'Show my queue'}</button>
          </div>
          <div style={{ marginTop: 12 }}>
            {error && <div className="err">{error}</div>}
            {list.length === 0 && <div className="muted">Nothing here.</div>}
            {list.map((b) => (
              <div key={b.id} className={`list-item ${selected === b.id ? 'sel' : ''}`} onClick={() => setSelected(b.id)}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="t">{b.title}</span>
                  <span className={`badge ${b.status}`}>{STATUS_LABEL[b.status]}</span>
                </div>
                <div className="muted">
                  {b.reference} · {b.candidateCount} candidates · {b.centreName} · {b.status === 'DISTRICT_REVIEW' ? `${b.approvals} approval(s) · ` : ''}
                  at this step {ago(b.stageEnteredAt)}
                </div>
                <div className="row" style={{ marginTop: 4 }}>
                  {b.myVote && <span className="badge">You voted {b.myVote.toLowerCase()}</span>}
                  {b.escalated && <span className="badge esc">Overdue – escalated</span>}
                  {b.round > 1 && <span className="badge">Round {b.round}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div>{selected ? <BatchDetail id={selected} session={session} tick={tick} /> : <div className="card muted">Select a batch to see its details.</div>}</div>
    </div>
  );
}

function NewBatch({ onCreated }: { onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [course, setCourse] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>New batch</h2>
      <div className="row">
        <input placeholder="Batch title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <input placeholder="Course" value={course} onChange={(e) => setCourse(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" disabled={!title || !course} onClick={async () => {
          try { const b = await api('/api/batches', { method: 'POST', json: { title, course } }); setTitle(''); setCourse(''); setErr(null); onCreated(b.id); }
          catch (e) { setErr((e as Error).message); }
        }}>Create</button>
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function BatchDetail({ id, session, tick }: { id: string; session: Session; tick: number }) {
  const [b, setB] = useState<any>(null);
  const [trace, setTrace] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; rows?: any[] } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const role = session.user.role;

  const load = () => {
    api(`/api/batches/${id}`).then(setB).catch((e) => setMsg({ kind: 'err', text: e.message }));
    api(`/api/batches/${id}/trace`).then(setTrace).catch(() => setTrace([]));
  };
  useEffect(() => { setMsg(null); setReason(''); }, [id]);
  useEffect(load, [id, tick]);

  const act = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    setBusy(true);
    try { const r = await fn(); setMsg({ kind: 'ok', text: ok(r) }); setReason(''); load(); }
    catch (e) { const ae = e as ApiError; setMsg({ kind: 'err', text: ae.message, rows: ae.details?.errors }); }
    finally { setBusy(false); }
  };

  if (!b) return <div className="card">Loading…</div>;
  const roundVotes = b.votes.filter((v: any) => v.round === b.round);
  const myOpenVote = roundVotes.find((v: any) => v.actorId === session.user.id && !v.withdrawnAt && v.stage === b.stage);
  const editable = role === 'CENTRE' && (b.status === 'DRAFT' || b.status === 'RETURNED');
  const issued = b.candidates.filter((c: any) => c.certificate);

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{b.title}</h2>
          <span className={`badge ${b.status}`}>{STATUS_LABEL[b.status]}</span>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {b.reference} · {b.course} · {b.centreName} · round {b.round} · {b.candidateCount} candidates
          {b.candidateCount >= b.rules.largeBatchThreshold && ' · large batch: needs quality review'}
        </div>
        {b.status === 'RETURNED' && b.lastReason && <div className="err"><b>Sent back:</b> {b.lastReason}</div>}
        {b.status === 'REJECTED' && b.lastReason && <div className="err"><b>Rejected:</b> {b.lastReason}</div>}

        {editable && (
          <>
            <h3>{b.status === 'RETURNED' ? 'Fix and resubmit' : 'Add candidates'}</h3>
            <div className="muted">Upload the CSV or Excel sheet you already keep. Columns: enrolment_id, full_name, phone, score. Uploading replaces the current list.</div>
            <div className="row" style={{ marginTop: 8 }}>
              <input type="file" accept=".csv,.xlsx" disabled={busy} onChange={(e) => {
                const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f);
                e.target.value = '';
                act(() => api(`/api/batches/${id}/candidates`, { method: 'POST', body: fd }), (r) => `${r.accepted} candidates saved.`);
              }} />
              <button className="primary" disabled={busy || b.candidateCount === 0} onClick={() =>
                act(() => api(`/api/batches/${id}/submit`, { method: 'POST' }), () => 'Sent for district approval.')}>
                {b.status === 'RETURNED' ? 'Resubmit for approval' : 'Send for approval'}
              </button>
            </div>
            {b.status === 'RETURNED' && <div className="muted" style={{ marginTop: 6 }}>Resubmitting starts a new review round: earlier approvals do not carry over.</div>}
          </>
        )}

        {b.stage && (
          <>
            <h3>{b.stage === 'DISTRICT' ? `District review – needs ${b.rules.districtQuorum} officers to agree` : b.stage === 'QUALITY' ? 'Quality review' : 'State office – final decision'}</h3>
            <table><tbody>
              {roundVotes.filter((v: any) => v.stage === b.stage).map((v: any) => (
                <tr key={v.id}><td>{v.actorName}</td><td><span className="badge">{v.decision}</span></td>
                  <td className="muted">{v.reason}{v.withdrawnAt && <> · <i>withdrawn: {v.withdrawReason}</i></>}</td><td className="muted">{ago(v.createdAt)}</td></tr>
              ))}
            </tbody></table>
            {b.canAct && !myOpenVote && (
              <div style={{ marginTop: 8 }}>
                <textarea placeholder="Reason (required to send back or reject)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={{ width: '100%' }} />
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="primary" disabled={busy} onClick={() => act(() => api(`/api/batches/${id}/votes`, { method: 'POST', json: { decision: 'APPROVE', expectedRound: b.round } }),
                    (r) => r.moved ? `Approved – batch moved to ${r.status}.` : `Approval recorded (${r.votes}/${r.needed}).`)}>Approve</button>
                  <button disabled={busy || !reason.trim()} onClick={() => act(() => api(`/api/batches/${id}/votes`, { method: 'POST', json: { decision: 'RETURN', reason, expectedRound: b.round } }),
                    () => 'Sent back to the centre.')}>Send back</button>
                  <button className="danger" disabled={busy || !reason.trim()} onClick={() => act(() => api(`/api/batches/${id}/votes`, { method: 'POST', json: { decision: 'REJECT', reason, expectedRound: b.round } }),
                    (r) => r.moved ? 'Batch rejected.' : `Rejection recorded (${r.votes}/${r.needed}).`)}>Reject</button>
                </div>
              </div>
            )}
            {myOpenVote && (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="muted">You voted <b>{myOpenVote.decision}</b>. Made a mistake?</span>
                <button disabled={busy} onClick={() => {
                  const r = prompt('Why are you withdrawing your decision?'); if (!r) return;
                  act(() => api(`/api/batches/${id}/votes/withdraw`, { method: 'POST', json: { reason: r } }), () => 'Your decision was withdrawn. You can decide again.');
                }}>Withdraw my vote</button>
              </div>
            )}
            {!b.canAct && role !== 'CENTRE' && <div className="muted" style={{ marginTop: 6 }}>This step is not yours.</div>}
          </>
        )}
        {msg && <div className={msg.kind}>{msg.text}
          {msg.rows && <table style={{ marginTop: 8 }}><thead><tr><th>Row</th><th>Field</th><th>Value</th><th>Problem</th></tr></thead>
            <tbody>{msg.rows.map((r: any, i: number) => <tr key={i}><td>{r.row || '–'}</td><td>{r.field}</td><td>{r.value}</td><td>{r.message}</td></tr>)}</tbody></table>}
        </div>}
      </div>

      {issued.length > 0 && (
        <div className="card">
          <h2>Certificates</h2>
          <div className="kpi">
            <div><b>{issued.length}</b>issued</div>
            <div><b>{issued.filter((c: any) => c.certificate.pdfStatus === 'READY').length}</b>PDFs ready</div>
            <div><b>{issued.filter((c: any) => c.certificate.delivery === 'SENT').length}</b>on WhatsApp</div>
            <div><b>{issued.filter((c: any) => c.certificate.delivery === 'FAILED').length}</b>failed</div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Candidates</h2>
        <table>
          <thead><tr><th>Row</th><th>Enrolment</th><th>Name</th><th>Phone</th><th>Score</th><th>Certificate</th></tr></thead>
          <tbody>{b.candidates.map((c: any) => (
            <tr key={c.id}><td>{c.rowNumber}</td><td>{c.enrolmentId}</td><td>{c.fullName}</td><td>{c.phone}</td><td>{c.score}</td>
              <td>{c.certificate ? <>
                {c.certificate.certNumber} <span className={`badge ${c.certificate.status}`}>{c.certificate.status}</span>{' '}
                <span className={`badge ${c.certificate.delivery}`}>WhatsApp: {c.certificate.delivery}{c.certificate.attempts > 1 ? ` (${c.certificate.attempts} tries)` : ''}</span>
                {(role === 'CENTRE' || role === 'STATE') && c.certificate.pdfStatus === 'READY' &&
                  <> <a href="#" onClick={(e) => { e.preventDefault(); downloadWithAuth(`/api/certificates/${c.certificate.id}/pdf`, `${c.certificate.certNumber}.pdf`).catch((er) => alert(er.message)); }}>PDF</a></>}
              </> : <span className="muted">–</span>}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div className="card">
        <h2>Trace – everything that happened to this batch</h2>
        <div className="timeline">
          {trace.map((t) => (
            <div key={t.id}><b>{t.action}</b> · {t.actorName} · <span className="muted">{new Date(t.at).toLocaleString()} · trace {t.traceId.slice(0, 8)}</span>
              {Object.keys(t.details ?? {}).length > 0 && <div className="muted">{JSON.stringify(t.details)}</div>}</div>
          ))}
        </div>
      </div>
    </>
  );
}

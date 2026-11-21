import { useEffect, useState } from 'react';

/** Public page: no login, no token is sent. */
export function VerifyPage({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode ?? '');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const check = async (c = code) => {
    setErr(null); setRes(null);
    const r = await fetch(`/api/public/verify/${encodeURIComponent(c.trim().toUpperCase())}`);
    const d = await r.json();
    if (!r.ok) setErr(d?.error?.message ?? 'Could not check right now'); else setRes(d);
  };
  useEffect(() => { if (initialCode) check(initialCode); }, [initialCode]);

  return (
    <div className="card" style={{ maxWidth: 640, margin: '0 auto' }}>
      <h2>Is this certificate genuine?</h2>
      <div className="muted">Enter the 12-character verification code printed on the certificate (or scan its QR code). No login needed.</div>
      <div className="row" style={{ marginTop: 12 }}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. K7M2QX9PRT4B" style={{ flex: 1, fontSize: 18, letterSpacing: 2 }} />
        <button className="primary" onClick={() => check()} disabled={!code.trim()}>Check</button>
      </div>
      {err && <div className="err">{err}</div>}
      {res && (
        <div className={`verify-result ${res.result}`}>
          <div className="big">
            {res.result === 'VALID' && '✔ Genuine and valid'}
            {res.result === 'REVOKED' && '✖ Cancelled – NOT valid'}
            {res.result === 'NOT_FOUND' && '✖ No certificate with this code'}
          </div>
          {res.certificate && (
            <table><tbody>
              <tr><th>Name</th><td>{res.certificate.holderName}</td></tr>
              <tr><th>Course</th><td>{res.certificate.course}</td></tr>
              <tr><th>Training centre</th><td>{res.certificate.centreName}</td></tr>
              <tr><th>Certificate no.</th><td>{res.certificate.certNumber}</td></tr>
              <tr><th>Issued</th><td>{new Date(res.certificate.issuedAt).toLocaleDateString()}</td></tr>
              {res.certificate.revokedAt && <tr><th>Cancelled</th><td>{new Date(res.certificate.revokedAt).toLocaleString()}</td></tr>}
            </tbody></table>
          )}
          <div className="muted" style={{ marginTop: 8 }}>Checked {new Date(res.checkedAt).toLocaleString()}. Compare the name with the person's ID.</div>
        </div>
      )}
    </div>
  );
}

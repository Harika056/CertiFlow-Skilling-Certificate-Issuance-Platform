export type Role = 'CENTRE' | 'DISTRICT_OFFICER' | 'QUALITY' | 'STATE';

export interface Session { token: string; user: { id: string; displayName: string; role: Role } }

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
}

let token: string | null = sessionStorage.getItem('cf_token');
export const setToken = (t: string | null) => {
  token = t;
  if (t) sessionStorage.setItem('cf_token', t); else sessionStorage.removeItem('cf_token');
};
export const getToken = () => token;

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  let body = init.body;
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(path, { ...init, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.details);
  return data as T;
}

/** Download a protected file with the bearer token. */
export async function downloadWithAuth(path: string, filename: string) {
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) { const d = await res.json().catch(() => null); throw new ApiError(res.status, d?.error?.message ?? 'Download failed'); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export const ROLE_LABEL: Record<Role, string> = {
  CENTRE: 'Training centre', DISTRICT_OFFICER: 'District officer', QUALITY: 'Quality team', STATE: 'State office',
};

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', DISTRICT_REVIEW: 'With district', QUALITY_REVIEW: 'With quality team', STATE_REVIEW: 'With state office',
  RETURNED: 'Sent back', REJECTED: 'Rejected', APPROVED: 'Approved – issuing', ISSUED: 'Certificates issued',
};

export function ago(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

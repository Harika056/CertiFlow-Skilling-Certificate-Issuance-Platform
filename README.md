# CertiFlow – Skilling Certificate Issuance Platform

CertiFlow decides who gets certified, issues the certificate to the candidate's WhatsApp, and lets anyone check that a certificate is genuine. The flow runs through a centre upload, a district quorum, a quality check for large batches and a final state approval. Every decision is on record.

> **Quick start:** `docker compose up --build`, then open **http://localhost:8080** and click a person at the top.
> Full guide: [SETUP.md](SETUP.md) · Production plan: [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 1. Requirements note

### 1.1 What I understood the programme office to need

| # | Need (from the brief) | What it means in the system |
|---|---|---|
| R1 | Centres upload passed batches from their own spreadsheet and send them for approval | Upload a CSV/XLSX file. **All rows are validated before anything is saved.** The centre gets a row-by-row error list. Submit, see the status live, fix and resubmit when sent back. |
| R2 | District officers check batches, and a district decision needs more than one officer | Officers see only their district. **Approve and reject need 2 distinct officers** (configurable, `DISTRICT_QUORUM`). |
| R3 | Big batches need extra scrutiny | Batches with **≥ 50 candidates** (`LARGE_BATCH_THRESHOLD`) go to the quality team after the district. |
| R4 | The state office has the final say and deals with what goes wrong | Final approval, a "what is stuck" desk, certificate cancellation, retry of failed deliveries. |
| R5 | Certificates reach candidates on WhatsApp straight away | Approval publishes an event. Workers create certificates, render PDFs and send WhatsApp messages with retries. The person approving never waits. |
| R6 | Officers make mistakes and must be able to fix them | An officer can **withdraw their own vote** while the step is still open. After a step completes, a later reviewer sends the batch back. A wrongly issued certificate is **cancelled** by the state office. |
| R7 | Anyone can check a certificate, without logging in | Public `/verify/<code>` page and QR code on the PDF. Shows only name, course, centre, number and dates. |
| R8 | Files sitting with officers is the biggest complaint | SLA scan. Anything waiting longer than `SLA_MINUTES` at one step is **escalated once** to the state office automatically. |
| R9 | Everyone sees changes as they happen | Server-Sent Events, fanned out through Redis pub/sub so it works with many API instances. |

### 1.2 Decisions where the brief was unclear

| ID | Question | Decision | Why |
|---|---|---|---|
| D1 | What counts as a "district decision needing more than one officer"? | **Approve** and **Reject** need `DISTRICT_QUORUM` (2) distinct officers of that district. **Send back** needs only one. | Approving and rejecting are the consequential decisions. Sending back is cheap to undo (the centre resubmits), and making a second officer confirm an obvious typo would recreate the delay the office complains about. |
| D2 | What if three officers approve at once? | The first two count and the batch moves **once**. The third gets a clear `409 "already moved on"`. | Implemented with a row lock on the batch (`SELECT … FOR UPDATE`), so the quorum is counted inside one serialised transaction. |
| D3 | What is a "big batch"? | ≥ 50 candidates (configurable). | A round number that the 60-candidate example in the brief crosses. |
| D4 | **Send back → fix → resubmit: what happens to approvals it already had?** | **They are discarded.** Each submission is a new *review round*. Votes belong to a round, so round-2 needs a fresh quorum at every step. Old votes stay in the audit trail. | After a resubmit the candidate list may be different. An approval was given to *that content*, so carrying it over would mean certifying people nobody reviewed. The cost (officers re-approve) is small because the fix is usually small, and the officer can see the earlier round's history. |
| D5 | How do officers "fix mistakes"? | Withdraw your own vote (with a reason) while the step is open. Once the step has completed, the next reviewer can send it back. Issued certificates can only be **cancelled** (never edited or reinstated) by the state office. | Keeps every decision traceable. Nothing is silently overwritten. |
| D6 | Who is "someone senior" for overdue files? | The state office. Escalations appear on the State desk with a live notification, are recorded in the audit log, and are raised **once per batch per step per round**. | In-app only for now. Email/SMS would be another event consumer (see limitations). |
| D7 | What does a public verifier see? | Valid / cancelled / not found, plus holder name, course, centre, number and dates. **Never** phone, score or enrolment id. Lookup is by a **random 12-character code** printed on the certificate, not by the sequential number. | An employer needs the name to compare with ID. Sequential numbers would let anyone enumerate every certificate. |
| D8 | How does the candidate download the PDF without an account? | The WhatsApp message carries a **signed, expiring (30-day) download link**. Cancelled certificates can't be downloaded. | No accounts for 8,000 people a month. The link is unguessable and tied to one certificate. |
| D9 | Can someone be certified twice? | No. There is one certificate per candidate row (`UNIQUE(candidate_id)`), and also one per *centre + enrolment id + course* (`UNIQUE(enrolment_key)`). Upload also refuses already-certified enrolments. | Stops a centre re-submitting the same people in a new batch. |
| D10 | Which rows are "bad"? | Missing columns, invalid Indian mobile, score not a number or below the pass mark (40), duplicate enrolment id, names with formula characters (`=`, `+`, `@`…) or junk. | Anything that would put a wrong certificate on a phone, or poison a later spreadsheet export. |

### 1.3 How each "moment that must work" is met

| Moment | How | Proved by |
|---|---|---|
| 1. Bad rows | Whole file parsed and validated in memory. Any error → `422` with row/field/value/message, and nothing is written (the transaction rolls back). | `workflow.int.test.ts › Moment 1` |
| 2. Simultaneous approvals | Row lock + partial unique index `(batch, round, stage, actor) WHERE not withdrawn` | `› Moment 2` (3 officers fire at once, exactly 1 transition, 1 event) |
| 3. 60 candidates, unreliable WhatsApp | Outbox → queue, idempotent handlers, one delivery row per certificate, **stable idempotency key** reused on every retry, exponential backoff | `issuance.int.test.ts › Moment 3`: real workers, mock with 30 % errors + 20 % timeouts. Each of 60 phones has exactly 1 message. Also replays every step. |
| 4. Cancel, then employer checks | DB update then cache delete after commit, plus a 30 s cache TTL as a backstop if Redis is down | `› Moment 4` (cached VALID → revoke → REVOKED immediately). A DB trigger forbids un-revoking. |
| 5. File sits too long | Repeatable job scans every 30 s. `UNIQUE(batch, round, status)` on escalations. | `› Moment 5` (3 concurrent scanners raise 1 escalation) |
| 6. Send back, fix, resubmit | Round-scoped votes (D4) | `› Moment 6` |

### 1.4 "Things that must never happen"

| Never | Guard |
|---|---|
| Acting at a step that is not yours / as someone else | Identity only from a signed JWT (HS256 pinned, issuer checked). Role and scope **re-read from DB every request**. Per-stage `canReview` (role and district). Strict request schemas reject extra fields like `actorId`. |
| Two certificates for a candidate / two sharing a number | `UNIQUE(candidate_id)`, `UNIQUE(enrolment_key)`, numbers from a Postgres **sequence** |
| Cancelled certificate shown as genuine | Cache invalidation, short TTL, `certificate_guard` trigger (no reinstating, identity fields immutable) |
| Stranger gets someone's certificate or details | Random verify codes, signed download links, phones masked for everyone except the owning centre, drafts private, other districts' batches return 404 (not 403, so no existence leak), per-IP rate limit on public endpoints |
| Untraceable decision | Append-only `audit_log` (a DB trigger blocks UPDATE/DELETE) with actor, time, details and **trace id** |

---

## 2. How it is put together

```
 Browser (React/Vite) ──HTTP──▶ API (Express/TS) ──tx──▶ PostgreSQL
        ▲   SSE                    │ writes state + OUTBOX row in ONE transaction
        │                          ▼
        └── Redis pub/sub ◀── Worker: outbox relay ──▶ BullMQ queues (Redis)
                                   │                    ├─ issuance  : create certificates (idempotent)
                                   │                    ├─ pdf       : render PDF → storage
                                   │                    └─ whatsapp  : send w/ retries + idempotency key ──▶ WhatsApp provider (mock)
                                   └─ repeatable SLA scan → escalations
```

**Services (one backend image, chosen by command):** `api`, `worker` (scale freely), `whatsapp` (stand-in provider), plus `postgres`, `redis`, `web` (nginx serving the React build and proxying `/api`).

### Key technical decisions

| Decision | Why |
|---|---|
| **Transactional outbox** (Postgres) → relay → **BullMQ** | A state change and its event commit together, so we never "approved but forgot to issue" or "issued an event for a rolled-back change". The relay uses `FOR UPDATE SKIP LOCKED` (many relays are safe) and deterministic job ids (a crash between enqueue and mark-published can't double-enqueue). |
| BullMQ on Redis as the queue | It was already needed for caching. It gives retries, exponential backoff, delayed jobs, stalled-job recovery (a worker killed mid-job gets its job re-run elsewhere), repeatable jobs and a global rate limiter. Kafka/RabbitMQ would add an extra system with no benefit at this scale. |
| **Separate queues** per kind of work | A WhatsApp outage (thousands of retrying jobs) never delays certificate creation or PDFs. |
| Every handler is **idempotent** | At-least-once delivery is the realistic guarantee. Exactly-once *effects* come from unique constraints, status checks and the provider idempotency key. |
| **Row lock** for votes, not optimistic retries | Votes per batch are low-contention. A lock gives the simplest correct quorum count. |
| **Drizzle ORM** + SQL migrations | Plain SQL migrations (incl. triggers, partial indexes, sequence) are reviewed like code. No binary query engine in the container. |
| Redis uses | queues · verification cache · rate limiting · realtime pub/sub |
| **SSE** instead of WebSockets | One-way server→browser is all we need. It works through proxies and auto-reconnects. Events carry ids only and the browser refetches through the authorised API, so the event stream can't leak data. |
| Trace id | Generated per request (`x-request-id`), stored on outbox events, carried onto jobs, written on every audit row and log line. `GET /api/batches/:id/trace` shows the full story of a batch. |

### Data model (main tables)
`batches` (status, round, stage_entered_at) · `candidates` · `review_votes` (round, stage, decision, withdrawn_at) · `certificates` (number, verification_code, status) · `deliveries` (status, attempts, provider id) · `outbox` · `audit_log` · `escalations`.
Migrations: `backend/drizzle/`.

### API (main)
| Method | Path | Who |
|---|---|---|
| POST | `/api/batches` · `/api/batches/:id/candidates` · `/api/batches/:id/submit` | Centre |
| POST | `/api/batches/:id/votes` `{decision, reason?, expectedRound?}` · `/votes/withdraw` | Officer / Quality / State, at their step |
| GET | `/api/batches?inbox=1` · `/api/batches/:id` · `/api/batches/:id/trace` | Anyone who can see the batch |
| GET/POST | `/api/state/stuck` · `/api/certificates/by-number/:n/revoke` · `/api/certificates/:id/retry-delivery` | State |
| GET | `/api/public/verify/:code` · `/api/public/certificates/download/:token` | **Public** |
| GET | `/api/events` (SSE) | Signed-in users |

---

## 3. Tests

`25 tests`, run against **real PostgreSQL and Redis** (no mocks of our own code). The WhatsApp provider is the chaotic stand-in.

```
cd backend && npm test                                  # with local Postgres/Redis
docker compose --profile test run --rm tests            # fully in containers
```

| File | Covers |
|---|---|
| `tests/unit.test.ts` | Spreadsheet validation, phone normalisation, workflow rules |
| `tests/workflow.int.test.ts` | Moments 1, 2, 6. Wrong role/district/stage, forged tokens, smuggled identity fields, data visibility, vote withdrawal, immutable audit log |
| `tests/issuance.int.test.ts` | Moments 3, 4, 5. Exactly-once under replay, no double certification across batches, revoke permissions, unguessable verify / forged download links |

## 4. Using the demo

Switch people with the buttons at the top:

| Person | Role | Try |
|---|---|---|
| **Anika** | Training centre | Create a batch → upload `samples/bad_batch.csv` (see the row errors) → upload `samples/good_batch_10.csv` → Send |
| **Dev / Meera / Kabir** | District officers (North) | Approve the same batch from two tabs. Withdraw a vote. Send back with a reason. |
| **Neha** | Quality team | Approve the 60-candidate batch after the district |
| **Farah** | State office | Final approval. State desk: stuck files, escalations, cancel a certificate, retry failed deliveries |
| Ravi / Omar | *Extra:* centre + officer in South district | Show that other districts' data is invisible |

**Candidate phones (demo)** tab shows exactly what each phone received and lets you start a WhatsApp outage. **Verify a certificate** is the public page (no login needed).

## 5. AI usage

I used an AI assistant (Claude) to scaffold most of the code, the tests and the docs from my requirements note and decisions. I checked its output by:
- **Running it:** the full test suite against real Postgres/Redis, plus manual end-to-end runs through every role in the UI.
- **Breaking it on purpose:** the chaos mock WhatsApp, three concurrent approvers, replaying every job, forged tokens and tampered bodies.
- **Reading every file** and changing what I didn't agree with. Examples: late reviewers got a 403 where a 409 is right, and tests shared queue job ids across DB resets.
- Keeping the important rules in the **database** (unique indexes, triggers), so correctness doesn't depend only on generated application code.

## 6. Known limitations and next steps (honest list)

- **Demo login has no passwords.** Production would use the state's SSO/OIDC, with MFA for officers. `DEMO_LOGIN_ENABLED=false` turns the demo login off.
- **Real WhatsApp Cloud API has no idempotency key.** The mock does. In production we would send a *template* message, store the returned message id, and on a timeout first reconcile against delivery-status webhooks before retrying. Without a provider-side key, "exactly once on the phone" becomes "at most one *extra* message in a rare timeout race".
- **PDFs live on a shared Docker volume.** Production uses private S3 with short-lived presigned URLs (see DEPLOYMENT.md).
- **SSE token is passed in the query string** (EventSource can't set headers). It should be a short-lived single-use ticket so tokens never appear in access logs.
- Escalations notify **in-app only**. Email/SMS to the district head would be another consumer of `BatchEscalated`.
- Re-uploading replaces the whole candidate list. There's no single-row editing in the UI.
- Lists are capped at 200 rows (no pagination yet). There's no admin UI for users, centres or districts (seeded).
- If the worker is down, live updates pause (the API still works, refresh shows truth) and certificates queue up until it returns.
- The mock provider keeps its state in memory, so restarting it forgets idempotency keys.
- A few warnings in test logs come from leftover retry jobs of a previous test after the DB is reset. They're harmless but noisy.

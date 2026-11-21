# Local setup guide

Goal: from a fresh clone to a running system with demo data and passing tests.

## 1. Install (once)

| Tool | Version | Needed for |
|---|---|---|
| **Git** | any recent | cloning |
| **Docker Desktop** (Windows/macOS) or Docker Engine + **Compose v2** (Linux) | Docker 24+ | running everything |
| Node.js | 22 LTS | *optional*: only to run tests or code outside Docker |

On Windows, let Docker Desktop enable **WSL 2**. You do **not** need to install PostgreSQL or Redis. They run in containers.

Free ports needed: **8080** (UI), **4000** (API), **4100** (mock WhatsApp), **5432** (Postgres), **6379** (Redis).
If 5432 or 6379 is already used by a local install, stop that service or change the left-hand port in `docker-compose.yml`.

## 2. Run the system (one command)

```bash
git clone <this-repo-url> certiflow
cd certiflow
docker compose up --build
```

First build takes a few minutes. When `api` reports healthy:

- **UI:** http://localhost:8080. Click a person (Anika, Dev, Meera, Kabir, Neha, Farah) at the top.
- **API health:** http://localhost:4000/ready
- **Mock WhatsApp stats:** http://localhost:4100/v1/stats

What happens on start:
1. `migrate` applies the SQL migrations and loads demo data (idempotent), then exits.
2. `api`, `worker`, `whatsapp` and `web` start.
3. The worker immediately issues and delivers the 5 certificates of the seeded *"Beauty & Wellness – approved"* batch, and escalates the seeded *"Plumbing – waiting 3 days"* batch.

Useful variations:
```bash
docker compose up --build --scale worker=3          # several workers, still exactly-once
MOCK_FAIL_RATE=0.5 docker compose up --build        # a much flakier WhatsApp
SLA_MINUTES=2 docker compose up --build             # see escalations after 2 minutes
docker compose down -v                              # stop and wipe all data
```

## 3. Run the tests

**In containers (no Node needed):**
```bash
docker compose up -d postgres redis
docker compose --profile test run --rm tests
```

**Or with Node 22 on your machine** (uses the same compose Postgres/Redis):
```bash
docker compose up -d postgres redis
cd backend
npm ci
TEST_DATABASE_URL=postgres://certiflow:certiflow@localhost:5432/certiflow_test npm test
```
The test database `certiflow_test` is created automatically by `scripts/init-test-db.sql` the first time the Postgres volume is created. If you created the volume before this file existed, run `docker compose down -v` once.

Expected result: `Tests 25 passed (25)`.

## 4. Develop without Docker for the app (optional)

```bash
docker compose up -d postgres redis
cd backend && npm ci
export DATABASE_URL=postgres://certiflow:certiflow@localhost:5432/certiflow
npm run build && npm run migrate && npm run seed
npx tsx src/mock-whatsapp/server.ts &      # :4100
npm run dev:worker &                       # worker
npm run dev                                # API :4000
cd ../frontend && npm ci && npm run dev    # UI http://localhost:5173
```

## 5. Sample files

`samples/good_batch_10.csv`, `samples/good_batch_60.csv` (large: goes to the quality team), and `samples/bad_batch.csv` (4 deliberate errors: bad phone, formula injection, below pass mark, duplicate id).

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` | Another program uses that port. Stop it or change the port mapping. |
| UI loads but no people shown | API not ready yet. Wait for `api` healthy (`docker compose ps`). |
| Tests fail with `database "certiflow_test" does not exist` | `docker compose down -v && docker compose up -d postgres redis` |
| Want a clean slate | `docker compose down -v` |

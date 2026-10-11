# Clinical Evaluation Workstation (synthetic-only)

This is a login-protected, production-style interaction surface for engineering work with synthetic longitudinal cases. The patient cards and encounters are generated data; the interface labels them **模拟患者**. It is not an EMR connection, an OIDC deployment, a clinical validation study, or a production patient service.

## Local configuration

Use the repository-root `.env`, which is ignored by Git. Do not paste credentials into source files or commit the file. Every account below must be a synthetic test identity, and every password must be replaced with a unique random value of at least 12 characters.

```dotenv
HUIYI_APP_ENV=clinical-evaluation
HUIYI_DEMO_BACKEND=dsh
HUIYI_EVAL_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
HUIYI_EVAL_PATIENT_COUNT=300
HUIYI_EVAL_TURN_COUNT=8
HUIYI_EVAL_ENCOUNTER_COUNT=3
HUIYI_EVAL_DATASET_SEED=huiyi-clinical-evaluation-v1
HUIYI_EVAL_USERS_JSON='[{"username":"clinician-a","password":"REPLACE_WITH_A_RANDOM_SECRET_1","subjectId":"synthetic-user-a","displayName":"模拟临床用户 A","tenantId":"evaluation-tenant-1","accessGroup":"cohort-a","role":"clinician"},{"username":"clinician-b","password":"REPLACE_WITH_A_RANDOM_SECRET_2","subjectId":"synthetic-user-b","displayName":"模拟临床用户 B","tenantId":"evaluation-tenant-1","accessGroup":"cohort-b","role":"clinician"}]'
```

The account records are intentionally explicit. `tenantId` partitions organizations and `accessGroup` partitions the assigned synthetic patient cohort within a tenant. `administrator` can see every generated case in its tenant; clinicians see only their access group. Do not use a shared account when testing isolation.

If the Gateway process itself has `NODE_ENV=production`, it also requires `HUIYI_ENABLE_SYNTHETIC_EVALUATION_IN_PRODUCTION=1` before accepting `HUIYI_APP_ENV=clinical-evaluation`. This second explicit switch prevents a production Node runtime from silently falling back into development or synthetic evaluation mode.

```powershell
pnpm clinical-evaluation:dev
```

Open `http://127.0.0.1:5173`. The frontend and Gateway are loopback-only in the current local run configuration. The Gateway refuses to start in clinical-evaluation mode without configured accounts and a DSH backend. Supply model-provider credentials/configuration separately through the existing runtime settings; never put a model API key in the account JSON.

To build the staging-style interface and check its emitted assets:

```powershell
pnpm clinical-evaluation:build
```

## Identity, patient, and encounter ownership

1. A successful login creates a random opaque token. Only its SHA-256 hash is kept in the in-memory auth registry; the browser receives an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api` (and `Secure` when configured for HTTPS/production Node mode).
2. The server resolves the principal, tenant, role, and access group from that cookie. The browser cannot submit or override these identity fields.
3. Patient list, encounter list, and context routes filter on tenant and access group. An inaccessible patient or Encounter returns 404, the same response used for a missing record.
4. `POST /api/sessions` creates a random server-side binding between the authenticated login session, subject, tenant, patient, and Encounter. Chat validates that binding on every request; copying a session ID to another login, patient, or Encounter is rejected before the DSH backend runs.
5. Cancel is limited to a run owned by that login session. Logout revokes its auth and work sessions, aborts its active runs, and closes its DSH sessions.

The in-memory session registry is intentionally suitable only for one local process. Restarting the Gateway invalidates sessions. Multi-process persistence, durable audit, OIDC, institutional roles, EMR/FHIR authorization, key rotation, and a production deployment review are future work and remain disabled/unimplemented. The evaluation password hasher is a lightweight local account mechanism; it is not a substitute for an institutional identity provider.

## Synthetic data generation

The Gateway generates its in-memory patient set deterministically from `HUIYI_EVAL_PATIENT_COUNT`, `HUIYI_EVAL_TURN_COUNT`, `HUIYI_EVAL_ENCOUNTER_COUNT`, and `HUIYI_EVAL_DATASET_SEED`. Defaults are 300 patients, 8 disclosure turns per Encounter, 3 Encounters per patient, and seed `huiyi-clinical-evaluation-v1`.

Generate a local JSON snapshot (the default path is ignored by Git):

```powershell
pnpm clinical-evaluation:dataset
pnpm --filter @huiyi/demo-gateway clinical-evaluation:dataset -- --count 300 --turns 8 --encounters 3 --seed huiyi-clinical-evaluation-v1 --out data/clinical-evaluation/dataset.json
```

The versioned JSON shape is specified by [clinical-evaluation-dataset.schema.json](./schemas/clinical-evaluation-dataset.schema.json). It includes `turnPlan` disclosure prompts for controlled simulation, so treat the snapshot as private test material even though it is synthetic. The interactive patient and Encounter APIs intentionally expose only summaries and patient context; they do not expose `turnPlan`, `patientMessage`, or `factToDisclose` to the clinical assistant UI. Do not execute the 300-patient end-to-end evaluation as part of building or smoke-testing this workstation.

## Fail-closed production boundary

`HUIYI_APP_ENV=production` remains a separate mode. It does not enable these synthetic accounts, the synthetic dataset, or the clinical-evaluation routes. Production still rejects fixture backend and synthetic AMA memory and returns the existing unavailable response for chat until a real authenticated patient-context adapter is implemented. Setting `HUIYI_APP_ENV=clinical-evaluation` is an explicit local evaluation choice; it is not an alias or fallback for production.

This mode can exercise the interactive Gateway/DSH path with generated cases and the configured local/API model provider. It does not by itself prove persistence isolation in Health Engine, full multi-Encounter AMA behavior, clinical task completion, deployment ingress security, or suitability for real patient information.

## Build verification

On 2026-10-11, the installed Vite 6.4.4 toolchain built both `production` and `clinical-evaluation` modes successfully from `apps/demo-web/`; the production-copy checker passed across all five emitted files in both modes. Production required the genuine empty-patient state and privacy/disclaimer copy while excluding demo strings and seed-patient identifiers; clinical-evaluation retained its simulated-patient labels. The Vite client environment now exposes only `VITE_*` plus the explicitly defined public API base; production and evaluation bundles contain none of the checked Gateway/model API-key environment names. Frontend TypeScript checking passed and Vitest reported 8/8 component tests passing. The production build emitted a 225.80 kB app chunk and a 595.23 kB production-workspace chunk (178.43 kB gzip); Vite reported its advisory 500 kB chunk warning. No dependencies, models, or corpora were downloaded. This validates the frontend bundles and copy scan only; it does not validate the production Gateway or real patient access.

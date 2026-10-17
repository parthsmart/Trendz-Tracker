# Implementation Plan: Connect Live Supabase Project & Credentials

Safely integrate the user's Supabase project credentials into the client configuration and server environment, while strictly upholding **Constraint #2 ("Never put secret keys in browser code")**.

> [!IMPORTANT]
> **Working Rules Protocol Activated**: In accordance with the system rules, no code or credential files will be modified until this plan and its alternatives have been reviewed and approved by you.

---

## 1. Credentials Detected

From your environment settings, the following credentials were provided:
- **Supabase URL**: `https://ctwjujnqxkhononxykdc.supabase.co/rest/v1/`
- **Publishable / Anon Key**: `sb_publishable_jKPhD4j4mfiAlKu7ljyLbQ_iqJnvcyw`
- **Service Role Secret Key**: `sb_secret_ZsB313D1a41oxCgZ5Xd5vw_f2tbyDI2`

---

## 2. Key Product Decisions & Alternatives Considered

### Decision 1: Project URL Normalization
- **Context**: The URL provided ends with `/rest/v1/` (`https://ctwjujnqxkhononxykdc.supabase.co/rest/v1/`). Supabase client SDKs require the base project domain (e.g. `https://ctwjujnqxkhononxykdc.supabase.co`) because the SDK appends `/auth/v1`, `/rest/v1`, and `/storage/v1` internally. Passing `/rest/v1` directly causes authentication requests to fail with `404 Not Found` (e.g. attempting to hit `/rest/v1/auth/v1/...`).
- **Chosen Approach**: Normalize the URL to `https://ctwjujnqxkhononxykdc.supabase.co` by stripping `/rest/v1/` or trailing slashes in both `js/config.js` and server utilities (`api/_supabaseAdmin.js`).
- **Alternatives Considered**:
  - *Keep the exact string with `/rest/v1/`*: Rejected because it breaks Supabase Auth and PostgREST client libraries.
  - *Hardcode regex replacement in every fetch call*: Rejected in favor of central normalization at the configuration source.

### Decision 2: Secret Key Isolation (Upholding Constraint #2)
- **Context**: `CONSTRAINTS.md` states: *"The Supabase Service Role Key must NEVER enter client-side browser code or front-end configuration files."*
- **Chosen Approach**:
  - `js/config.js` will receive **only** the canonical Project URL and the public `SUPABASE_ANON_KEY`.
  - `.env` will receive the `SUPABASE_SERVICE_ROLE_KEY` for server-side Node.js execution (`server.ts` and `/api/*` Vercel functions).
- **Alternatives Considered**:
  - *Putting all three keys into `js/config.js`*: Rejected as a critical security breach of the children's data governance constitution.

---

## 3. Step-by-Step Changes Planned

1. **Update `js/config.js`**:
   - Set `url: "https://ctwjujnqxkhononxykdc.supabase.co"`.
   - Set `anonKey: "sb_publishable_jKPhD4j4mfiAlKu7ljyLbQ_iqJnvcyw"`.
   - Add URL sanitizer to strip trailing `/rest/v1` or `/` automatically so any future raw copy-pastes also work seamlessly.

2. **Create / Update `.env`**:
   - Store `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` for serverless API handlers and local development.

3. **Harden `api/_supabaseAdmin.js`**:
   - Ensure the server-side client normalizes `process.env.SUPABASE_URL` to strip any trailing `/rest/v1` or `/`.

4. **Verify Connectivity**:
   - Test that the client initializes the real Supabase client rather than Demo Mode.
   - Run compilation and linting to ensure zero regressions.

5. **Update `docs/HANDOVER.md`**:
   - Record that the live Supabase project credentials have been configured with strict secret isolation.

---

## 4. Review & Approval Gate
Please confirm if you approve this plan to configure the credentials and sanitize the project URL.

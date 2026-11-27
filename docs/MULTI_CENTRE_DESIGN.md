# Multi-centre role hierarchy: design (Phase 1, for approval)

Status: **draft, nothing built yet.** Audit done against live Supabase `kgzivhavpsvitwrscrrj` and `main` @ e91e252 on 2026-11-27.

---

## 1. What exists today (audit)

**People (live):** 1 admin (you), 1 teacher, 25 students. No other roles.

**Roles:** `profiles.role` is free text: `admin | teacher | student`. A trigger (`profiles_guard`) stops anyone changing `role` from the site, so today roles change only by SQL or service-role API.

**Helpers:** `is_admin()` (role = admin and active), `is_teacher(uid)`, `has_teacher_permission(uid, perm)` (11 permission columns in `teacher_permissions`), `is_teacher_assigned_to_student`, `xp_can_view(student)`.

**RLS:** on for all 74 public tables.
- About 100 policies use `is_admin()`. Admin means "sees and edits everything".
- About 20 policies skip `is_admin()` and test `profiles.role = 'admin'` inline. These are on homework, live classes, `teacher_permissions`, `teacher_student_assignments`, `student_messages`, `score_correction_requests`, `attendance_audit` and `teacher_audit_log`. All of them have to be rewritten too.
- 13 tables have RLS on but no policies, so only the service role can reach them: duels, jmcwc_*, xp_seasons, league_weeks and others.
- Teachers are already scoped by `teacher_student_assignments`. That model works and is kept.

**SQL functions:** 181 references to `is_admin()` or `role = 'admin'` across 28 migrations. There are about 60 SECURITY DEFINER RPCs (admin_*, leaderboard, duel_options, class_vs_class, league_board, star_of_month, daily_challenge_board, reward_*). Many read *all* students with `WHERE role = 'student'` and no scope.

**API (service role, bypasses RLS):** `backup.js`, `create-student.js`, `manage-teacher.js`/`_teacherAdmin.js`, `reset-password.js`, `weekly-report.js`, `_liveClass.js`, `_lectures.js`, `_jmcwcServer.js`, `drill.js`, `memoriad.js` and `weekly-test.js`. They authorise with `verifyAdminCaller` (role === 'admin') or `verifyStudentCaller`, then act on *any* id sent in the body.

**Client:** `requireAuth([...roles])` appears about 50 times. `navConfig.getRoleNavItems(role)` and `appRail.ROLE_LAYOUTS[role]` are keyed by role. 48 JS files compare against `'admin'`.

### ⚠ Security problems found today (before any multi-centre work)

1. **Public data leak.**
   - `weekly_report_data()`, `mirror_student_data(uuid)`, `milestones_recent()`, `practice_stats_for()` and `points_for()` are SECURITY DEFINER, have **no caller check**, and can be **executed by `anon`**.
   - Anyone holding the public anon key (it ships in the site's JS) can call `/rest/v1/rpc/weekly_report_data` and get every student's name, student code, level, accuracy, streak and points.
   - `mirror_student_data` returns one student's full round history.
   - Only the service-role API needs these functions.
   - **Fix:** revoke execute from `anon` and `authenticated` on these, and grant to `service_role` only. I recommend doing this right away as its own tiny hotfix, before Phase 2.
2. **Broad anon execute.** Most `admin_*` RPCs are executable by `anon`. They do check `is_admin()` inside, so nothing leaks today. Still, as hygiene, revoke `anon` execute on every RPC that needs a login.
3. **Caller-supplied actor ids.** `admin_create_teacher_entry`, `admin_update_teacher_permissions` and similar take `p_actor_id` as a parameter. The audit log should use `auth.uid()` (or the API-verified caller), never a caller-supplied id.
4. **Avatars are readable by any signed-in user** (`avatars_select_signed_in`). That is fine within one centre, but it should be scoped once there are several centres (see §6).

---

## 2. Target hierarchy

| Rank | Role (`profiles.role`) | Scope | Can create / manage |
|---|---|---|---|
| 100 | `owner` | everything | owners*, directors, centres, everything below |
| 80 | `director` | everything (all centres) | centres, centre heads, vice heads, teachers, students; visibility grants |
| 60 | `centre_head` | one centre | vice heads (see Q2), teachers, students of *their* centre; teacher permissions |
| 50 | `vice_centre_head` | one centre | teachers and students of their centre (limits in §4) |
| 30 | `teacher` | assigned students in their centre | what `teacher_permissions` allows (unchanged) |
| 10 | `student` | self; leaderboards of own centre | nothing |

*Adding an owner needs an existing owner, and the database always keeps at least one active owner.

**The core rule (enforced in the database):** an actor can create, edit, deactivate or change the role of a person only if:
- the actor's rank is **strictly higher** than both the person's current rank and their new rank; and
- the person is inside the actor's scope (a centre head only within their own centre).

So nobody can grant a role at or above their own. Directors can never touch owners or other directors. A head can't promote anyone to head.

**Directors have the same powers as the owner, except** managing directors and owners. That covers centres, heads, visibility, all students, full backup and settings.

---

## 3. Data model

```sql
-- New
centres (
  id uuid pk, name text unique, code text unique,      -- code e.g. 'MUM1', also usable as student-code prefix
  kind text check (kind in ('centre','school')),
  status text check (status in ('active','suspended','archived')) default 'active',
  city text, address text, phone text,                  -- optional
  branding jsonb default '{}',                          -- logo path, accent colour (optional, later)
  settings jsonb default '{}',                          -- per-centre toggles: global leaderboard opt-in, duels, store, etc.
  created_by uuid, created_at, archived_at, archived_by
)

centre_staff (                     -- who runs which centre (heads, vice heads); history kept
  centre_id uuid fk, profile_id uuid fk, role text check (role in ('centre_head','vice_centre_head')),
  assigned_by uuid, assigned_at, ended_at, primary key (centre_id, profile_id, assigned_at)
)

centre_visibility (                -- cross-centre exposure, set by owner/director only
  id, source_centre_id uuid,       -- whose students are exposed
  viewer_centre_id uuid null,      -- null = every centre
  mode text check (mode in ('students','top_n','all')),
  student_ids uuid[] null,         -- for mode 'students'
  top_n int null,                  -- for mode 'top_n' (e.g. top 10 by XP on the network board)
  fields text check (fields in ('leaderboard','profile_card')) default 'leaderboard',
  created_by, created_at, expires_at null
)

role_audit (                       -- append-only: no UPDATE/DELETE policy, written only by trigger/RPC
  id bigserial, at timestamptz, actor_id uuid, actor_role text,
  target_id uuid, action text,     -- 'role_change','centre_assign','permission_change','deactivate','transfer',...
  before jsonb, after jsonb, centre_id uuid, ip text null
)

-- Changed
profiles.centre_id uuid fk centres null   -- required for head/vice/teacher/student; null for owner/director
profiles.role  check (role in ('owner','director','centre_head','vice_centre_head','teacher','student'))
```

**Content tables get `centre_id uuid null`.** `NULL` means network-wide, authored by an owner or director and shown to every centre. Otherwise the row belongs to that centre. The tables:
- announcements, daily_tasks, resources, weekly_tests
- homework_assignments, live_classes, attendance_sessions
- reward_items (store), lectures/lecture_categories (Q4)
- competition_settings (per centre via `centres.settings`)

**Student-owned rows (results, XP, badges, duels and so on) do *not* get a `centre_id` column.** Their scope comes from the student's `profiles.centre_id`. That way a transfer moves all of a student's history in one update, and nothing can drift out of sync.

### Helper functions (all SECURITY DEFINER, STABLE, `search_path` pinned)

```
my_role() / my_rank() / my_centre()
is_network_admin()          -- owner or director
is_centre_admin(c uuid)     -- network admin, OR head/vice of centre c
is_admin()                  -- KEPT for compatibility = owner|director|centre_head|vice_centre_head
can_manage_student(s uuid)  -- network admin, or centre admin of s's centre
can_view_student(s uuid)    -- can_manage_student OR teacher-assigned (existing rules)
can_see_on_network(s uuid)  -- s is exposed to my centre by centre_visibility (leaderboard fields only)
```

**Rollout trick that keeps the site working at every step:**
- Every policy that reads `is_admin()` on a student-keyed table becomes `can_manage_student(student_id)`.
- Every content policy becomes `is_centre_admin(centre_id)`, with `NULL` meaning network-wide.
- While there is only one centre and everybody is in it, these return exactly what `is_admin()` returns today. Production behaves the same until a second centre is created.

---

## 4. Centre head vs vice centre head

Recommended default:

| Power | Head | Vice |
|---|---|---|
| See and edit all students in the centre, scores, review, attendance, homework, tests, live classes, announcements | ✅ | ✅ |
| Create students and teachers; set teacher permissions and assignments | ✅ | ✅ |
| Reset student and teacher passwords | ✅ | ✅ |
| Appoint or remove vice heads | ✅ | ❌ |
| Deactivate, soft-delete or restore people | ✅ | ❌ (can deactivate only) |
| Centre settings (store items, leaderboard options, branding) | ✅ | ❌ |
| Export centre backup | ✅ | ❌ |
| Request a student transfer to another centre | ✅ | ❌ |

These could later become switches the head controls (like teacher permissions), but a fixed split is simpler and safer to start with.

---

## 5. What gets scoped by centre

| Feature | Rule |
|---|---|
| Students list, student detail, reports, monthly report | own centre. Owner and director see all, with a **Centre** column and filter |
| Leaderboards (points, streak, XP, todo, weekly test), podium, star of month, class-vs-class, daily challenge board, leagues | **own centre only** |
| Network leaderboard (optional) | only students exposed through `centre_visibility`, showing display name, centre, avatar, level and value. No codes or history |
| Duels | opponents from own centre only (plus exposed students, if you want cross-centre duels, Q5) |
| Store | network items (`centre_id` null) plus the centre's own items; the head approves their centre's redemptions |
| Live classes | per centre. Directors can create network-wide classes. The Webinar.gg host account is shared, so the existing one-class-at-a-time lock stays global |
| Announcements, tasks, resources, weekly tests, homework | the author's centre; network admins can pick "all centres" or specific centres; recipients must be inside the author's scope |
| Practice catalogue (rounds, categories, series, JMCWC papers, Memoriad, lectures) | **shared network-wide**, edited by owner and director only. Heads can't edit, so one centre can't break another |
| Student Access (level defaults) | network defaults set by owner and director; per-student overrides by that centre's staff |
| Attendance | per centre |
| Weekly email report | one per centre to its head(s), plus a network summary to owner and director |
| Backup | full backup: owner and director. Centre backup: the head gets an Excel of their centre's students and data only |
| Import | centre admins, only into students of their centre |
| XP, badges, seasons | computed the same everywhere. Rankings are centre-scoped |

---

## 6. Security and product suggestions

1. **RLS in the database, not only the UI.** Every rule above lives in policies and RPCs. The UI hides things only for convenience.
2. **No escalation.** A single RPC `set_person_role(target, new_role, centre)` enforces the rank rule in §2. `profiles_guard` keeps blocking direct role and centre edits. All changes go through that RPC or through a service-role API that calls the same check.
3. **Owner protection.**
   - A trigger refuses any change that would leave zero active owners.
   - Directors can't see owner accounts' edit controls, and the RPC refuses them anyway.
   - **Make a second owner account** (for example one for Parth, or a sealed "break-glass" owner whose password is stored offline). The last-resort recovery path stays SQL in the Supabase dashboard.
4. **Audit log** (`role_audit`). Every role, centre, permission, deactivation, transfer and visibility change is written by trigger, so it can't be skipped. It is append-only, and owner and director can read it in the panel.
5. **Student transfer between centres.** Only network admins can transfer. A head can *request* one, which a director approves. The transfer:
   - moves `profiles.centre_id`;
   - ends that student's teacher assignments;
   - keeps all history, which follows the student;
   - is logged.
6. **Deactivate a centre without deleting data.** `status = suspended` blocks logins for everyone in that centre (checked in `requireAuth` *and* in `is_*` helpers, so RLS also stops them). `archived` hides it from lists. Nothing is deleted. Hard delete is not offered.
7. **Service-role API routes re-check scope.**
   - Replace `verifyAdminCaller` with `verifyStaffCaller(req, { minRole, studentId?, centreId? })`. It loads the caller and checks rank and centre before using the admin client.
   - On create-student and create-teacher, the centre is taken from the caller's profile. Only owner and director may pass a `centre_id`.
   - Tests cover each route.
8. **Backups.** Full backup is for owner and director (it holds answer keys and everyone's data). Each centre backup is filtered by centre and logged.
9. **"View as centre" for directors.** A centre switcher that *filters* the director's own view. No token swapping or real impersonation, so everything they do is still recorded as them. A banner shows "Viewing: <Centre>".
10. **Sessions.**
    - After a role or centre change, or a deactivation, the person's cached profile is invalidated and their sessions are revoked through the admin API, so old tabs stop working.
    - Staff passwords are reset only by someone of higher rank.
    - Optional later: 2FA (TOTP) for owner and director.
11. **Rate limits on account creation.**
    - Per actor: for example 100 students per hour and 20 staff per day, in a small `api_rate_limits` table.
    - Bulk import counts too.
    - Owners are exempt.
12. **Student PII across centres.** Other centres only ever see display name, centre name, avatar, level and the leaderboard value. Never student code (it's the login name), full history or messages. Avatars become readable only within the student's centre, plus exposed students.
13. **Student codes are logins, so they must stay globally unique.** Suggestion: new students get a centre prefix (`MUM1-023`). Existing codes stay unchanged.
14. **Per-centre extras (optional, later):**
    - branding (logo and colour on that centre's pages);
    - per-centre reports comparing centres (owner and director dashboard);
    - fees and payment tracking (a separate feature, only if you want it);
    - centre capacity limits (max students per centre).
15. **Owner and director dashboard.**
    - Cards for each centre: students, active this week, average accuracy, XP, head name and status.
    - A cross-centre comparison chart.
    - An all-students table with a Centre column, centre filter and search.
    - Pages for staff management, visibility grants and the audit log.

---

## 7. Migration of existing data

1. Back up first: full Excel backup (#82 tool) and a `pg_dump`-style SQL snapshot of `profiles`, `teacher_*` and the content tables.
2. Create the default centre (name is your choice; see Q1) and set `centre_id` on all 25 students and the 1 teacher.
3. Your admin account becomes `owner`. There are no other admins today.
4. Existing content rows get `centre_id = default centre`. They stay visible to the same people as today.
5. `is_admin()` keeps returning true for the new staff roles, so old code keeps working during the rollout.
6. Then rewrite the 181 references, in step 5, table by table, with tests.
7. Every migration ships with a rollback file (`supabase/rollbacks/`). Nothing is dropped; the old `admin` value is mapped and only then disallowed.

---

## 8. Build plan (Phase 2: each step is its own migration and PR, and the site keeps working)

0. **Hotfix:** revoke the anon/public execute grants in §1. Tiny migration, release separately.
1. **Schema and helpers:** `centres`, `centre_staff`, `centre_visibility`, `role_audit`, `profiles.centre_id`, the role check, helper functions, the escalation-proof `set_person_role`, and the owner-protection trigger. No behaviour change.
2. **Data migration:** default centre, backfill, you become owner, add `centre_id` to content tables. Client maps `owner|director|centre_head|vice_centre_head` to the existing admin panel for now.
3. **Owner/Director panel:**
   - Network dashboard, centres (create, suspend, archive), directors (owner only).
   - Heads and vice heads, the all-students view with centre, visibility grants, audit log.
   - Centre switcher, and `verifyStaffCaller` in the API.
4. **Centre head panel:** today's admin pages scoped to one centre (students, teachers and permissions, vice heads), plus centre backup and centre settings.
5. **Scope features:** rewrite the RLS policies and RPCs (leaderboard family, duels, store, live classes, content, reports, weekly email). Add the network leaderboard.

**Tests** (`node --test` with pglite, which is already a dev dependency):
- an RLS matrix with every role against every table, including "head of centre A can't read centre B students, results or XP";
- escalation attempts: a head makes someone a head, a director touches an owner, a teacher changes their own role, the last owner removes themself, and a director passes another centre's id to the API;
- leaderboard and duel scoping.

Also: `npm run build`, and a browser check of every panel with demo accounts.

---

## 9. Decisions needed from you

- **Q1.** What is the default centre's name and code? All current students and the teacher go there.
- **Q2.** Who appoints vice heads: only directors, or directors *and* the centre head?
- **Q3.** Should the head and vice split be as in §4?
- **Q4.** Practice content (rounds, papers, lectures): shared network-wide and edited only by owner and director (recommended)? Or can centres add their own?
- **Q5.** Should cross-centre visibility be a network leaderboard only (recommended), or should it also allow cross-centre duels?
- **Q6.** Should I do the §1 anon-leak hotfix now, before the rest?
- **Q7.** Should a second owner account be created for recovery, and for whom?

## 10. Decisions (agreed 2026-11-27)

- **Q1.** Every current student and the teacher go into **Baran Centre**, code **BRN**, the default centre (step 2).
- **Q2.** Vice heads can be appointed by owners, directors **and the centre's own head**. A vice head cannot appoint another vice head.
- **Q3.** The head and vice split is as in §4.
- **Q4.** Practice content is shared across the network and edited only by owners and directors.
- **Q5.** There is **no network leaderboard**: every leaderboard covers one centre. The only cross-centre feature is **duels**. Owners and directors choose in `centre_visibility` which students (all of them, a chosen list, or the top N) other centres can duel. This ties into the real-time duels work.
- **Q6.** The hotfix is done: migration 29, PRs #104 and #105, live.
- **Q7.** There will be a second owner account, for the owner's father. It is created from the owner panel (step 3), and the owner sets the name and password there. Claude never handles the password.

### Step 1 implementation notes (migration 30)

- Role and centre changes go only through `set_person_role()`. It leaves a one-time row in `role_change_tickets`, a private table the site cannot read or write, which the profiles guard checks and uses up. A session setting was rejected for this, because any SQL caller can set one.
- The "no editing someone at or above your rank" check in the guard applies to staff only (rank 30 and up). Students already edit only their own row through RLS, and definer functions acting for a student (duels, XP) must still be able to update other students.
- `is_admin()` now means owner, director or legacy admin. It stays executable by anon because `TO public` policies call it, and it returns false for anon.
- Rollback is only safe before step 2. Run step 2's rollback first.

### Step 2 implementation notes (migration 31)

- Baran Centre (BRN) is the default centre. Every student and teacher is in it; owners and directors have no centre. A trigger puts new students and teachers with no centre into the default centre, and the constraint `profiles_centre_matches_role` keeps "network roles have no centre, everyone else has one" true.
- The 12 policies and 7 functions that tested `role = 'admin'` inline now accept owner, director or admin. The migration rewrites them from their live definitions and stops with an error if any `'admin'` check is left in a form it does not recognise.
- The admin account becomes `owner`.
- On the site and in the API, owners and directors get the *effective* role `admin` (`js/roles.js`, `normalizeProfileRole`), so the existing admin pages and checks keep working until the owner panel (step 3). The real role is kept in `network_role`. A stored `network_role` can only refine an effective `admin`; it never widens a role.
- Release order: ship the site and API first (they work before and after the migration), then back up and apply migration 31.
- Rollback: `supabase/rollbacks/31_multi_centre_data_rollback.sql`. It refuses while any director, head or second owner exists.

# Student pages redesign: release checklist

Branch: `codex/app-redesign` (not pushed, not merged, not deployed).
Scope: student pages only. Teacher and admin pages are unchanged.

## What changed

- **Desktop (1024px and wider):** a new left side menu (rail) replaces the top header on student pages.
- **Phones and tablets (below 1024px):**
  - A slim top bar with the brand, notification bell and account button.
  - A bottom tab bar: Home, Practice, Tests, Ranks, More.
  - Practice and More open as sheets that slide up from the bottom.
  - Full-screen practice stages (Flash, Basics online, Elements drill, weekly test player) hide both bars.
- **Pages updated:**
  - Home and Weekly Test (new cards).
  - Leaderboard (podium).
  - Monthly report, Notifications and Main round, with phone fixes.
- **New My account page** (`pages/account.html`, `js/account.js`):
  - Read-only details, a summary of practice access, and preferences (Flash sound, menu labels).
  - Install app and sign out.
  - No form collects student information.
- All existing element IDs, routes, login, protected routes and APIs are kept.

## Checked before this commit

- [x] `npm test`: 969 tests, 968 pass, 1 skipped, 0 fail.
- [x] `vite build` succeeds. All 35 pages are built, including `pages/account.html`.
- [x] Production build: signed-out visitors to student pages are sent to the login page, and the demo database is stubbed out.
- [x] Every student page at 375px and 320px: no sideways scrolling, and the bottom tabs show.
- [x] 768px uses the bottom tabs. 1440px shows the side menu and hides the mobile bars.
- [x] Practice stages at 375px:
  - Basics online, Elements drill, Flash, and the weekly test section (opens the Flash stage): bars hidden, buttons at least 44px tall.
  - Memoriad play shows its existing "use a laptop" screen on phones.

## Fixed: Phase 17b test (it was failing before this work)

`tests/jmcwcPhase17b.test.js`, test "Staging Bootstrap Verbatim Parity":
- The function bodies in `docs/JMCWC_DATABASE_CONTRACT.json` use Windows line endings (`\r\n`).
- `supabase/tests/jmcwc_staging_bootstrap.sql` uses `\n`.
- The exact-text match therefore failed for all 9 `jmcwc_*` functions, even though the SQL text is otherwise identical.
- The test now converts both sides to `\n` before comparing. The snapshot and the SQL file are unchanged.

## Before production (you)

1. Review the preview locally with `npm run dev` (or the Vite dev server on port 3200) in demo mode:
   - Student ID `STU101`, demo password from `js/auth.js`.
2. Check on a real phone (iOS Safari and Android Chrome):
   - Bottom tabs sit above the home indicator.
   - The keyboard doesn't cover answer boxes.
3. Run a staging deploy with real Supabase keys and sign in as a real test student:
   - Home, Tests, Ranks, Account, Notifications badge, Sign out.
4. Make sure teacher and admin logins still look and work as before.
5. Decide how to merge alongside the live-classes work on `codex/webinar-live-classes`:
   - Expect conflicts in `js/headerNav.js`, `js/navConfig.js` and `vite.config.ts`.
6. Only then: merge, deploy, and switch the domain.

## Rollback

- All the work is in one commit on `codex/app-redesign`, so reverting that commit restores the old student pages.
- No database changes were made.

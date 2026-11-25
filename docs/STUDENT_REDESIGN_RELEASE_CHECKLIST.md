# Student workspace and sign-in release checklist

The student portal and shared sign-in are prepared on `codex/app-redesign-release-candidate`. The public homepage is a separate release.

## Changes

- Desktop students get a collapsible sidebar. Below 1024px, students get a compact header and bottom tabs for Home, Practice, Tests, Ranks and More. Full-screen practice stages hide the navigation.
- The dashboard brings together today's plan, homework, weekly tests and reminders. Live Classes and the lecture catalogue remain accessible from Today.
- Account displays student details and practice access, with existing sign-out and install controls and local display preferences.
- The shared sign-in page uses the official Trendz branding and adds a password visibility toggle. The existing role destinations and validated live-room return path are preserved.

## Verified locally

- [x] Full suite passed with 1,016 passes, one skip and zero failures.
- [x] TypeScript check and production build passed.
- [x] The built login and seven updated portal pages use unique element IDs.
- [x] The local static staging build passed its Supabase project isolation check and served the account page.

## Before production

- [ ] Sign in to staging as student, teacher and admin. Check the intended dashboard opens for each role.
- [ ] As a student, check Home, practice access and full-screen navigation, Tests, Ranks, Account, Notifications, Lectures and Live Classes. Verify sign-out and returning to an eligible class through sign-in.
- [ ] Check bottom navigation and practice keyboard behavior on iOS Safari and Android Chrome.
- [ ] Verify the Vercel preview for the PR head. Merge into `main` after the sign-in checks, then promote through `Test-branch`.

Rollback is a revert of this release PR or a Vercel rollback to the prior deployment. This release contains no database migrations.

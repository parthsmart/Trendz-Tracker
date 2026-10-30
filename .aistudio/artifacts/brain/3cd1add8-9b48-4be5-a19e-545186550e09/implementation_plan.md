# Trendz Tracker — Phase 13b: Student Notifications & Admin Announcements

This phase adds live, on-open student notifications (weekly test reminders and admin announcements) with a navigation bell badge, a dedicated Student Notifications page, a compact reminder strip on Student Home, an Admin Announcements & Upcoming Tests WhatsApp sharing page, a reminder start-date preview in the Weekly Test form, and an "Upcoming weekly tests (next 7 days)" section in the Admin Weekly Report Email.

## User Review & Critical Decisions

> [!IMPORTANT]
> Please review the plan, architectural decisions, and alternatives below, then click **Proceed** (or reply "approved") to begin implementation.

- **Zero New Dependencies**: Built strictly with plain HTML, CSS, vanilla ES modules, Supabase RPCs/tables, and existing Vercel serverless routes.
- **Live On-Open Derivation (No Cron / No Push)**: Student weekly test reminders (`test_upcoming`, `test_today`) and active announcements (`announcement`) are computed live by the database RPC `my_notifications()` when the student opens the site, with a 60-second `sessionStorage` badge cache that invalidates immediately on dismiss or refresh.
- **Strict Plain-Text Escaping**: All announcement titles, bodies, and weekly test titles/notes are rendered as plain text (`textContent` or HTML-escaped) and never interpreted as raw HTML.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Student Notifications (`🔔` Bell Badge, `/pages/notifications.html`, & Student Home Strip)**:
     - Every student navigation bar displays a bell link (`Notifications`) with a live count badge derived from `my_notifications()` (hidden when `0`, `"1"`–`"9"` for 1–9, `"9+"` above 9), cached in `sessionStorage` for 60 seconds and refreshed whenever a notification is dismissed or refreshed.
     - `/pages/notifications.html` groups active items into **Weekly tests** and **Announcements**, displaying each item's title, body, formatted India-time date chip (e.g. `"Sun 2 Nov"`), stage text chip (`"In 4 days"`, `"Tomorrow"`, `"Today"`), an **Open** button linking to the target page, and a **Dismiss** button (`dismiss_notification(p_ref)`) with a 5-second undo toast.
     - Student Home (`/pages/student.html`) shows up to 3 active reminders in a compact strip above the daily to-do list with direct links and a **"See all notifications"** link.
  2. **Admin Announcements & Upcoming Tests Share Panel (`/pages/announcements.html`)**:
     - Protected by `requireAuth(['admin'])` and added to the Admin **Setup ▾** dropdown as **Announcements**.
     - Includes an announcement composer (`title` 1–80 chars, `body` 1–500 chars with live counter, `audience` `"Everyone"` or a specific level with `<datalist>` suggestions, `Show from` defaulting to now in IST, and optional `Hide after` in IST) plus a live **"What students see"** preview card.
     - Lists all announcements (newest first) with audience, India-time window, computed status chip (**Active**, **Scheduled**, **Expired**), and a **Delete** button with confirmation.
     - Includes an **Upcoming tests (next 14 days)** panel listing each scheduled test's title, type chip (`Online` / `Offline`), date, level, reminder days, section count, a **Share on WhatsApp** button (`https://wa.me/?text=<encoded>` in a new tab with `rel="noopener noreferrer"`), and a **Copy text** button powered by a pure helper in `js/reportMessage.js`.
  3. **Admin Weekly Test Form Reminder Preview & Weekly Report Email**:
     - On `/pages/weekly-tests.html`, changing the test date or `"Remind students from N days before"` updates a live helper line: *"Students will see a reminder from `<date>` until the test day."*
     - `api/weekly-report.js` and `api/_reportEmail.js` add an **"Upcoming weekly tests (next 7 days)"** section (reading `weekly_tests` via the service role), or *"No weekly tests scheduled"* when empty.
- **Target Audience / Persona**:
  - **Students**: Need timely visibility into upcoming/today's weekly tests and trainer announcements without intrusive push prompts.
  - **Administrators / Trainers**: Need a fast way to post level-targeted or academy-wide announcements, share upcoming test notices to parent/student WhatsApp groups without storing phone numbers, and see next week's scheduled tests in their weekly summary email.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Student Bell & Compact Home Strip**:
     - When a student logs in, a shared navigation badge helper checks `sessionStorage` (`tt_notif_badge_v1`, 60s TTL). If stale or missing, it calls `my_notifications()` (or `DemoDB.mockMyNotifications()` in Demo Mode), caches the result, and updates the bell badge (`hidden` when `0`, `1..9`, or `9+`).
     - On `/pages/student.html`, up to 3 items from `my_notifications()` render in a compact strip above the daily to-do card, each with its stage label (`Today`, `Tomorrow`, `In N days`), title, action link, and a **"See all notifications"** link to `/pages/notifications.html`.
  2. **Student Notifications Page (`/pages/notifications.html`)**:
     - Header includes a **Refresh** button that bypasses the 60s cache and reloads `my_notifications()`.
     - Items are partitioned by `groupNotifications(items)` into two sections: **Weekly tests** (`kind === 'test_upcoming' || kind === 'test_today'`) and **Announcements** (`kind === 'announcement'`).
     - Each card displays the title, plain-text body, formatted date chip (`"Sun 2 Nov"`), stage text chip (`"In 4 days"`, `"Tomorrow"`, `"Today"`), **Open** button (`href` from `item.link`, validated as an internal relative path), and **Dismiss** button.
     - Clicking **Dismiss** optimistically hides the card and shows a 5-second toast with an **Undo** button; if not undone within 5 seconds (or on page unload), it commits `dismiss_notification(p_ref)` and refreshes the 60s `sessionStorage` cache. When both groups are empty, the page displays *"You are all caught up"*.
  3. **Admin Announcements & WhatsApp Share Flow (`/pages/announcements.html`)**:
     - Left/top column: Compose form with live character counter (`0 / 500`), live **"What students see"** preview card, validation against empty/over-length inputs or `expires_at <= starts_at`, and double-submit prevention.
     - Right/bottom column: **Upcoming tests (next 14 days)** panel with **Share on WhatsApp** and **Copy text** buttons, followed by the **All Announcements** list (newest first) with `Active` / `Scheduled` / `Expired` status text and a confirmation modal before deletion.
- **Visual Identity & Theme**:
  - Consistent with the existing Trendz Tracker light/clean workspace theme (`css/main.css`), using tabular numerals (`font-variant-numeric: tabular-nums`) for dates, counts, and character counters, high-contrast status indicators (`Active` green, `Scheduled` blue/amber, `Expired` neutral slate), and accessible modal/toast patterns (`js/modal.js`, `js/toast.js`).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Live On-Open Reminder Derivation (`my_notifications()`) with 60s `sessionStorage` Caching**
  - *Chosen Approach*: Compute weekly test reminders (`test_upcoming`, `test_today`) and active announcements on the fly in Postgres when the student opens the app, caching the count/list in `sessionStorage` for 60 seconds and invalidating immediately on dismissal or manual refresh.
  - *Why*: Eliminates background cron jobs for daily reminder fan-out, avoids stale notification rows when an admin edits a test's date, level, or `remind_days_before` (or removes a test), and automatically hides an online test reminder on test day once the student completes all sections.
  - *Alternatives Considered*:
    - *Alternative A (Scheduled cron job materializing rows into a `student_notifications` table)*: Rejected because any change to a weekly test's date, level, or deletion would require complex synchronization and extra cron quota.
    - *Alternative B (Web Push / Service Worker notifications)*: Rejected for this phase because students often share family devices or use browsers where push permissions are blocked, and on-open reminders + WhatsApp group sharing match the academy's workflow without permission prompts.

- **Decision 2: 5-Second Undo Toast on Notification Dismissal**
  - *Chosen Approach*: When a student clicks **Dismiss**, immediately remove the item from the visible list, update the badge count, and show a 5-second toast (`"Notification dismissed"` with an **Undo** action). Commit the RPC `dismiss_notification(p_ref)` after the 5-second window (or immediately if the student navigates away) so accidental clicks can be reversed cleanly without needing an `undismiss` RPC.
  - *Why*: The database provides `dismiss_notification(p_ref)` (one-way insert into dismissals), and an optimistic 5-second undo window before committing gives instant UI feedback and genuine undo capability with zero schema changes.
  - *Alternatives Considered*:
    - *Calling `dismiss_notification(p_ref)` immediately before showing Undo*: Rejected because without a database `undismiss` RPC, clicking Undo could not remove the dismissal record from the database.

- **Decision 3: Pure WhatsApp / Copy Message Builder (`js/reportMessage.js`) Without Phone Numbers**
  - *Chosen Approach*: Build the share message in a pure, unit-tested function `buildWeeklyTestShareMessage(test)` producing `"Weekly test: <title> on <weekday, day month>. <Online on the Trendz Tracker website / With your trainer>. <notes shortened to 120 characters>"`, and open `https://wa.me/?text=<encodeURIComponent(msg)>` in a new tab (`rel="noopener noreferrer"`).
  - *Why*: Trainers post announcements to existing class WhatsApp groups; `wa.me/?text=...` lets the trainer pick any group or contact in WhatsApp without Trendz Tracker ever collecting or storing student/parent phone numbers.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                              STUDENT EXPERIENCE                               │
│                                                                               │
│  ┌──────────────────────────────┐      ┌───────────────────────────────────┐  │
│  │ Student Top Nav (All Pages)  │      │ Student Home (/pages/student.html)│  │
│  │ • Bell Icon + Badge (1..9,9+)│      │ • Compact Strip (up to 3 items)   │  │
│  │ • 60s sessionStorage cache   │      │ • "See all notifications" link    │  │
│  └──────────────┬───────────────┘      └─────────────────┬─────────────────┘  │
│                 │                                        │                    │
│                 ▼                                        ▼                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │           Student Notifications Page (/pages/notifications.html)        │  │
│  │  • Groups: "Weekly tests" & "Announcements" (js/notificationsView.js)   │  │
│  │  • Chips: Date ("Sun 2 Nov") + Stage ("In 4 days" | "Tomorrow" | "Today")│ │
│  │  • Actions: "Open" (internal link) & "Dismiss" (5s Undo -> RPC commit)  │  │
│  └──────────────┬────────────────────────────────────────┬─────────────────┘  │
└─────────────────┼────────────────────────────────────────┼────────────────────┘
                  │ RPC: my_notifications()                │ RPC: dismiss_notification(p_ref)
                  ▼                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                         SUPABASE POSTGRES / DEMO DB                           │
│  • RPC my_notifications()         • RPC dismiss_notification(p_ref)           │
│  • Table announcements            • Table weekly_tests (+ sections)           │
└─────────────────▲────────────────────────────────────────▲────────────────────┘
                  │ CRUD: announcements / weekly_tests     │ Service Role: weekly_tests (next 7d)
┌─────────────────┼────────────────────────────────────────┼────────────────────┐
│                 │             ADMIN EXPERIENCE           │                    │
│  ┌──────────────┴───────────────────────────────┐  ┌─────┴─────────────────┐  │
│  │ Admin Announcements (/pages/announcements)   │  │ Weekly Report Email   │  │
│  │ • Compose (1-80 title, 1-500 body, IST dates)│  │ (api/weekly-report.js │  │
│  │ • "What students see" live preview card      │  │  & api/_reportEmail)  │  │
│  │ • List (Active/Scheduled/Expired) + Delete   │  │ • "Upcoming weekly    │  │
│  │ • Upcoming Tests (14d) WhatsApp & Copy share │  │   tests (next 7 days)"│  │
│  │   via pure js/reportMessage.js               │  └───────────────────────┘  │
│  └──────────────────────────────────────────────┘                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Pure Helpers & Unit Test Specifications

1. **`js/notificationsView.js` (tested in `tests/notificationsView.test.js`)**:
   - `stageLabel(days_left)`:
     - Returns `'Today'` when `days_left === 0` (or `<= 0`).
     - Returns `'Tomorrow'` when `days_left === 1`.
     - Returns `'In N days'` when `days_left >= 2` (e.g. `'In 4 days'`).
     - Returns `''` when `days_left` is `null` or `undefined` (such as general announcements without a countdown stage).
   - `groupNotifications(items)`:
     - Splits an array of notification rows into `{ tests: [...], announcements: [...] }` where `kind === 'test_upcoming' || kind === 'test_today'` go into `tests` and `kind === 'announcement'` go into `announcements`, preserving order.
   - `badgeText(count)`:
     - Returns `''` when `count <= 0` or not a positive number (badge hidden).
     - Returns `String(count)` for integers `1` through `9`.
     - Returns `'9+'` when `count > 9`.
   - `formatShortEventDateIST(dateVal)`:
     - Formats `YYYY-MM-DD` or ISO timestamp in `Asia/Kolkata` as `"Sun 2 Nov"`.

2. **`js/reportMessage.js` (tested in `tests/reportMessage.test.js`)**:
   - `buildWeeklyTestShareMessage(test)`:
     - Builds: `"Weekly test: <title> on <weekday, day month>. <Online on the Trendz Tracker website | With your trainer>. <notes shortened to 120 characters>"` (when `notes` is empty/blank, omits the trailing notes sentence cleanly or trims trailing whitespace; when `notes` exceeds 120 characters, truncates to 120 characters).
   - `formatReminderStartPreview(testDateStr, remindDaysBefore)`:
     - Computes the India-time start date (`test_date - remind_days_before` days) and returns `"Students will see a reminder from <date> until the test day."` for `/pages/weekly-tests.html`.

3. **`api/weekly-report.js` & `api/_reportEmail.js` (tested in `tests/reportEmail.test.js`)**:
   - `api/weekly-report.js` queries `weekly_tests` for the next 7 days after `week_end` (`test_date > week_end` through `week_end + 7 days`, or from today through `+7 days` in IST) using the service-role client (with admin session fallback) and attaches `upcoming_weekly_tests: [{ title, type, date, level }]` to `reportData`.
   - `buildWeeklyEmail(data)` adds the **"Upcoming weekly tests (next 7 days)"** section in both plain text and HTML (with full HTML escaping of `title`, `type`, `date`, and `level`), outputting `"No weekly tests scheduled"` when the list is empty.

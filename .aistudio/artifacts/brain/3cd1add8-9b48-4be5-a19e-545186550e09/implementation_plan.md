# Phase 14e: Restore Desktop Inline Header & Restrict Three-Dot Menu to Mobile (`< 1024px`)

Restore the pre-Phase 14d inline desktop header navigation (including the Student **Practice ▾** dropdown + notifications bell and the Admin **Setup ▾** dropdown) on screens at or above `1024 px`, while displaying the Phase 14d three-dot menu and drawer **only** on screens below `1024 px`—all driven by a single `js/navConfig.js` configuration with zero duplicated link lists and zero new dependencies.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> - **Git History & Pre-14d Reference**: No `.git` repository history is present in the container workspace (`fatal: not a git repository`), which we explicitly note here as requested. However, the exact pre-14d HTML structures are still preserved inside the existing page templates (`pages/student.html` lines 24–51 for the Student inline bar, **Practice ▾** dropdown, and notifications bell with count badge; and `pages/report.html` lines 45–70 for the Admin inline bar and **Setup ▾** dropdown). We will use those exact structures and classes (`.nav-zone`, `.nav-link`, `.nav-dropdown`, `.nav-dropdown-toggle`, `.nav-dropdown-menu`, `.dropdown-item`, `.nav-bell-link`, `#nav-notifications-badge`) rendered dynamically from `js/navConfig.js`.
> - **Single Breakpoint Constant (`1024 px`)**: Stored in `css/variables.css` as `--nav-mobile-breakpoint: 1024px;` and in `js/navConfig.js` as `export const NAV_MOBILE_BREAKPOINT_PX = 1024;`, verified by an automated unit test that reads both files.
> - **Zero New Dependencies**: Pure HTML, CSS, and vanilla JavaScript ES modules (`0` new packages).

---

### 1. Overview & Core Concept

- **What It Does**:
  - **Desktop (`>= 1024 px`)**: Renders the classic horizontal header (`[logo] [Trendz Tracker] [inline navigation links & dropdowns] ... [name · ID] [Sign out]`). The three-dot menu button, backdrop, and mobile drawer are set to `display: none !important` (and `hidden`) so they take zero layout space and cannot receive keyboard focus.
  - **Mobile / Tablet (`< 1024 px`)**: Hides the desktop inline links and dropdowns (`display: none !important` and `hidden`) and shows `[logo] [Trendz Tracker] [44×44 three-dot menu button]` on the left with `[name · ID] [Sign out]` on the right (shortening the name to first name below `480 px`).
  - **Live Viewport Switching (`matchMedia`)**: Uses `window.matchMedia('(min-width: 1024px)')` so rotating a tablet or resizing a window switches cleanly between desktop inline navigation and mobile three-dot navigation without reloading, automatically closing any open dropdown or mobile drawer on switch.

---

### 2. User Experience & Visual Design

- **Desktop Header (`>= 1024 px`)**:
  - **Student Inline Bar** (rendered from `js/navConfig.js`):
    - Top-level links & controls in order:
      1. **Today** (`/pages/student.html`)
      2. **Round scores** (`/pages/round-scores.html`)
      3. **Practice ▾** dropdown (`.nav-dropdown` / `#nav-practice-dropdown`) containing **Basics**, **Flash Anzan**, **Elements**, and **Memoriad** (marked active when on any of those 4 pages)
      4. **Weekly Test** (`/pages/weekly-test.html`)
      5. **Leaderboard** (`/pages/leaderboard.html`)
      6. **Monthly Report** (`/pages/monthly-report.html`)
      7. **Notifications bell** (`/pages/notifications.html`, `.nav-bell-link` with SVG bell icon and `#nav-notifications-badge` count badge)
  - **Admin Inline Bar** (rendered from `js/navConfig.js`):
    - Top-level links & controls in order:
      1. **Overview** (`/pages/admin.html`)
      2. **Review** (`/pages/review.html`)
      3. **Students** (`/pages/students.html`, also marked current on `/pages/student-detail.html`)
      4. **Attendance** (`/pages/attendance.html`)
      5. **Weekly Tests** (`/pages/weekly-tests.html`)
      6. **Leaderboard** (`/pages/leaderboard.html`)
      7. **Monthly Report** (`/pages/monthly-report.html`)
      8. **Setup ▾** dropdown (`.nav-dropdown` / `#nav-setup-dropdown`) listing the admin setup pages (**Settings hub**, **Daily To-Do**, **Resources**, **Categories**, **Rounds**, **Targets**, **Competition settings**, **Announcements**, **Reports**, **Import**, **Backup**), with the `Setup ▾` toggle marked active whenever the current page is one of its items.
  - **Desktop Dropdown Interaction**:
    - Clicking or pressing `Enter`/`Space`/`ArrowDown` on **Practice ▾** or **Setup ▾** toggles `.open` / `aria-expanded="true"` on the dropdown menu; hovering on desktop pointer devices also opens smoothly; pressing `Escape`, clicking outside, or switching across the `1024 px` breakpoint closes the dropdown.
  - **No Wrapping & Compact Admin Range (`1024 px` – `1280 px`)**:
    - `"Trendz Tracker"` and user names always have `white-space: nowrap`.
    - Between `1024 px` and `1280 px` on the Admin header, link horizontal padding/gap tightens and the user name displays the first name only (`data-short-name`, with the full name preserved in `title` tooltip) so nothing wraps or overflows at `1024`, `1100`, `1280`, or `1440 px`.

- **Mobile Header (`< 1024 px`)**:
  - Desktop `.nav-zone` is `display: none !important` and `hidden` (unreachable by `Tab` or screen readers).
  - `.header-menu-anchor` (`#btn-header-nav-menu` + `#header-nav-menu`) is visible (`display: inline-flex`).
  - Below `480 px`, the header user name displays the first name only (`data-short-name`) with full name in `title`, and **Sign out** remains reachable in the menu (and header above `480 px`).
  - Full-screen practice/test stages (`body.stage-focus-mode`) continue hiding the header on all screen sizes.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Single Source of Truth in `js/navConfig.js` for Both Desktop Inline Links/Dropdowns and Mobile Menu**
  - *Chosen Approach*: Each item in `NAV_CONFIG.student` and `NAV_CONFIG.admin` defines `{ id, label, href, group, desktopPlacement, badge, action }`, where `desktopPlacement` is `'inline'`, `'practice-dropdown'`, `'setup-dropdown'`, `'bell'`, or `'menu-only'` (`Account` and `Sign out`, which live in the right-hand `.actions-zone` on desktop and in the `Account` group of the mobile menu).
  - *Why*: Eliminates any second link list while allowing `headerNav.js` to render both the desktop inline bar (with `Practice ▾` / `Setup ▾` dropdowns and the student notifications bell) and the `< 1024 px` grouped three-dot menu from the exact same array.

- **Decision 2: Strict Single Active Navigation via `1024 px` CSS + `matchMedia` Synchronization**
  - *Chosen Approach*: CSS media queries (`@media (min-width: 1024px)` and `@media (max-width: 1023.98px)`) enforce `display: none !important` on the inactive navigation, while `window.matchMedia('(min-width: 1024px)')` in `js/headerNav.js` synchronizes `hidden` attributes and closes any open mobile menu or desktop dropdown whenever the viewport crosses `1024 px`.
  - *Why*: Guarantees keyboard (`Tab`) and screen-reader users never encounter duplicate navigation landmarks or focusable off-screen elements.

---

### 4. Technical Architecture & Component Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                   js/navConfig.js + css/variables.css                     │
│  • NAV_MOBILE_BREAKPOINT_PX = 1024  <==>  --nav-mobile-breakpoint: 1024px │
│  • Single NAV_CONFIG for 'student' & 'admin' (no duplicate hrefs/lists)   │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                             js/headerNav.js                               │
│  matchMedia('(min-width: 1024px)') listener:                              │
│  • Closes open mobile drawer / desktop dropdown on breakpoint crossing    │
│  • Syncs `hidden` attribute so only ONE <nav> is active in accessibility  │
├────────────────────────────────────┬──────────────────────────────────────┤
│     Desktop (>= 1024px)            │         Mobile (< 1024px)            │
│ • .header-menu-anchor: display:none│ • .nav-zone: display:none            │
│ • Student .nav-zone:               │ • .header-menu-anchor:               │
│   Today | Round scores |           │   44x44 ⋮ Button + Unread Dot        │
│   Practice ▾ (Basics, Flash Anzan, │   Grouped Menu / Slide-in Drawer     │
│   Elements, Memoriad) |            │ • Right side:                        │
│   Weekly Test | Leaderboard |      │   Name (first name < 480px) +        │
│   Monthly Report | Bell + Badge    │   Sign out (also in menu)            │
│ • Admin .nav-zone:                 │                                      │
│   Overview | Review | Students |   │                                      │
│   Attendance | Weekly Tests |      │                                      │
│   Leaderboard | Monthly Report |   │                                      │
│   Setup ▾ (Settings hub + tools)   │                                      │
│ • 1024..1280px Admin: tight gap +  │                                      │
│   first name with full-name title  │                                      │
└────────────────────────────────────┴──────────────────────────────────────┘
```

---

### 5. Verification, Tests & Documentation Updates

1. **Automated Unit Tests (`tests/navConfig.test.js` & `tests/navMenuState.test.js`)**:
   - Add a test in `tests/navConfig.test.js` that reads both `css/variables.css` (`--nav-mobile-breakpoint: 1024px`) and `js/navConfig.js` (`NAV_MOBILE_BREAKPOINT_PX = 1024`) and asserts that both equal `1024` and match each other.
   - Keep all existing Phase 14d `navConfig` tests (every `vite.config.ts` input page covered, no duplicate `href`s or `id`s) and update the desktop structure test to verify the full desktop inline + dropdown order for both `student` and `admin`.
2. **Documentation Updates (`docs/DECISIONS.md` & `docs/TESTING.md`)**:
   - Update `docs/DECISIONS.md` so the navigation decision records that desktop (`>= 1024 px`) keeps the full inline links and dropdowns (`Practice ▾` and `Setup ▾`), the three-dot menu is strictly for screens below `1024 px`, and both read from the single `js/navConfig.js`.
   - Update `docs/TESTING.md` with a step-by-step verification checklist at `390`, `768`, `1023`, `1024`, `1280`, and `1440 px` for both **Student** and **Admin** roles.

---

### 6. Session Summary (5 Lines)
1. Audited the header navigation across HTML templates, `js/navConfig.js`, `js/headerNav.js`, and `css/style.css`, noting that no `.git` history exists in the container while the pre-14d Student (`Practice ▾` + bell) and Admin (`Setup ▾`) markup structures remain in `pages/student.html` and `pages/report.html`.
2. Designed a unified `js/navConfig.js` model that feeds both the `< 1024 px` three-dot menu and the `>= 1024 px` desktop inline links + dropdowns (`Practice ▾` for students, `Setup ▾` for admins) without duplicating link lists.
3. Defined a single `1024 px` breakpoint constant (`--nav-mobile-breakpoint: 1024px` in `css/variables.css` and `NAV_MOBILE_BREAKPOINT_PX = 1024` in `js/navConfig.js`) paired with `matchMedia('(min-width: 1024px)')` to close menus on resize and keep only one navigation active at a time.
4. Specified compact Admin header spacing and first-name display (`data-short-name` with full-name tooltip) between `1024 px` and `1280 px` so `"Trendz Tracker"`, links, and user names never wrap at `1024`, `1100`, `1280`, or `1440 px`.
5. Planned unit tests verifying CSS/JS breakpoint constant parity and `docs/DECISIONS.md` + `docs/TESTING.md` updates covering `390, 768, 1023, 1024, 1280, and 1440 px` for both roles, with zero new dependencies.

---

### 7. Beginner Test Guide (To Run After Approval)
1. **Run the automated tests**: Run `node --test tests/navConfig.test.js tests/navMenuState.test.js` to confirm all pages are listed once in `js/navConfig.js` and the `1024 px` breakpoint matches between CSS and JS.
2. **Check Desktop (`1024 px`, `1100 px`, `1280 px`, `1440 px`)**: Open DevTools Device Toolbar (`Ctrl+Shift+M`) at `1024 px` and above; confirm the three-dot button is completely gone (`display: none`), Students see `Today, Round scores, Practice ▾, Weekly Test, Leaderboard, Monthly Report` + the Notifications bell, and Admins see `Overview, Review, Students, Attendance, Weekly Tests, Leaderboard, Monthly Report, Setup ▾` on one single line without wrapping.
3. **Check Mobile (`1023 px`, `768 px`, `390 px`)**: Resize to `1023 px` or below; confirm the inline links disappear and the `44×44` three-dot button appears beside `"Trendz Tracker"`, opening the panel (`701–1023 px`) or left slide-in drawer (`<= 700 px`).
4. **Check Live Resize (`matchMedia`)**: Open the three-dot menu at `900 px` and drag the viewport width past `1024 px`; confirm the mobile menu closes automatically and switches to the desktop inline bar without reloading.

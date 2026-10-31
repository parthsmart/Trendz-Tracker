# Phase 14d — Trendz Tracker: Header Three-Dot Navigation Menu & Single Navigation Config

Introduce a unified, single-source navigation system and a responsive three-dot (`⋮`) header menu beside the **Trendz Tracker** brand title so students have full navigation on mobile phones and admin headers never wrap on desktop or tablet screens.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Dependencies**: **None** (`0` new npm packages or external libraries). All functionality uses plain HTML, CSS design tokens, vanilla JavaScript ES modules, and Node's built-in test runner (`node --test`).

- **Single Source of Truth (`navConfig`)**: Both the $\ge 1100\text{ px}$ short inline link bar and the full grouped three-dot menu read from a single role-keyed configuration (`student` and `admin`). No page maintains a separate hard-coded link list.
- **Responsive Breakpoints**:
  - **$\ge 1100\text{ px}$**: Shows the short inline link list (`Today`, `Weekly Test`, `Leaderboard` for students; `Overview`, `Students`, `Review`, `Weekly Tests` for admins) alongside the three-dot menu button, which opens an anchored dropdown panel (`~300 px` wide, `max-height: calc(100vh - 80px)`) containing every page grouped by category.
  - **$701\text{ px} \text{ – } 1099\text{ px}$**: Hides the inline links completely so the header never wraps; clicking the three-dot button opens the anchored dropdown panel under the button.
  - **$\le 700\text{ px}$**: Hides the inline links, shortens the account display name to the user's first name when space is tight, and opens the menu as a left slide-in drawer with a dimmed backdrop overlay, focus trap, and body scroll lock.
- **Full-Screen Stage Exclusion**: Focused practice and competition stages (`basics-practice`, `element-drill`, `memoriad-play`, plus active play states inside `flash` and `weekly-test`) never render or display the global header or three-dot menu—preserving their dedicated exit button without distraction.

---

## 1. Overview & Core Concept

- **What It Does**: Replaces scattered inline navigation bars and missing mobile student navigation with a single, consistent header bar (`[Logo] [Trendz Tracker] [3-Dot Menu Button] [Short Inline Links >= 1100px] [Right Account Name, ID & Sign Out]`) powered by one navigation configuration per role.
- **Target Audience / Persona**: Students practicing on phones/tablets who previously had no header navigation links, and teachers/admins whose 10+ top-bar links previously forced the brand title and teacher name onto multiple lines.
- **Key Value**: Every student and admin page is reachable in two taps from any screen size, the brand title never wraps (`white-space: nowrap` with ellipsis truncation on ultra-narrow viewports), unread student notifications surface both on the menu button dot and next to the Notifications menu item without extra network requests, and full keyboard accessibility (`Escape`, `ArrowUp`/`ArrowDown` wrap-around, focus trap, and focus restoration) works across all viewports.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Header Bar**: Left-to-right flow starting with the brand logo, `Trendz Tracker` (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`), and the `44 × 44 px` vertical three-dot button (`aria-label="Menu"`, `aria-haspopup="true"`, `aria-expanded`, `aria-controls`).
  2. **Student Unread Notification Indicator**: Reads the existing cached unread count from session storage / notification badge state (zero additional database requests). When unread $> 0$, displays a subtle semantic dot on the `44 × 44 px` menu button and a numeric badge next to **Notifications** inside the menu.
  3. **Opening the Menu**:
     - On viewports $> 700\text{ px}$, opens a clean card panel anchored directly below the menu button (`~300 px` wide, `max-height: calc(100vh - 80px)`, internal vertical scroll).
     - On viewports $\le 700\text{ px}$, slides in a left drawer over a dimmed overlay (`backdrop`), locks page scroll (`overflow: hidden` on `<body>`), and traps `Tab` / `Shift+Tab` focus inside the drawer.
     - Automatically moves keyboard focus to the first menu item upon open.
  4. **Navigating & Closing**:
     - Each menu row is at least `44 px` tall, grouped under subtle group headings (`Today`, `Practice`, `Weekly Test`, `Leaderboard`, `Monthly Report`, `Notifications`, `Account` for students; `Main`, `Settings` with the Settings hub link + all sub-pages, `Account` for admins).
     - The active page has `aria-current="page"` and a visible check mark / `"Current"` indicator (never relying on colour alone).
     - Pressing `ArrowDown` / `ArrowUp` (with wrap-around between last and first item), `Home`, or `End` moves focus across items.
     - Pressing `Escape`, clicking/tapping the backdrop or outside the panel, choosing a link, or changing pages closes the menu and restores focus to the three-dot menu button.
- **Visual Identity & Theme**:
  - Uses existing Phase 14b design tokens exclusively (`--bg-page`, `--bg-card`, `--border-color`, `--text-main`, `--text-muted`, `--accent`, `--accent-soft`, `--shadow-modal`, `--radius-md`, `--radius-lg`, spacing `4/8/12/16/24/32`, type scale `14/16/18/22/28`).
  - Single clean SVG stroke icon style (vertical three-dot icon and check mark indicator); zero emoji anywhere in headers, groups, or menu items.
  - Respects `@media (prefers-reduced-motion: reduce)` by disabling drawer slide transitions when reduced motion is enabled.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Single Navigation Config Driving Both Inline Bar and Menu**
  - *Chosen Approach*: Define every student and admin destination once in a single module with `{ id, label, href, group, inline, badge }`, validated by an automated test against the Vite multi-page build inputs.
  - *Why*: Eliminates drift between desktop inline links, mobile drawer links, and individual HTML templates. Adding or renaming a page updates every viewport automatically and is enforced by unit tests.
- **Decision 2: Menu as the Sole Navigation Below `1100 px`**
  - *Chosen Approach*: Show the 3–4 highest-frequency inline links only at $\ge 1100\text{ px}$ and hide inline links below `1100 px`.
  - *Why*: At tablet and phone widths (`390 px` – `1024 px`), even four inline links alongside the brand title, three-dot button, student/teacher name, ID chip, and Sign Out button cause line wrapping or horizontal overflow. Moving all navigation into the three-dot menu below `1100 px` guarantees a single-line, calm header at every width.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Vite Multi-Page Entry Points                         │
│  • Student pages (10)   • Admin pages (17)   • Stage/Public allowlist (5)│
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │Validated by node --test
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        Single Navigation Config                          │
│  • Role: 'student' (Today, Practice[5], Weekly Test, Leaderboard,        │
│    Monthly Report, Notifications[badge], Account, Sign out)              │
│  • Role: 'admin' (Overview, Students, Review, Attendance, Weekly Tests,  │
│    Leaderboard, Monthly Report, Settings Hub + 10 Settings pages,        │
│    Account, Sign out)                                                    │
└─────────────────┬───────────────────────────────────────┬────────────────┘
                  │                                       │
                  ▼                                       ▼
┌───────────────────────────────────┐   ┌──────────────────────────────────┐
│       Pure Menu State Engine      │   │     Unified Header Controller    │
│  • open / close state transitions │   │  • Mounts [Logo][Title][⋮ Button]│
│  • ArrowUp / ArrowDown wrap index │   │  • Renders short inline links    │
│  • Home / End & Tab focus trap    │   │    (>= 1100px only)              │
│  • Full-screen stage detection    │   │  • Renders anchored panel (>700) │
└───────────────────────────────────┘   │    or left drawer (<=700px)      │
                                        │  • Syncs cached unread badge dot │
                                        └──────────────────────────────────┘
```

- **Data Model & State**:
  - **Role Navigation Entry**: `{ id, label, href, group, inline, badge, action }` where `action: 'signout'` handles the Sign Out item and `action: 'account'` jumps to or highlights the user's account section/profile action.
  - **Menu State Object**: `{ isOpen: boolean, focusedIndex: number, itemCount: number, triggerReturnFocus: boolean }` managed by pure functions so every keyboard transition (`ArrowDown`, `ArrowUp`, `Home`, `End`, `Tab`, `Shift+Tab`, `Escape`) is deterministically testable without a browser DOM.
  - **Stage Exclusion Guard**: Automatically skips rendering the header/menu on `/pages/basics-practice.html`, `/pages/element-drill.html`, `/pages/memoriad-play.html`, and dynamically hides the `.header` when `flash.html` or `weekly-test.html` enters an active timed play/test stage.

---

## 5. Five-Line Session Summary & Beginner Test Guide

### 5-Line Session Summary
1. Audited all 32 HTML entry points in the Vite build configuration and mapped every student and admin page into a single role-based navigation design (`student` and `admin`) with an explicit allowlist for login and full-screen drill stages.
2. Designed the pure menu state engine covering open/close state transitions, wrap-around `ArrowUp`/`ArrowDown` focus indexing, and `Tab`/`Shift+Tab` focus trapping.
3. Designed the unified non-wrapping header layout (`[Logo] [Trendz Tracker] [44×44 Three-Dot Menu Button] [Short Inline Links >=1100px] [Right Account & Sign Out]`) using existing Phase 14b CSS tokens.
4. Configured student unread notification counts to reuse the existing cached badge state so both the menu button dot and the Notifications menu row update with zero extra network calls.
5. Prepared automated `node --test` suites and step-by-step responsive verification guides at `1280 px`, `1024 px`, `768 px`, and `390 px`.

### Beginner Test Guide (After Approval)
1. **Run Automated Tests**: Run `node --test tests/navConfig.test.js tests/navMenuState.test.js` in the terminal and confirm every page in `vite.config.ts` is accounted for with zero duplicate links and all keyboard state tests pass.
2. **Check Desktop Width (`1280 px`)**: Sign in as a Student and as an Admin; confirm `Trendz Tracker` stays on one line, the `⋮` button sits right beside it, only the short inline links appear (`Today, Weekly Test, Leaderboard` for student; `Overview, Students, Review, Weekly Tests` for admin), and clicking `⋮` opens a `~300 px` panel anchored under the button.
3. **Check Tablet Widths (`1024 px` and `768 px`)**: Resize the browser to `1024 px` and `768 px`; confirm all inline links hide, the header stays on a single clean line, and clicking `⋮` opens the anchored menu panel with all grouped pages and a visible checkmark on the current page.
4. **Check Phone Width (`390 px`)**: Resize to `390 px`; confirm clicking `⋮` opens a left slide-in drawer over a dimmed backdrop, locks background scrolling, traps `Tab` focus inside the drawer, and closes when pressing `Escape` or tapping the backdrop (returning focus to `⋮`).
5. **Check Full-Screen Practice Stages**: Start a Flash Anzan try, Basics timed round, Elements drill, Memoriad stage, or active Weekly Test section and confirm the global header and `⋮` menu are hidden while the stage's own exit button remains visible.

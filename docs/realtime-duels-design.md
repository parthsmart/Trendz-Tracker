# Real-time Duels — design proposal (for approval)

Reference: **Matiks** (mental-math app). From its store listings and public player
material: live 1v1 "math duels" against friends or random players, ~60-second
sprints solving as many questions as possible, a chess-style rating that moves
after every duel, global leaderboards, streaks and a post-duel review. Not
confirmed publicly: bot fallback, identical questions for both sides, chat/emotes,
anti-cheat. We copy the mechanics only — no Matiks name, art or branding.

## What exists today (audit)
- `duels` table + `/api/drill` actions `duel_create` / `duel_cancel`; play via
  `basics-practice.html?duel=<id>`. **Asynchronous**: each side plays whenever
  within 3 days. Same seeded 60 s basics round, server-graded at the end, winner
  decided in SQL (`duel_record_result`). 3 sent per day, same level only.
- XP: a duel round is an ordinary basics round (normal XP + daily factor). No
  win bonus. Badges: first duel, win, 10 wins.
- No Supabase Realtime anywhere yet. No centre column on profiles yet (the
  multi-centre session is still designing it).

## Proposed experience
1. **Quick match** — tap "Find opponent". Paired with a student at the **same
   level and same centre** (when centres exist), closest duel rating first.
2. **Ghost fallback** — nobody found in ~10 s → race a *ghost*: a replay of a
   real past live run (answer-by-answer timings) at the same level and category.
   Shown as "Ghost runner (KA-3)", never the other child's name.
3. **Challenge a classmate live** — invite someone from your class list; they
   get an in-app invite card (30 s to accept). Existing "play later" duels stay.
4. **The race** — 3-2-1 countdown, 60 s, same questions for both (shared seed).
   Two progress lanes update live with each correct answer; timer on top.
5. **Results** — winner banner, final race bar, correct/attempted for both,
   XP earned, rating change, **Rematch** (both tap → new seed, same pair).
6. **Duel rating** — simple Elo (start 1000, K = 24; ghost duels move it half),
   plus a "Top duellists" board in the student's centre/level.

## Technical design
- **Tables** (new migration `29_realtime_duels.sql`):
  `duel_queue` (student, level, centre_id, rating, joined_at),
  `live_duels` (id, a_id, b_id or ghost_of, level, centre_id, category, seed,
  start_at, end_at, status, a_correct/a_attempted, b_…, winner, rematch_of),
  `live_duel_answers` (duel, student, q_index, answer, correct, answered_at),
  `duel_ratings` (student, rating, played, won). RLS: participants read their
  own rows; all writes by the service role only.
- **Realtime**: private channel `duel:<id>` (Realtime Authorization so only the
  two players can join). **Presence** = who is connected; **broadcast** =
  progress + emotes, sent **by the server** after it grades each answer.
  A per-user channel `duel-user:<id>` delivers "matched"/"invite" events.
  Polling every 2 s is the fallback if the socket drops.
- **Server-authoritative scoring**: the browser never sees expected answers.
  Each answer goes to `/api/drill` `live_answer` (duel, q_index, answer); the
  server checks order, the 60 s window (+2 s grace), minimum 0.25 s per answer,
  grades it, stores it, updates the counts and broadcasts. Final result and
  winner computed in SQL. The client's own counts are display only.
- **Matchmaking**: SQL function with `FOR UPDATE SKIP LOCKED` pairs atomically;
  pure JS helpers (`pickOpponent`, rating window widening) unit-tested.
- **Reconnect**: reloading the page rejoins the same duel and resumes at the
  server's clock. A player who leaves keeps the score they had; never joining
  within 15 s of start = forfeit.
- **Limits**: 30 live duels/hour, 1 queue entry at a time, answers rate-limited
  per duel. **XP**: normal round XP + win 15 / draw 8 / loss 5 bonus, bonus only
  for the first 10 duels a day (ghost duels: half bonus).
- **Child safety**: no free text at all. Six preset emotes (👍 😮 🔥 👏 😅 🤝), max
  one every 3 s, any player can mute them.
- **Teachers/admins**: "Live duels" panel — today's duels per student, results,
  flags (too-fast answers), and an on/off switch for live duels.
- **Centres**: `centre_id` stored on queue and duel rows, filled from a single
  helper `duel_centre_of(student)` that returns NULL until the multi-centre work
  lands; that session only has to redefine one function.

## Build & test plan
Unit tests for seeding, grading/validation, timing checks, matchmaking and
Elo; `node --test tests/*.test.js` + `npm run build`; live two-tab duel with
demo accounts; release to production only after you confirm.

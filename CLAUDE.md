# SlopWok – notes for Claude

Mobile-first web app for shared households: meal plan, shopping list, shared money, progress and nudges.
Features and file layout are in `README.md` (sections at the top and "Aufbau"). Read it instead of guessing.
This repo is **public on GitHub**. Server addresses, hostnames, passwords and deploy details go in `CLAUDE.local.md`
(gitignored), never in this file.

## Keeping this file useful
- Update this file during the session whenever something changes that the next session needs: a new rule from the
  user, a new convention, a gotcha that cost time, a feature that changes the domain rules below.
- Clean it up whenever it is needed. Delete what is outdated or can be read straight from the code, merge duplicates,
  and keep it under ~150 lines. Same for `CLAUDE.local.md`.
- Write facts and rules, not history. Commit messages hold the history.
- A rule that must never be broken belongs in a test or hook. Do not just add more emphasis here.

## Commands
- `npm start`: server on :8787 (`PORT`, `HOST`, `DATA_DIR`, `REGISTRATION_CODE`, `TRUST_PROXY`, `VAPID_SUBJECT`)
- `npm run dev`: same with `--watch`
- `npm test`: `node --test test/`. Run it before every commit. Single file: `node --test test/swipe.test.js`
- `node tools/build-icons.mjs`: regenerate `public/icons/` from `public/js/woki.js` (needs `rsvg-convert`)
- `npm run seed`: rebuild `server/seed.json` (the 41 starter dishes)

## Hard constraints
- **Zero npm dependencies, no build step.** Node ≥ 22.13 with built-in `node:sqlite`. The frontend is plain ES modules.
  Web Push (`server/push.js`) and JPEG metadata stripping (`server/photo.js`) are written by hand on purpose. Don't
  add packages unless the user asks.
- **Everything is vegan.** Never add non-vegan dishes, templates or nutrition values (`shared/estimates.js`, seed).
- **German** for UI text, code comments, commit messages and docs. Commit style: short German summary line, e.g.
  "Fotos zu Gerichten als Opt-in".

## Code conventions
- API: every route in `server/api.js` gets `{ db, user, hh, members, params, query, body, today }` and returns JSON.
  Errors go through `bad(msg, status)` / `HttpError`.
- DB migrations in `server/db.js`: `CREATE TABLE IF NOT EXISTS` plus `if (!hasCol(...)) ALTER TABLE ...`. They must
  work on the existing live DB. No migration framework.
- `shared/` runs in both browser and server (`validateDish`, LLM prompt, estimates). Keep it free of Node and DOM APIs.
- Frontend renders HTML strings. **Every** user-controlled value goes through `esc()` from `public/js/core.js`. That
  includes units, names and values that come out of formatters.
- Clicks go through one `data-act` dispatcher in `public/js/app.js`. It ignores repeated clicks on an action that is
  still running (double-taps once created 21 duplicate dinners). Keep new actions on that path.
- Dates are ISO strings `YYYY-MM-DD`. Use the helpers in `core.js` / `logic.js` (`addDays`, `mondayOf`, …).
- Design "Woki's Teahouse": color tokens at the top of `public/app.css` (text colors use the `*-ink` variants for
  contrast). Woki the mascot (`woki.js`): `woki()` has three fixed moods (happy, nudge, sleepy) and feeds the app icons;
  `wokiLive()` draws his state. Preview all variants by rendering them to PNG with `rsvg-convert`.

## Domain rules (decided by the user, not obvious from the code)
- Only the **warm dinner** is shared in a household. Breakfast, lunch, snack and extras are private to each person.
  Others can't see or change them.
- **Shopping:** you only buy what you cook yourself, alone or with others. A person who eats something else
  ("Anders gegessen", `meal_eaters.actual`) is removed from the cook amount, the shopping list and the kcal cost split.
  A portion kept as tomorrow's leftover still counts. Future days can't be ticked off (server returns 400).
- **Swipe** (`server/swipe.js`): the main goal is finding **shared** dishes. A match needs ≥ 2 people, except in a
  one-person household. Every vote replans next Mon–Sun: largest group that likes the same dish first, everyone else
  gets normal suggestions. Liked but uncooked dishes go to the front of the next round's deck. Votes are private.
  Manual and template meals and days whose shopping is done are never overwritten. The week is frozen from Monday.
- **Photos** are opt-in per account (default off, Settings › Optionen). One photo per household+dish, visible only to
  that household.
- **Woki companion** (`shared/woki-state.js`, issue #3): Woki mirrors the last 7 days (logged 20 %,
  protein 45 %, kcal within 85–115 % 35 %; older days decay). Today only counts if it raises the score. Days before
  signup count as neutral. Five stages, the lowest one smokes and has a beer can and fries. Width follows the kcal average (thin / wide). Top stage
  shows the goal from the goal calculator. Woki's state is private: never show it to others (it would reveal the goal).
  The daily reminder (`remind`, default 19:00 in the device's `tz`) is push-only, at most once a day, within 3 h of the
  time, and only when there is something to say. It is not stored under Neuigkeiten. Both can be switched off.
- **Privacy:** progress visibility is nobody / household / everyone. Any route that returns other people's meals or
  progress has to respect it.

## Security checklist (lessons from earlier audits)
- Static file serving: path traversal through encoded slashes (`/shared/..%2f…`) was once possible. Keep the
  test that covers it.
- Bulk routes (e.g. clearing the plan) must only touch the caller's own rows or shared dinners, never others' private
  meals.
- Grepping for `esc` is not enough. Check formatter output and every field the client renders.
- Before pushing: scan the outgoing commits for real names, IPs, invite or registration codes, since the repo is public.

## Testing
- Unit and API tests use an in-memory DB (`openDb(':memory:')`) and a fake push fetch. See the top of `test/api.test.js`.
- Browser E2E scripts live **outside** the repo in `../slopwok-uitest/` (`SCRIPT=<x>.mjs bash run.sh <workdir>`).
  There is no Chromium or Playwright here. Headless Firefox is driven over WebDriver BiDi with Node's built-in
  WebSocket. Log in through the real form (`requestSubmit`). Reload with a changed query string to refresh views.
- Data: `data/slopwok.db` (an older `data/kochrunde.db` is used if it exists). Back up with `VACUUM INTO`, not by
  copying the file, because the `-wal` file can hold changes that aren't in the main file yet.

## Workflow
- Order: commit → deploy → check live → push to GitHub. **Ask the user before each deploy and before each push.**
- Deploy details: `CLAUDE.local.md`.
- Product decisions such as names, rules or UX trade-offs belong to the user. Offer options when unsure, then write
  the decision under "Domain rules".

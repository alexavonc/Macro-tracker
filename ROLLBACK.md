# MacroWorld — Supabase cutover rollback

Cutover commit (Supabase): `9d45c48` — "S8 cutover: MacroWorld persistence Firebase → Supabase" (merged to `main`, 2026-09-18).

## When to roll back
Prod on Supabase is broken (auth failing, data not loading/saving) and can't be hot-fixed quickly.

## How (lossless — Firestore was only read during migration, never modified)
    cd Macro-tracker
    git checkout main && git pull --ff-only origin main
    git revert -m 1 9d45c48        # reverts the whole cutover merge
    git push origin main            # Railway auto-redeploys the Firebase build

Prod is back on Firebase within ~1–2 min. No user data is lost.

## After rollback
- Users re-login with Google (back on the Firebase session).
- Supabase rows remain intact; re-attempt cutover after fixing the issue.

## Decommission (only once Supabase is confirmed stable for a sustained period)
- Keep the Firebase project intact until then — it is the rollback target.
- Do not delete Firestore data or the Firebase project before that point.

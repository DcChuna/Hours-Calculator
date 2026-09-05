# Firebase -> Supabase migration

Files to add/replace in your GitHub repo (same paths as in the repo root):

- DELETE: src/firebase.ts
- ADD:    src/supabaseClient.ts
- REPLACE: src/App.tsx
- REPLACE: package.json
- ADD:    supabase/schema.sql   (run this in the Supabase SQL editor, not part of the app bundle)
- ADD:    .env.local.example    (copy to .env.local, do NOT commit .env.local)

See the chat response for the full step-by-step (Supabase dashboard setup + auth settings).

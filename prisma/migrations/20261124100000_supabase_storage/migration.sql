-- Keep Guilded uploads private. The backend creates signed upload/download URLs
-- with the server-only Supabase service role key.
INSERT INTO storage.buckets (id, name, public)
VALUES ('guilded-uploads', 'guilded-uploads', false)
ON CONFLICT (id) DO UPDATE
SET public = false;

-- Migration 057: Receipt attachments (Supabase Storage)
-- Adds a receipt_path column to expenses and stock_receipts,
-- and creates the storage bucket with org-scoped RLS.

-- 1. Add attachment columns
ALTER TABLE expenses
  ADD COLUMN receipt_path TEXT;

ALTER TABLE stock_receipts
  ADD COLUMN receipt_path TEXT;

-- 2. Create the storage bucket (private — signed URLs only)
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage RLS policies
-- Uploads: authenticated users can upload under their org's folder
CREATE POLICY "Users can upload receipts to their org folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'receipts'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.organizations
    WHERE id IN (SELECT public.current_user_org_ids())
  )
);

-- Downloads: authenticated users can read their org's receipts
CREATE POLICY "Users can read receipts from their org folder"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'receipts'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.organizations
    WHERE id IN (SELECT public.current_user_org_ids())
  )
);

-- Deletes: authenticated users can delete their org's receipts
CREATE POLICY "Users can delete receipts from their org folder"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'receipts'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.organizations
    WHERE id IN (SELECT public.current_user_org_ids())
  )
);

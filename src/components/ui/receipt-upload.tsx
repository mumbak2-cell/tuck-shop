"use client";
import { useState, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { Upload, X, FileText, Image as ImageIcon, Loader2 } from "lucide-react";

const MAX_SIZE_MB = 5;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

interface ReceiptUploadProps {
  orgId: string;
  /** Called with the storage path after a successful upload, or null when cleared. */
  onUploaded: (path: string | null) => void;
  /** Current path (for showing a preview of an already-attached file). */
  value?: string | null;
}

export function ReceiptUpload({ orgId, onUploaded, value }: ReceiptUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; type: string } | null>(
    value ? { name: value.split("/").pop() || "receipt", type: "" } : null
  );

  async function handleFile(file: File) {
    setError(null);

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError("Only PDF, JPEG, PNG, or WebP files are allowed.");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_SIZE_MB} MB.`);
      return;
    }

    setUploading(true);
    const ext = EXT_BY_TYPE[file.type] || "bin";
    const storagePath = `${orgId}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from("receipts")
      .upload(storagePath, file, { contentType: file.type, upsert: false });

    setUploading(false);

    if (uploadErr) {
      setError("Upload failed: " + uploadErr.message);
      return;
    }

    setPreview({ name: file.name, type: file.type });
    onUploaded(storagePath);
  }

  async function handleRemove() {
    if (value) {
      await supabase.storage.from("receipts").remove([value]);
    }
    setPreview(null);
    setError(null);
    onUploaded(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const isPdf = preview?.type === "application/pdf" || preview?.name.endsWith(".pdf");

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Receipt / Invoice (optional)
      </label>

      {preview ? (
        <div className="flex items-center gap-3 border border-gray-200 rounded-lg px-3 py-2.5 bg-gray-50">
          {isPdf ? (
            <FileText className="w-5 h-5 text-red-500 shrink-0" />
          ) : (
            <ImageIcon className="w-5 h-5 text-blue-500 shrink-0" />
          )}
          <span className="text-sm text-gray-700 truncate flex-1">{preview.name}</span>
          <button
            type="button"
            onClick={handleRemove}
            className="p-1 text-gray-400 hover:text-red-600 rounded"
            aria-label="Remove attachment"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="w-full border-2 border-dashed border-gray-300 rounded-lg px-4 py-4 text-center hover:border-green-400 hover:bg-green-50/50 transition-colors disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="w-5 h-5 mx-auto text-green-600 animate-spin" />
          ) : (
            <>
              <Upload className="w-5 h-5 mx-auto text-gray-400 mb-1" />
              <span className="text-sm text-gray-500">
                Tap to attach PDF or photo (max {MAX_SIZE_MB} MB)
              </span>
            </>
          )}
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />

      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

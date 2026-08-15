"use client";
import { useEffect, useRef, useState } from "react";
import { Search, Camera, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";

export interface BarcodeScanInputProps {
  value: string;
  onChange: (value: string) => void;
  onScan: (code: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

const BARCODE_FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "qr_code"];

export function BarcodeScanInput({
  value,
  onChange,
  onScan,
  placeholder,
  autoFocus,
  disabled,
}: BarcodeScanInputProps) {
  const [cameraSupported, setCameraSupported] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  useEffect(() => {
    setCameraSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && value) {
      onScan(value);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          className="block w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-green-500 focus:ring-1 focus:ring-green-500 disabled:bg-gray-50 disabled:text-gray-500"
        />
      </div>
      {cameraSupported && (
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          disabled={disabled}
          aria-label="Scan barcode with camera"
          className="flex-shrink-0 p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Camera className="w-5 h-5" />
        </button>
      )}
      {cameraOpen && (
        <CameraScanModal
          onClose={() => setCameraOpen(false)}
          onDetect={(code) => {
            setCameraOpen(false);
            onScan(code);
          }}
        />
      )}
    </div>
  );
}

function CameraScanModal({
  onClose,
  onDetect,
}: {
  onClose: () => void;
  onDetect: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function stopStream() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const DetectorCtor = (window as any).BarcodeDetector;
        const detector = new DetectorCtor({ formats: BARCODE_FORMATS });

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && !cancelled) {
              const raw = codes[0].rawValue;
              stopStream();
              onDetect(raw);
              return;
            }
          } catch {
            // Detection failure on a single frame — keep trying.
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setError("Camera unavailable — enter code manually");
      }
    }

    start();

    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    stopStream();
    onClose();
  }

  return (
    <Modal open onClose={handleClose} title="Scan barcode">
      {error ? (
        <div className="text-center py-6">
          <p className="text-sm text-red-600 mb-4">{error}</p>
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 rounded-lg bg-gray-100 text-gray-900 text-sm font-medium hover:bg-gray-200"
          >
            Close
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden bg-black">
            <video ref={videoRef} className="w-full h-64 object-cover" muted playsInline />
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gray-100 text-gray-900 text-sm font-medium hover:bg-gray-200"
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
        </div>
      )}
    </Modal>
  );
}

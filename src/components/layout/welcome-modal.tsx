"use client";
import { useState, useEffect } from "react";
import { BookOpen, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

const STORAGE_KEY = "tilify_welcome_dismissed";

export function WelcomeModal() {
  const [show, setShow] = useState(false);
  const { role } = useAuth();

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed) setShow(true);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setShow(false);
  };

  const isCashier = role === "cashier";
  const manualUrl = isCashier ? "/cashier-guide.html" : "/manual.html";
  const description = isCashier
    ? "New here? Our cashier guide covers the POS, shift management, stock counts and more. Takes about 2 minutes to read."
    : "New here? Our user manual covers everything from making your first sale to reading your profit reports. It takes about 10 minutes to get familiar.";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative">
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 p-1 text-gray-400 hover:text-gray-600 rounded-lg"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex flex-col items-center text-center">
          <div className="w-14 h-14 bg-green-50 rounded-xl flex items-center justify-center mb-4">
            <BookOpen className="w-7 h-7 text-green-700" />
          </div>

          <h2 className="text-xl font-bold text-gray-900 mb-2">Welcome to Tilify!</h2>
          <p className="text-sm text-gray-600 mb-6">{description}</p>

          <div className="flex gap-3 w-full">
            <button
              onClick={dismiss}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Skip for now
            </button>
            <a
              href={manualUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={dismiss}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-green-700 hover:bg-green-800 rounded-lg transition-colors text-center"
            >
              {isCashier ? "Read the Guide" : "Read the Manual"}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { ShieldAlert, CheckCircle2, X, Eye, EyeOff } from 'lucide-react';

interface ConfirmItem {
  label: string;
  value: string;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  items?: ConfirmItem[];
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'teal' | 'danger' | 'amber';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  items = [],
  confirmLabel = 'নিশ্চিত করুন',
  cancelLabel = 'বাতিল',
  variant = 'teal',
  loading = false,
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;

  const btnStyle =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-700 text-white'
      : variant === 'amber'
        ? 'bg-amber-600 hover:bg-amber-700 text-white'
        : 'bg-[#0f4c5c] hover:bg-[#135d66] text-white';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-5 w-5 text-[#0f4c5c]" />
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="বন্ধ করুন"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {description && <p className="text-sm text-slate-600">{description}</p>}

          {items.length > 0 && (
            <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-slate-50">
              {items.map((it, idx) => (
                <div key={idx} className="flex items-center justify-between gap-4 px-3.5 py-2 text-sm">
                  <span className="text-slate-600">{it.label}</span>
                  <span className="font-semibold text-slate-900 tabular-nums text-right">{it.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 px-5 py-3.5">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 ${btnStyle}`}
          >
            {loading ? 'অপেক্ষা করুন...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AdminPasswordModalProps {
  open: boolean;
  title: string;
  description: string;
  error?: string;
  loading?: boolean;
  onConfirm: (adminPassword: string) => void;
  onCancel: () => void;
}

export const AdminPasswordModal: React.FC<AdminPasswordModalProps> = ({
  open,
  title,
  description,
  error,
  loading = false,
  onConfirm,
  onCancel,
}) => {
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(password);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="h-5 w-5 text-red-600" />
            <h3 className="text-base font-semibold text-slate-900">অ্যাডমিন পাসওয়ার্ড যাচাই</h3>
          </div>
          <button
            type="button"
            onClick={() => {
              setPassword('');
              onCancel();
            }}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="বন্ধ করুন"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 px-5 py-4">
          <p className="text-sm font-medium text-slate-900">{title}</p>
          <p className="text-sm text-slate-600">{description}</p>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700">
              ডিলিট নিশ্চিত করতে অ্যাডমিন পাসওয়ার্ড দিন
            </label>
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                placeholder="অ্যাডমিন পাসওয়ার্ড লিখুন"
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 pr-10 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 px-5 py-3.5">
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setPassword('');
              onCancel();
            }}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            বাতিল
          </button>
          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {loading ? 'যাচাই হচ্ছে...' : 'স্থায়ীভাবে ডিলিট করুন'}
          </button>
        </div>
      </form>
    </div>
  );
};

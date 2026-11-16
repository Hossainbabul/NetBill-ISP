import React, { useState } from 'react';
import { Eye, EyeOff, Lock, LogIn, User, CreditCard, Wifi } from 'lucide-react';
import { api, saveSessionToken } from '../api';
import { SessionUser } from '../types';

interface LoginViewProps {
  onLoginSuccess: (user: SessionUser) => void;
  onOpenPayPortal: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess, onOpenPayPortal }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.login(username, password);
      saveSessionToken(res.user.token, rememberMe);
      onLoginSuccess(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-100 px-4 py-10">
      <div className="mx-auto w-full max-w-md space-y-5">
        <div className="text-center">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#0f4c5c] text-white">
            <Wifi className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-2xl font-bold text-slate-900">NetBill ISP</h1>
          <p className="mt-1 text-sm text-slate-600">
            ইন্টারনেট ও ক্যাবল টিভি বিলিং ম্যানেজমেন্ট সিস্টেম
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                ইউজারনেম (Admin / Collector)
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ইউজারনেম লিখুন"
                  className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-3.5 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">পাসওয়ার্ড</label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type={showPwd ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="পাসওয়ার্ড লিখুন"
                  className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-10 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                  aria-label="পাসওয়ার্ড দেখুন"
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-[#0f4c5c] focus:ring-[#0f4c5c]"
                />
                আমাকে মনে রাখুন
              </label>
            </div>

            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" />
              {loading ? 'লগইন হচ্ছে...' : 'লগইন করুন'}
            </button>
          </form>
        </div>

        {/* Public Customer E-Billing Portal Button */}
        <button
          type="button"
          onClick={onOpenPayPortal}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-[#0f4c5c] hover:bg-slate-50"
        >
          <CreditCard className="h-4 w-4" />
          গ্রাহক স্ব-সেবা ই-বিল পেমেন্ট পোর্টাল (বিকাশ / নগদ / ব্যাংক)
        </button>
      </div>
    </div>
  );
};

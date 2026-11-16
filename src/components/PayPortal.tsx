import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  Search,
  Send,
  Smartphone,
  Building2,
  AlertCircle,
} from 'lucide-react';
import { api } from '../api';
import { PaymentMethod, PublicPayLookupResponse, EPaymentRequest } from '../types';
import {
  formatBnCurrency,
  getCurrentMonthStr,
  getMonthLabelBn,
  paymentMethodBadgeClass,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';

interface PayPortalProps {
  initialCid?: string;
  onExitPortal?: () => void;
}

type DigitalMethod = Exclude<PaymentMethod, 'Cash'>;

export const PayPortal: React.FC<PayPortalProps> = ({ initialCid = '', onExitPortal }) => {
  const [query, setQuery] = useState(initialCid);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PublicPayLookupResponse | null>(null);
  const [error, setError] = useState('');

  const [activeMethod, setActiveMethod] = useState<DigitalMethod>('bKash');
  const [billingMonth, setBillingMonth] = useState(getCurrentMonthStr());
  const [amount, setAmount] = useState('');
  const [senderAccount, setSenderAccount] = useState('');
  const [trxId, setTrxId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittedTicket, setSubmittedTicket] = useState<EPaymentRequest | null>(null);
  const [copiedKey, setCopiedKey] = useState('');

  const runLookup = async (searchText: string) => {
    setLoading(true);
    setError('');
    setSubmittedTicket(null);
    try {
      const res = await api.publicLookup(searchText);
      setData(res);
      if (searchText.trim() && !res.customer) {
        setError('এই গ্রাহক আইডি বা মোবাইল নম্বর দিয়ে কোনো তথ্য পাওয়া যায়নি।');
      } else if (res.customer) {
        if (res.dueBills.length > 0) {
          setBillingMonth(res.dueBills[0].BillingMonth);
          setAmount(String(res.dueBills[0].DueAmount));
        } else {
          setBillingMonth(getCurrentMonthStr());
          setAmount(String(res.customer.MonthlyBill));
        }
        setSenderAccount('');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runLookup(initialCid);
  }, [initialCid]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    runLookup(query.trim());
  };

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 1800);
    } catch {
      // clipboard fallback ignored
    }
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data?.customer) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.publicSubmitEPayment({
        customerId: data.customer.CustomerID,
        billingMonth,
        amount: Number(amount),
        paymentMethod: activeMethod,
        senderNumberOrAccount: senderAccount,
        trxId,
        note,
      });
      setSubmittedTicket(res.request);
      setTrxId('');
      setNote('');
      // Refresh lookup to show latest pending request
      const refreshed = await api.publicLookup(data.customer.CustomerID);
      setData(refreshed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const company = data?.company;

  return (
    <div className="min-h-screen bg-slate-100 pb-12">
      {/* Top Company Header */}
      <header className="bg-[#0f4c5c] text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-lg font-bold tracking-tight sm:text-xl">
              {company?.CompanyName || 'NetBill ISP – ই-বিলিং পেমেন্ট পোর্টাল'}
            </h1>
            <p className="text-xs text-teal-100">
              {company ? `${company.Address} · হেল্পলাইন: ${toBnDigits(company.Phone)}` : 'অনলাইন বিল যাচাই ও ডিজিটাল পেমেন্ট'}
            </p>
          </div>
          {onExitPortal && (
            <button
              type="button"
              onClick={onExitPortal}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              অফিস লগইন
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto mt-6 max-w-4xl space-y-6 px-4 sm:px-6">
        {/* Lookup Box */}
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">আপনার বিল যাচাই করুন</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            আপনার সম্পূর্ণ গ্রাহক আইডি অথবা নিবন্ধিত সম্পূর্ণ মোবাইল নম্বর দিয়ে বিল দেখুন
          </p>

          <form onSubmit={handleSearchSubmit} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="সম্পূর্ণ গ্রাহক আইডি (যেমন: NB-1002) অথবা সম্পূর্ণ মোবাইল নম্বর লিখুন"
                className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-4 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#0f4c5c] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              {loading ? 'খোঁজা হচ্ছে...' : 'বিল দেখুন'}
            </button>
          </form>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {data?.customer && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left Column: Customer Info & Due Breakdown */}
            <div className="space-y-6 lg:col-span-5">
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3.5">
                  <div>
                    <p className="font-mono-num text-xs font-semibold text-[#0f4c5c]">
                      {data.customer.CustomerID}
                    </p>
                    <h3 className="text-lg font-bold text-slate-900">{data.customer.Name}</h3>
                    <p className="text-xs text-slate-500">
                      {data.customer.Area} · {data.customer.Package}
                    </p>
                  </div>
                  <span
                    className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                      data.customer.Status === 'এক্টিভ'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-red-200 bg-red-50 text-red-700'
                    }`}
                  >
                    {data.customer.Status}
                  </span>
                </div>

                <div className="mt-3.5 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">মোবাইল:</span>
                    <span className="font-mono-num text-slate-800">{toBnDigits(data.customer.Mobile)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">মাসিক বিল:</span>
                    <span className="font-semibold text-slate-900 tabular-nums">
                      {formatBnCurrency(data.customer.MonthlyBill)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-100 pt-2">
                    <span className="font-medium text-slate-700">সর্বমোট বকেয়া:</span>
                    <span
                      className={`text-base font-bold tabular-nums ${
                        data.totalDue > 0 ? 'text-red-600' : 'text-emerald-600'
                      }`}
                    >
                      {formatBnCurrency(data.totalDue)}
                    </span>
                  </div>
                </div>

                {data.lastPayment && (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                    <p className="font-semibold text-slate-700">সর্বশেষ পেমেন্টের তথ্য</p>
                    <p className="mt-1 text-slate-600">
                      তারিখ: {toBnDigits(data.lastPayment.Date)} · পরিমাণ:{' '}
                      <strong className="text-slate-900">{formatBnCurrency(data.lastPayment.Amount)}</strong>
                    </p>
                    <p className="text-slate-600">
                      মাধ্যম: {paymentMethodLabel(data.lastPayment.PaymentMethod)} · রিসিট:{' '}
                      <span className="font-mono-num">{data.lastPayment.ReceiptID}</span>
                    </p>
                  </div>
                )}
              </section>

              {/* Due Months Breakdown */}
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h4 className="text-sm font-semibold text-slate-900">বকেয়া বিলের বিবরণ</h4>
                {data.dueBills.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
                    কোনো বকেয়া বিল নেই। আপনি চাইলে অগ্রিম বিল পরিশোধ করতে পারেন।
                  </p>
                ) : (
                  <div className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200">
                    {data.dueBills.map((b) => (
                      <div key={b.BillID} className="flex items-center justify-between px-3.5 py-2.5 text-sm">
                        <div>
                          <p className="font-medium text-slate-900">{b.MonthLabel}</p>
                          <p className="text-xs text-slate-500">
                            বিল: {formatBnCurrency(b.Amount)} · জমা: {formatBnCurrency(b.PaidAmount)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-red-600 tabular-nums">{formatBnCurrency(b.DueAmount)}</p>
                          <p className="text-[11px] text-slate-500">{b.Status}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Recent E-Payment Submissions */}
              {data.recentRequests.length > 0 && (
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <h4 className="text-sm font-semibold text-slate-900">সাম্প্রতিক ই-পেমেন্ট অনুরোধ</h4>
                  <div className="mt-3 space-y-2.5">
                    {data.recentRequests.map((req) => (
                      <div
                        key={req.RequestID}
                        className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                      >
                        <div>
                          <p className="font-mono-num font-semibold text-slate-800">
                            {req.RequestID} · TrxID: {req.TrxID}
                          </p>
                          <p className="text-slate-500">
                            {getMonthLabelBn(req.BillingMonth)} · {paymentMethodLabel(req.PaymentMethod)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-slate-900 tabular-nums">
                            {formatBnCurrency(req.Amount)}
                          </p>
                          <span
                            className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                              req.Status === 'Approved'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                : req.Status === 'Rejected'
                                  ? 'border-red-200 bg-red-50 text-red-700'
                                  : 'border-amber-200 bg-amber-50 text-amber-700'
                            }`}
                          >
                            {req.Status === 'Approved'
                              ? 'অনুমোদিত'
                              : req.Status === 'Rejected'
                                ? 'বাতিল'
                                : 'অপেক্ষমাণ'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* Right Column: Payment Methods & Proof Submission */}
            <div className="space-y-6 lg:col-span-7">
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h3 className="text-base font-semibold text-slate-900">পেমেন্ট মাধ্যম নির্বাচন করুন</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  নিচের যেকোনো মাধ্যমে টাকা পাঠিয়ে নিচে TrxID / রেফারেন্স নম্বর জমা দিন
                </p>

                {/* Method Tabs */}
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(['bKash', 'Nagad', 'Rocket', 'Bank'] as DigitalMethod[]).map((method) => {
                    const active = activeMethod === method;
                    return (
                      <button
                        key={method}
                        type="button"
                        onClick={() => setActiveMethod(method)}
                        className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-semibold transition-colors ${
                          active
                            ? 'border-[#0f4c5c] bg-[#0f4c5c] text-white'
                            : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {method === 'Bank' ? (
                          <Building2 className="h-3.5 w-3.5" />
                        ) : (
                          <Smartphone className="h-3.5 w-3.5" />
                        )}
                        {method === 'bKash' && 'বিকাশ (bKash)'}
                        {method === 'Nagad' && 'নগদ (Nagad)'}
                        {method === 'Rocket' && 'রকেট (Rocket)'}
                        {method === 'Bank' && 'ব্যাংক (Bank)'}
                      </button>
                    );
                  })}
                </div>

                {/* Account Number & Step-by-Step Instructions */}
                {company && (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                    {activeMethod === 'bKash' && (
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${paymentMethodBadgeClass('bKash')}`}>
                              বিকাশ ({company.BkashType})
                            </span>
                            <p className="mt-1 font-mono-num text-lg font-bold text-slate-900">
                              {company.BkashNumber}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopy('bkash', company.BkashNumber)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            {copiedKey === 'bkash' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                            {copiedKey === 'bkash' ? 'কপি হয়েছে' : 'নম্বর কপি'}
                          </button>
                        </div>
                        <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600">
                          <li>বিকাশ অ্যাপ থেকে <strong>{company.BkashType === 'Merchant' ? 'Payment' : 'Send Money'}</strong> অপশনে যান।</li>
                          <li>নম্বর দিন: <strong className="font-mono-num">{company.BkashNumber}</strong> এবং বিলের টাকা লিখুন।</li>
                          <li>রেফারেন্সে আপনার আইডি (<strong className="font-mono-num">{data.customer.CustomerID}</strong>) লিখুন।</li>
                          <li>পেমেন্ট শেষে প্রাপ্ত <strong>TrxID</strong> নিচের ফর্মে জমা দিন।</li>
                        </ol>
                      </div>
                    )}

                    {activeMethod === 'Nagad' && (
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${paymentMethodBadgeClass('Nagad')}`}>
                              নগদ ({company.NagadType})
                            </span>
                            <p className="mt-1 font-mono-num text-lg font-bold text-slate-900">
                              {company.NagadNumber}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopy('nagad', company.NagadNumber)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            {copiedKey === 'nagad' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                            {copiedKey === 'nagad' ? 'কপি হয়েছে' : 'নম্বর কপি'}
                          </button>
                        </div>
                        <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600">
                          <li>নগদ অ্যাপ থেকে <strong>{company.NagadType === 'Merchant' ? 'Merchant Pay' : 'Send Money'}</strong> নির্বাচন করুন।</li>
                          <li>নম্বর দিন: <strong className="font-mono-num">{company.NagadNumber}</strong> এবং বিলের পরিমাণ লিখুন।</li>
                          <li>রেফারেন্সে <strong className="font-mono-num">{data.customer.CustomerID}</strong> উল্লেখ করে পিন দিন।</li>
                          <li>প্রাপ্ত <strong>TrxID</strong> নিচের ফর্মে জমা দিন।</li>
                        </ol>
                      </div>
                    )}

                    {activeMethod === 'Rocket' && (
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${paymentMethodBadgeClass('Rocket')}`}>
                              রকেট (Rocket)
                            </span>
                            <p className="mt-1 font-mono-num text-lg font-bold text-slate-900">
                              {company.RocketNumber}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopy('rocket', company.RocketNumber)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            {copiedKey === 'rocket' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                            {copiedKey === 'rocket' ? 'কপি হয়েছে' : 'নম্বর কপি'}
                          </button>
                        </div>
                        <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600">
                          <li>রকেট অ্যাপ বা *322# থেকে Send Money / Bill Pay করুন।</li>
                          <li>অ্যাকাউন্ট নম্বর: <strong className="font-mono-num">{company.RocketNumber}</strong>।</li>
                          <li>লেনদেন সম্পন্ন হলে Transaction ID নিচে সাবমিট করুন।</li>
                        </ol>
                      </div>
                    )}

                    {activeMethod === 'Bank' && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${paymentMethodBadgeClass('Bank')}`}>
                            ব্যাংক ট্রান্সফার / NPSB / BEFTN
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy('bank', company.BankDetails.AccountNo)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            {copiedKey === 'bank' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                            {copiedKey === 'bank' ? 'অ্যাকাউন্ট কপি হয়েছে' : 'অ্যাকাউন্ট কপি'}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 gap-1.5 text-xs text-slate-700 sm:grid-cols-2">
                          <p>ব্যাংক: <strong>{company.BankDetails.BankName}</strong></p>
                          <p>অ্যাকাউন্ট নাম: <strong>{company.BankDetails.AccountName}</strong></p>
                          <p>অ্যাকাউন্ট নং: <strong className="font-mono-num">{company.BankDetails.AccountNo}</strong></p>
                          <p>শাখা: <strong>{company.BankDetails.Branch}</strong></p>
                          <p>রাউটিং নং: <strong className="font-mono-num">{company.BankDetails.Routing}</strong></p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {submittedTicket && (
                  <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                    <div className="flex items-center gap-2 font-bold">
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      <span>আপনার পেমেন্ট তথ্য সফলভাবে জমা হয়েছে!</span>
                    </div>
                    <p className="mt-1 text-xs">
                      অনুরোধ টিকিট নং: <strong className="font-mono-num">{submittedTicket.RequestID}</strong> · TrxID:{' '}
                      <strong className="font-mono-num">{submittedTicket.TrxID}</strong> · পরিমাণ:{' '}
                      <strong>{formatBnCurrency(submittedTicket.Amount)}</strong>।
                    </p>
                    <p className="mt-1 text-xs text-emerald-700">
                      অফিস যাচাই করে অনুমোদন করলে আপনার বিল স্বয়ংক্রিয়ভাবে পরিশোধিত হবে।
                    </p>
                  </div>
                )}

                {/* Payment Proof Form */}
                <form onSubmit={handlePaymentSubmit} className="mt-5 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-700">বিলের মাস</label>
                      <select
                        value={billingMonth}
                        onChange={(e) => {
                          setBillingMonth(e.target.value);
                          const match = data.dueBills.find((b) => b.BillingMonth === e.target.value);
                          if (match) setAmount(String(match.DueAmount));
                        }}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                      >
                        {data.dueBills.map((b) => (
                          <option key={b.BillID} value={b.BillingMonth}>
                            {b.MonthLabel} (বকেয়া: {formatBnCurrency(b.DueAmount)})
                          </option>
                        ))}
                        {!data.dueBills.some((b) => b.BillingMonth === getCurrentMonthStr()) && (
                          <option value={getCurrentMonthStr()}>
                            {getMonthLabelBn(getCurrentMonthStr())} (অগ্রিম/চলতি)
                          </option>
                        )}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-700">টাকার পরিমাণ (৳)</label>
                      <input
                        type="number"
                        min={1}
                        required
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-700">
                        প্রেরকের নম্বর / ব্যাংক অ্যাকাউন্ট
                      </label>
                      <input
                        type="text"
                        required
                        value={senderAccount}
                        onChange={(e) => setSenderAccount(e.target.value)}
                        placeholder="যে নম্বর থেকে টাকা পাঠিয়েছেন"
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-700">
                        TrxID / রেফারেন্স নম্বর
                      </label>
                      <input
                        type="text"
                        required
                        value={trxId}
                        onChange={(e) => setTrxId(e.target.value)}
                        placeholder="যেমন: BK9X44K81P"
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">মন্তব্য (ঐচ্ছিক)</label>
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="যেকোনো অতিরিক্ত তথ্য"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#0f4c5c] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] disabled:opacity-60"
                  >
                    <Send className="h-4 w-4" />
                    {submitting ? 'জমা হচ্ছে...' : `${paymentMethodLabel(activeMethod)} পেমেন্ট তথ্য জমা দিন`}
                  </button>
                </form>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

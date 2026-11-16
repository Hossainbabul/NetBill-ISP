import React, { useEffect, useMemo, useState } from 'react';
import { X, Receipt, AlertCircle, Printer, MessageCircle, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { Bill, Collection, Customer, PaymentMethod, SettingsData, SmsLog } from '../types';
import {
  buildWhatsAppUrl,
  formatBnCurrency,
  getCurrentMonthStr,
  getMonthLabelBn,
  getUpcomingMonths,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';
import { ConfirmDialog } from './ConfirmDialog';
import { PrintPayload } from './PrintPreviewModal';

interface CollectBillModalProps {
  customer: Customer | null;
  bills: Bill[];
  collections: Collection[];
  company: Omit<SettingsData, 'AdminPassword'>;
  onClose: () => void;
  onCollected: () => Promise<void>;
  onPrint: (payload: PrintPayload) => void;
}

export const CollectBillModal: React.FC<CollectBillModalProps> = ({
  customer,
  bills,
  collections,
  company,
  onClose,
  onCollected,
  onPrint,
}) => {
  const [selectedMonth, setSelectedMonth] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [trxId, setTrxId] = useState('');
  const [senderAccount, setSenderAccount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savedReceipt, setSavedReceipt] = useState<Collection | null>(null);
  const [smsStatus, setSmsStatus] = useState<SmsLog | null>(null);
  const [resendingSms, setResendingSms] = useState(false);

  const customerBills = useMemo(() => {
    if (!customer) return [];
    return bills
      .filter((b) => b.CustomerID === customer.CustomerID)
      .sort((a, b) => a.BillingMonth.localeCompare(b.BillingMonth));
  }, [customer, bills]);

  const lastPayment = useMemo(() => {
    if (!customer) return null;
    return collections.find((c) => c.CustomerID === customer.CustomerID) || null;
  }, [customer, collections]);

  const monthOptions = useMemo(() => {
    if (!customer) return [];
    const seen = new Set<string>();
    const list: {
      value: string;
      label: string;
      due: number;
      paid: boolean;
      tag: string;
    }[] = [];

    for (const b of customerBills) {
      seen.add(b.BillingMonth);
      const isPaid = b.Status === 'পরিশোধিত' || b.DueAmount <= 0;
      const tag = isPaid
        ? 'পরিশোধিত'
        : b.Status === 'আংশিক'
          ? `আংশিক বাকি (${formatBnCurrency(b.DueAmount)})`
          : `বকেয়া (${formatBnCurrency(b.DueAmount)})`;
      list.push({
        value: b.BillingMonth,
        label: `${b.MonthLabel} — ${tag}`,
        due: b.DueAmount,
        paid: isPaid,
        tag,
      });
    }

    const upcoming = getUpcomingMonths(4, getCurrentMonthStr());
    for (const ym of upcoming) {
      if (!seen.has(ym)) {
        seen.add(ym);
        list.push({
          value: ym,
          label: `${getMonthLabelBn(ym)} — অগ্রিম (${formatBnCurrency(customer.MonthlyBill)})`,
          due: customer.MonthlyBill,
          paid: false,
          tag: 'অগ্রিম',
        });
      }
    }
    return list;
  }, [customer, customerBills]);

  useEffect(() => {
    if (!customer) return;
    setSavedReceipt(null);
    setSmsStatus(null);
    setError('');
    setTrxId('');
    setSenderAccount(customer.Mobile);
    setNote('');
    setPaymentMethod('Cash');
    const firstDue = monthOptions.find((m) => !m.paid);
    if (firstDue) {
      setSelectedMonth(firstDue.value);
      setAmount(String(firstDue.due || customer.MonthlyBill));
    } else if (monthOptions.length > 0) {
      setSelectedMonth(monthOptions[0].value);
      setAmount(String(customer.MonthlyBill));
    }
  }, [customer, monthOptions]);

  if (!customer) return null;

  const currentOpt = monthOptions.find((m) => m.value === selectedMonth);
  const totalDue = customerBills.reduce((s, b) => s + b.DueAmount, 0);

  const handleSubmitCheck = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (currentOpt?.paid) {
      setError('এই মাসের বিল ইতিমধ্যেই সম্পূর্ণ পরিশোধিত হয়েছে। অন্য মাস নির্বাচন করুন।');
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      setError('সঠিক টাকার পরিমাণ লিখুন।');
      return;
    }
    if (paymentMethod !== 'Cash' && !trxId.trim()) {
      setError('বিকাশ/নগদ/রকেট/ব্যাংক পেমেন্টের জন্য TrxID / রেফারেন্স নম্বর আবশ্যক।');
      return;
    }
    setConfirmOpen(true);
  };

  const handleCommitCollect = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await api.collectBill({
        customerId: customer.CustomerID,
        billingMonth: selectedMonth,
        amount: Number(amount),
        paymentMethod,
        trxId,
        senderAccount,
        note,
      });
      setConfirmOpen(false);
      setSavedReceipt(res.receipt);
      setSmsStatus(res.smsLog || null);
      await onCollected();
    } catch (err) {
      setConfirmOpen(false);
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const buildReceiptWa = (rec: Collection) => {
    const text = `সম্মানিত ${rec.CustomerName} (${rec.CustomerID}), আপনার ${getMonthLabelBn(
      rec.BillingMonth
    )} মাসের ${formatBnCurrency(rec.Amount)} বিল (${paymentMethodLabel(rec.PaymentMethod)}${
      rec.TrxID ? `, TrxID: ${rec.TrxID}` : ''
    }) সফলভাবে গৃহীত হয়েছে। রিসিট নং: ${rec.ReceiptID}। ধন্যবাদ - ${company.CompanyName}`;
    return buildWhatsAppUrl(customer.Mobile, text);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div>
            <h3 className="text-base font-bold text-slate-900">বিল গ্রহণ করুন</h3>
            <p className="text-xs text-slate-500">
              {customer.Name} · <span className="font-mono-num">{customer.CustomerID}</span> ·{' '}
              {customer.Package}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="বন্ধ করুন"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {/* Customer Summary Strip */}
          <div className="grid grid-cols-3 gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            <div>
              <span className="block text-slate-500">এরিয়া</span>
              <span className="font-semibold text-slate-900">{customer.Area}</span>
            </div>
            <div>
              <span className="block text-slate-500">মাসিক বিল</span>
              <span className="font-semibold text-slate-900 tabular-nums">
                {formatBnCurrency(customer.MonthlyBill)}
              </span>
            </div>
            <div>
              <span className="block text-slate-500">মোট বকেয়া</span>
              <span
                className={`font-bold tabular-nums ${
                  totalDue > 0 ? 'text-red-600' : 'text-emerald-600'
                }`}
              >
                {formatBnCurrency(totalDue)}
              </span>
            </div>
          </div>

          {/* Latest Payment Info */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-semibold text-slate-800">সর্বশেষ পেমেন্টের তথ্য</p>
            {lastPayment ? (
              <div className="mt-1 grid grid-cols-2 gap-1.5 text-slate-600">
                <span>তারিখ: {toBnDigits(lastPayment.Date)}</span>
                <span>
                  পরিমাণ: <strong className="text-slate-900">{formatBnCurrency(lastPayment.Amount)}</strong>
                </span>
                <span>মাধ্যম: {paymentMethodLabel(lastPayment.PaymentMethod)}</span>
                <span>
                  রিসিট: <strong className="font-mono-num text-slate-900">{lastPayment.ReceiptID}</strong>
                </span>
              </div>
            ) : (
              <p className="mt-1 text-slate-500">এখনো কোনো বিল পরিশোধের রেকর্ড নেই।</p>
            )}
          </div>

          {savedReceipt ? (
            <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div>
                <p className="text-sm font-bold text-emerald-900">
                  বিল সফলভাবে আদায় হয়েছে! (রিসিট: {savedReceipt.ReceiptID})
                </p>
                <p className="mt-1 text-xs text-emerald-800">
                  মাস: {getMonthLabelBn(savedReceipt.BillingMonth)} · পরিমাণ:{' '}
                  <strong>{formatBnCurrency(savedReceipt.Amount)}</strong> · মাধ্যম:{' '}
                  {paymentMethodLabel(savedReceipt.PaymentMethod)}
                </p>
                {smsStatus && (
                  <p className="mt-1.5 rounded border border-emerald-200 bg-white/80 px-2.5 py-1.5 text-xs text-slate-700">
                    <strong>বাংলা SMS নোটিফিকেশন:</strong>{' '}
                    {smsStatus.Status === 'Sent'
                      ? `সফলভাবে পাঠানো হয়েছে (${toBnDigits(smsStatus.Mobile)})`
                      : smsStatus.Status === 'Simulated'
                        ? `স্যান্ডবক্স লগে সংরক্ষিত হয়েছে (${toBnDigits(smsStatus.Mobile)})`
                        : `পাঠানো ব্যর্থ (${smsStatus.GatewayResponse})`}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onPrint({
                      kind: 'pos-collection',
                      receiptId: savedReceipt.ReceiptID,
                      date: savedReceipt.Date,
                      customerOrCollectorName: savedReceipt.CustomerName,
                      customerId: savedReceipt.CustomerID,
                      mobile: customer.Mobile,
                      area: savedReceipt.Area,
                      packageName: customer.Package,
                      billingMonth: savedReceipt.BillingMonth,
                      amount: savedReceipt.Amount,
                      paymentMethod: savedReceipt.PaymentMethod,
                      trxId: savedReceipt.TrxID,
                      collectedBy: savedReceipt.CollectedBy,
                      note: savedReceipt.Note,
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0f4c5c] px-3 py-2 text-xs font-semibold text-white hover:bg-[#135d66]"
                >
                  <Printer className="h-3.5 w-3.5" />
                  POS প্রিন্ট
                </button>
                <button
                  type="button"
                  disabled={resendingSms}
                  onClick={async () => {
                    setResendingSms(true);
                    try {
                      const out = await api.sendSms({ receiptId: savedReceipt.ReceiptID });
                      setSmsStatus(out.smsLog);
                      await onCollected();
                    } finally {
                      setResendingSms(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                >
                  <MessageSquare className="h-3.5 w-3.5 text-[#0f4c5c]" />
                  {resendingSms ? 'পাঠানো হচ্ছে...' : 'SMS পাঠান'}
                </button>
                <a
                  href={buildReceiptWa(savedReceipt)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  WhatsApp
                </a>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  বন্ধ করুন
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmitCheck} className="space-y-3.5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  বিলের মাস নির্বাচন করুন
                </label>
                <select
                  value={selectedMonth}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedMonth(val);
                    const found = monthOptions.find((m) => m.value === val);
                    if (found && !found.paid) {
                      setAmount(String(found.due || customer.MonthlyBill));
                    }
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                >
                  {monthOptions.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={opt.paid}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">
                    টাকার পরিমাণ (৳)
                  </label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    আংশিক বা অগ্রিম পেমেন্ট গ্রহণযোগ্য
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">
                    পেমেন্ট মাধ্যম
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                  >
                    <option value="Cash">নগদ (Cash)</option>
                    <option value="bKash">বিকাশ (bKash)</option>
                    <option value="Nagad">নগদ (Nagad)</option>
                    <option value="Rocket">রকেট (Rocket)</option>
                    <option value="Bank">ব্যাংক (Bank)</option>
                  </select>
                </div>
              </div>

              {paymentMethod !== 'Cash' && (
                <div className="grid grid-cols-1 gap-3.5 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      TrxID / রেফারেন্স নম্বর *
                    </label>
                    <input
                      type="text"
                      required
                      value={trxId}
                      onChange={(e) => setTrxId(e.target.value)}
                      placeholder="যেমন: BK8A921X"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      প্রেরক নম্বর / ব্যাংক অ্যাকাউন্ট
                    </label>
                    <input
                      type="text"
                      value={senderAccount}
                      onChange={(e) => setSenderAccount(e.target.value)}
                      placeholder="০১..."
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">নোট (ঐচ্ছিক)</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="বিল সংক্রান্ত মন্তব্য"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2 text-sm font-semibold text-white hover:bg-[#135d66]"
                >
                  <Receipt className="h-4 w-4" />
                  বিল জমা নিন
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="বিল আদায় নিশ্চিত করুন"
        description="নিচের তথ্য অনুযায়ী গ্রাহকের বিল রিসিট তৈরি করা হবে।"
        items={[
          { label: 'গ্রাহক', value: `${customer.Name} (${customer.CustomerID})` },
          { label: 'বিলের মাস', value: getMonthLabelBn(selectedMonth) },
          { label: 'টাকার পরিমাণ', value: formatBnCurrency(Number(amount)) },
          { label: 'পেমেন্ট মাধ্যম', value: paymentMethodLabel(paymentMethod) },
          ...(trxId ? [{ label: 'TrxID', value: trxId }] : []),
        ]}
        confirmLabel="রিসিট নিশ্চিত করুন"
        loading={submitting}
        onConfirm={handleCommitCollect}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};

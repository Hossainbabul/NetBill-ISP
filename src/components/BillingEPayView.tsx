import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  CreditCard,
  MessageCircle,
  MessageSquare,
  Printer,
  Receipt,
  Search,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import {
  Collection,
  Customer,
  DashboardPayload,
  EPaymentRequest,
  EPaymentStatus,
  SessionUser,
  SmsLog,
} from '../types';
import {
  buildWhatsAppUrl,
  formatBnCurrency,
  getCurrentMonthStr,
  getMonthLabelBn,
  getTodayStr,
  paymentMethodBadgeClass,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';
import { AdminPasswordModal, ConfirmDialog } from './ConfirmDialog';
import { PrintPayload } from './PrintPreviewModal';

interface BillingEPayViewProps {
  data: DashboardPayload;
  user: SessionUser;
  initialSubTab?: 'collections' | 'generate' | 'epay';
  onRefresh: () => Promise<void>;
  onCollect: (customer: Customer) => void;
  onPrint: (payload: PrintPayload) => void;
}

export const BillingEPayView: React.FC<BillingEPayViewProps> = ({
  data,
  user,
  initialSubTab = 'collections',
  onRefresh,
  onCollect,
  onPrint,
}) => {
  const isAdmin = user.role === 'Admin';
  const [subTab, setSubTab] = useState<'collections' | 'generate' | 'epay'>(initialSubTab);

  // Collections filter
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('ALL');

  // Generate bills state
  const [genMonth, setGenMonth] = useState(getCurrentMonthStr());
  const [genMode, setGenMode] = useState<'allActive' | 'dueOnly'>('allActive');
  const [confirmGenOpen, setConfirmGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genResultMsg, setGenResultMsg] = useState('');

  // E-Payment verification state
  const [epayFilter, setEpayFilter] = useState<'ALL' | EPaymentStatus>('Pending');
  const [approveTarget, setApproveTarget] = useState<EPaymentRequest | null>(null);
  const [approving, setApproving] = useState(false);
  const [lastApprovedReceipt, setLastApprovedReceipt] = useState<{
    receipt: Collection;
    mobile: string;
    smsLog?: SmsLog | null;
  } | null>(null);
  const [smsNotice, setSmsNotice] = useState('');

  const [rejectTarget, setRejectTarget] = useState<EPaymentRequest | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Delete state (Receipt or EPayment)
  const [deleteReceipt, setDeleteReceipt] = useState<Collection | null>(null);
  const [deleteEPay, setDeleteEPay] = useState<EPaymentRequest | null>(null);
  const [deleteErr, setDeleteErr] = useState('');
  const [deleting, setDeleting] = useState(false);

  const custMap = useMemo(() => {
    const map = new Map<string, Customer>();
    data.customers.forEach((c) => map.set(c.CustomerID, c));
    return map;
  }, [data.customers]);

  const dueCustomers = useMemo(() => {
    const dueByCust = new Map<string, number>();
    for (const b of data.bills) {
      if (b.DueAmount > 0) {
        dueByCust.set(b.CustomerID, (dueByCust.get(b.CustomerID) || 0) + b.DueAmount);
      }
    }
    return data.customers
      .map((c) => ({ customer: c, due: dueByCust.get(c.CustomerID) || 0 }))
      .filter((x) => x.due > 0)
      .sort((a, b) => b.due - a.due);
  }, [data.customers, data.bills]);

  const filteredCollections = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.collections.filter((c) => {
      if (methodFilter !== 'ALL' && c.PaymentMethod !== methodFilter) return false;
      if (q) {
        const hay = `${c.ReceiptID} ${c.CustomerID} ${c.CustomerName} ${c.TrxID} ${c.Area}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data.collections, search, methodFilter]);

  const genPreview = useMemo(() => {
    const today = getTodayStr();
    let eligible = 0;
    let alreadyBilled = 0;
    let inactive = 0;
    for (const c of data.customers) {
      if (c.Status !== 'এক্টিভ') {
        inactive++;
        continue;
      }
      if (genMode === 'dueOnly' && c.NextBillDate > today) {
        continue;
      }
      const exists = data.bills.some(
        (b) => b.CustomerID === c.CustomerID && b.BillingMonth === genMonth
      );
      if (exists) {
        alreadyBilled++;
      } else {
        eligible++;
      }
    }
    return { eligible, alreadyBilled, inactive };
  }, [data.customers, data.bills, genMonth, genMode]);

  const filteredEPayments = useMemo(() => {
    return data.ePayments.filter((e) => (epayFilter === 'ALL' ? true : e.Status === epayFilter));
  }, [data.ePayments, epayFilter]);

  const pendingCount = useMemo(
    () => data.ePayments.filter((e) => e.Status === 'Pending').length,
    [data.ePayments]
  );

  const handleGenerateBills = async () => {
    setGenerating(true);
    setGenResultMsg('');
    try {
      const res = await api.generateBills(genMonth, genMode);
      setConfirmGenOpen(false);
      setGenResultMsg(
        `${getMonthLabelBn(res.billingMonth)} মাসের জন্য নতুন ${toBnDigits(
          res.createdCount
        )}টি বিল জেনারেট হয়েছে (পূর্বের/নিষ্ক্রিয় বাদ: ${toBnDigits(res.skippedCount)}টি)।`
      );
      await onRefresh();
    } catch (err) {
      setConfirmGenOpen(false);
      setGenResultMsg((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handleApproveEPayment = async () => {
    if (!approveTarget) return;
    setApproving(true);
    try {
      const res = await api.approveEPayment(approveTarget.RequestID);
      const mobile = approveTarget.Mobile || custMap.get(approveTarget.CustomerID)?.Mobile || '';
      setLastApprovedReceipt({ receipt: res.receipt, mobile, smsLog: res.smsLog });
      setApproveTarget(null);
      await onRefresh();
    } catch (err) {
      setApproveTarget(null);
      setGenResultMsg((err as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const handleRejectEPayment = async () => {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      await api.rejectEPayment(rejectTarget.RequestID, rejectNote || 'যাচাইয়ে তথ্য মেলেনি');
      setRejectTarget(null);
      setRejectNote('');
      await onRefresh();
    } finally {
      setRejecting(false);
    }
  };

  const handleConfirmDelete = async (adminPassword: string) => {
    setDeleting(true);
    setDeleteErr('');
    try {
      if (deleteReceipt) {
        await api.deleteCollection(deleteReceipt.ReceiptID, adminPassword);
        setDeleteReceipt(null);
      } else if (deleteEPay) {
        await api.deleteEPayment(deleteEPay.RequestID, adminPassword);
        setDeleteEPay(null);
      }
      await onRefresh();
    } catch (err) {
      setDeleteErr((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const buildWaReceiptLink = (rec: Collection, mobile: string) => {
    const text = `সম্মানিত ${rec.CustomerName} (${rec.CustomerID}), আপনার ${getMonthLabelBn(
      rec.BillingMonth
    )} মাসের ${formatBnCurrency(rec.Amount)} বিল (${paymentMethodLabel(rec.PaymentMethod)}${
      rec.TrxID ? `, TrxID: ${rec.TrxID}` : ''
    }) সফলভাবে গৃহীত হয়েছে। রিসিট নং: ${rec.ReceiptID}। ধন্যবাদ - ${data.settings.CompanyName}`;
    return buildWhatsAppUrl(mobile, text);
  };

  return (
    <div className="space-y-5">
      {/* Sub-Navigation Bar */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">বিলিং, আদায় ও ই-পেমেন্ট</h2>
            <p className="text-xs text-slate-500">
              মাসিক বিল জেনারেট, রিসিট ব্যবস্থাপনা এবং বিকাশ/নগদ/রকেট/ব্যাংক ই-পেমেন্ট যাচাই
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setSubTab('collections')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                subTab === 'collections'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              বিল আদায় ও রিসিট
            </button>
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setSubTab('generate')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    subTab === 'generate'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  মাসিক বিল জেনারেট
                </button>
                <button
                  type="button"
                  onClick={() => setSubTab('epay')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    subTab === 'epay'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ই-পেমেন্ট যাচাই ({toBnDigits(pendingCount)})
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      {lastApprovedReceipt && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3.5 text-sm text-emerald-900">
          <div>
            <p className="font-bold">
              ই-পেমেন্ট অনুমোদিত! রিসিট নং: {lastApprovedReceipt.receipt.ReceiptID}
            </p>
            <p className="text-xs text-emerald-800">
              {lastApprovedReceipt.receipt.CustomerName} ·{' '}
              {formatBnCurrency(lastApprovedReceipt.receipt.Amount)} ·{' '}
              {paymentMethodLabel(lastApprovedReceipt.receipt.PaymentMethod)}
              {lastApprovedReceipt.smsLog && (
                <>
                  {' '}
                  · বাংলা SMS:{' '}
                  <strong>
                    {lastApprovedReceipt.smsLog.Status === 'Sent'
                      ? 'প্রেরিত'
                      : lastApprovedReceipt.smsLog.Status === 'Simulated'
                        ? 'স্যান্ডবক্স লগ'
                        : 'ব্যর্থ'}
                  </strong>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={buildWaReceiptLink(lastApprovedReceipt.receipt, lastApprovedReceipt.mobile)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp এ কনফার্মেশন পাঠান
            </a>
            <button
              type="button"
              onClick={() => setLastApprovedReceipt(null)}
              className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-800"
            >
              বন্ধ করুন
            </button>
          </div>
        </div>
      )}

      {smsNotice && (
        <div className="flex items-center justify-between rounded-xl border border-teal-200 bg-teal-50 px-4 py-2.5 text-xs font-medium text-[#0f4c5c]">
          <span>{smsNotice}</span>
          <button
            type="button"
            onClick={() => setSmsNotice('')}
            className="text-slate-500 hover:text-slate-900"
          >
            বন্ধ
          </button>
        </div>
      )}

      {/* SUB-TAB 1: Collections & Due Customers */}
      {subTab === 'collections' && (
        <div className="space-y-5">
          {/* Quick Due List */}
          {dueCustomers.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-bold text-slate-900">
                বকেয়া গ্রাহকদের দ্রুত বিল গ্রহণ ({toBnDigits(dueCustomers.length)} জন)
              </h3>
              <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {dueCustomers.slice(0, 6).map(({ customer, due }) => (
                  <div
                    key={customer.CustomerID}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{customer.Name}</p>
                      <p className="truncate text-slate-500">
                        <span className="font-mono-num">{customer.CustomerID}</span> · {customer.Area}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono-num font-bold text-red-600">
                        {formatBnCurrency(due)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onCollect(customer)}
                        className="rounded-md bg-[#0f4c5c] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#135d66]"
                      >
                        বিল নিন
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Receipts Table */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <h3 className="text-base font-bold text-slate-900">আদায়কৃত বিলের রিসিটসমূহ</h3>
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="রিসিট / আইডি / TrxID"
                    className="rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-xs focus:border-[#0f4c5c] focus:outline-none"
                  />
                </div>
                <select
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs focus:border-[#0f4c5c] focus:outline-none"
                >
                  <option value="ALL">সব মাধ্যম</option>
                  <option value="Cash">নগদ (Cash)</option>
                  <option value="bKash">বিকাশ (bKash)</option>
                  <option value="Nagad">নগদ (Nagad)</option>
                  <option value="Rocket">রকেট (Rocket)</option>
                  <option value="Bank">ব্যাংক (Bank)</option>
                </select>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="px-3 py-2.5 text-left font-semibold">রিসিট ও তারিখ</th>
                    <th className="px-3 py-2.5 text-left font-semibold">গ্রাহক</th>
                    <th className="px-3 py-2.5 text-left font-semibold">বিলের মাস</th>
                    <th className="px-3 py-2.5 text-left font-semibold">মাধ্যম ও TrxID</th>
                    <th className="px-3 py-2.5 text-left font-semibold">আদায়কারী</th>
                    <th className="px-3 py-2.5 text-right font-semibold">পরিমাণ</th>
                    <th className="px-3 py-2.5 text-right font-semibold">অ্যাকশন</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {filteredCollections.map((col) => {
                    const cust = custMap.get(col.CustomerID);
                    return (
                      <tr key={col.ReceiptID} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5">
                          <span className="font-mono-num font-semibold text-slate-900">
                            {col.ReceiptID}
                          </span>
                          <span className="block text-[11px] text-slate-500">
                            {toBnDigits(col.Date)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-semibold text-slate-900">{col.CustomerName}</span>
                          <span className="block text-[11px] text-slate-500">
                            <span className="font-mono-num">{col.CustomerID}</span> · {col.Area}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-800">
                          {getMonthLabelBn(col.BillingMonth)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${paymentMethodBadgeClass(
                              col.PaymentMethod
                            )}`}
                          >
                            {paymentMethodLabel(col.PaymentMethod)}
                          </span>
                          {col.TrxID && (
                            <span className="mt-0.5 block font-mono-num text-[11px] text-slate-500">
                              TrxID: {col.TrxID}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">{col.CollectedBy}</td>
                        <td className="px-3 py-2.5 text-right font-mono-num font-bold text-slate-900">
                          {formatBnCurrency(col.Amount)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                onPrint({
                                  kind: 'pos-collection',
                                  receiptId: col.ReceiptID,
                                  date: col.Date,
                                  customerOrCollectorName: col.CustomerName,
                                  customerId: col.CustomerID,
                                  mobile: cust?.Mobile,
                                  area: col.Area,
                                  packageName: cust?.Package,
                                  billingMonth: col.BillingMonth,
                                  amount: col.Amount,
                                  paymentMethod: col.PaymentMethod,
                                  trxId: col.TrxID,
                                  collectedBy: col.CollectedBy,
                                  note: col.Note,
                                })
                              }
                              title="POS রিসিট প্রিন্ট"
                              className="rounded border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-100"
                            >
                              <Printer className="h-3.5 w-3.5" />
                            </button>

                            {cust && (
                              <>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      const out = await api.sendSms({ receiptId: col.ReceiptID });
                                      setSmsNotice(
                                        `${col.CustomerName} (${toBnDigits(cust.Mobile)}) নম্বরে বাংলা SMS ${
                                          out.smsLog.Status === 'Sent'
                                            ? 'পাঠানো হয়েছে'
                                            : out.smsLog.Status === 'Simulated'
                                              ? 'স্যান্ডবক্স লগে সংরক্ষিত হয়েছে'
                                              : 'পাঠানো ব্যর্থ'
                                        }।`
                                      );
                                      await onRefresh();
                                    } catch (err) {
                                      setSmsNotice((err as Error).message);
                                    }
                                  }}
                                  title="বাংলা SMS রিসিট পাঠান"
                                  className="rounded border border-teal-200 bg-teal-50 p-1.5 text-[#0f4c5c] hover:bg-teal-100"
                                >
                                  <MessageSquare className="h-3.5 w-3.5" />
                                </button>
                                <a
                                  href={buildWaReceiptLink(col, cust.Mobile)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="WhatsApp রিসিট"
                                  className="rounded border border-emerald-200 bg-emerald-50 p-1.5 text-emerald-700 hover:bg-emerald-100"
                                >
                                  <MessageCircle className="h-3.5 w-3.5" />
                                </a>
                              </>
                            )}

                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDeleteErr('');
                                  setDeleteReceipt(col);
                                }}
                                title="রিসিট ডিলিট (বকেয়ায় ফেরত যাবে)"
                                className="rounded border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* SUB-TAB 2: Auto Monthly Bill Generator */}
      {subTab === 'generate' && isAdmin && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
          <div>
            <h3 className="text-base font-bold text-slate-900">স্বয়ংক্রিয় মাসিক বিল জেনারেট ইঞ্জিন</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              এক্টিভ গ্রাহকদের জন্য মাসিক বিল তৈরি করুন। ডি-এক্টিভ গ্রাহক এবং ইতিমধ্যেই জেনারেট হওয়া বিল স্বয়ংক্রিয়ভাবে বাদ থাকবে।
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                বিলিং মাস নির্বাচন করুন
              </label>
              <input
                type="month"
                value={genMonth}
                onChange={(e) => setGenMonth(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono-num text-sm"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-700">জেনারেশন নিয়ম</label>
              <select
                value={genMode}
                onChange={(e) => setGenMode(e.target.value as 'allActive' | 'dueOnly')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm"
              >
                <option value="allActive">সকল এক্টিভ গ্রাহক ({getMonthLabelBn(genMonth)})</option>
                <option value="dueOnly">শুধু যাদের NextBillDate আজ বা তার আগে</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">নতুন বিল তৈরি হবে</p>
              <p className="mt-1 font-mono-num text-2xl font-bold text-[#0f4c5c]">
                {toBnDigits(genPreview.eligible)} জন
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">ইতিমধ্যেই বিল তৈরি আছে (বাদ)</p>
              <p className="mt-1 font-mono-num text-2xl font-bold text-slate-700">
                {toBnDigits(genPreview.alreadyBilled)} জন
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">ডি-এক্টিভ গ্রাহক (বাদ)</p>
              <p className="mt-1 font-mono-num text-2xl font-bold text-red-600">
                {toBnDigits(genPreview.inactive)} জন
              </p>
            </div>
          </div>

          {genResultMsg && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
              {genResultMsg}
            </p>
          )}

          <button
            type="button"
            disabled={genPreview.eligible === 0}
            onClick={() => setConfirmGenOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] disabled:opacity-50"
          >
            <Zap className="h-4 w-4" />
            এক্টিভ গ্রাহকের বিল জেনারেট করুন
          </button>
        </section>
      )}

      {/* SUB-TAB 3: E-Payment Verification Queue */}
      {subTab === 'epay' && isAdmin && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                ই-পেমেন্ট যাচাই তালিকা (bKash, Nagad, Rocket, Bank)
              </h3>
              <p className="text-xs text-slate-500">
                গ্রাহকের পাঠানো TrxID যাচাই করে অনুমোদন করলে স্বয়ংক্রিয় রিসিট তৈরি হবে এবং ডিজিটাল ফান্ডে যোগ হবে
              </p>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(['Pending', 'Approved', 'Rejected', 'ALL'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setEpayFilter(st)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                    epayFilter === st
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'Pending' && 'অপেক্ষমাণ'}
                  {st === 'Approved' && 'অনুমোদিত'}
                  {st === 'Rejected' && 'বাতিল'}
                  {st === 'ALL' && 'সব'}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="px-3 py-2.5 text-left font-semibold">রিকোয়েস্ট ও সময়</th>
                  <th className="px-3 py-2.5 text-left font-semibold">গ্রাহক</th>
                  <th className="px-3 py-2.5 text-left font-semibold">বিলের মাস</th>
                  <th className="px-3 py-2.5 text-left font-semibold">মাধ্যম / প্রেরক / TrxID</th>
                  <th className="px-3 py-2.5 text-right font-semibold">টাকা</th>
                  <th className="px-3 py-2.5 text-center font-semibold">অবস্থা</th>
                  <th className="px-3 py-2.5 text-right font-semibold">অ্যাকশন</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {filteredEPayments.map((ep) => (
                  <tr key={ep.RequestID} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5">
                      <span className="font-mono-num font-semibold text-slate-900">
                        {ep.RequestID}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {toBnDigits(ep.SubmittedAt.slice(0, 10))}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-slate-900">{ep.CustomerName}</span>
                      <span className="block font-mono-num text-[11px] text-slate-500">
                        {ep.CustomerID} · {toBnDigits(ep.Mobile)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{getMonthLabelBn(ep.BillingMonth)}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${paymentMethodBadgeClass(
                          ep.PaymentMethod
                        )}`}
                      >
                        {paymentMethodLabel(ep.PaymentMethod)}
                      </span>
                      <span className="mt-1 block font-mono-num text-[11px] text-slate-700">
                        TrxID: <strong>{ep.TrxID}</strong> · প্রেরক: {ep.SenderNumberOrAccount}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono-num font-bold text-slate-900">
                      {formatBnCurrency(ep.Amount)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${
                          ep.Status === 'Approved'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : ep.Status === 'Rejected'
                              ? 'border-red-200 bg-red-50 text-red-700'
                              : 'border-amber-200 bg-amber-50 text-amber-700'
                        }`}
                      >
                        {ep.Status === 'Approved'
                          ? 'অনুমোদিত'
                          : ep.Status === 'Rejected'
                            ? 'বাতিল'
                            : 'অপেক্ষমাণ'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {ep.Status === 'Pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => setApproveTarget(ep)}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              অনুমোদন করুন
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRejectNote('');
                                setRejectTarget(ep);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              বাতিল
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteErr('');
                            setDeleteEPay(ep);
                          }}
                          title="ডিলিট"
                          className="rounded border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredEPayments.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-slate-500">
                      এই তালিকায় কোনো ই-পেমেন্ট অনুরোধ নেই।
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Confirmation Modals */}
      <ConfirmDialog
        open={confirmGenOpen}
        title="মাসিক বিল জেনারেট নিশ্চিত করুন"
        description="নিচের তথ্য অনুযায়ী এক্টিভ গ্রাহকদের মাসিক বিল তৈরি করা হবে।"
        items={[
          { label: 'বিলের মাস', value: getMonthLabelBn(genMonth) },
          { label: 'নতুন বিল তৈরি হবে', value: `${toBnDigits(genPreview.eligible)} জন` },
          { label: 'বাদ যাবে (পূর্বের/নিষ্ক্রিয়)', value: `${toBnDigits(genPreview.alreadyBilled + genPreview.inactive)} জন` },
        ]}
        confirmLabel="বিল জেনারেট করুন"
        loading={generating}
        onConfirm={handleGenerateBills}
        onCancel={() => setConfirmGenOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(approveTarget)}
        title="ই-পেমেন্ট অনুমোদন নিশ্চিত করুন"
        description="অনুমোদন করলে গ্রাহকের বিল পরিশোধিত হবে এবং ডিজিটাল অ্যাকাউন্ট ব্যালেন্স বৃদ্ধি পাবে।"
        items={
          approveTarget
            ? [
                { label: 'গ্রাহক', value: `${approveTarget.CustomerName} (${approveTarget.CustomerID})` },
                { label: 'বিলের মাস', value: getMonthLabelBn(approveTarget.BillingMonth) },
                { label: 'মাধ্যম', value: paymentMethodLabel(approveTarget.PaymentMethod) },
                { label: 'TrxID', value: approveTarget.TrxID },
                { label: 'পরিমাণ', value: formatBnCurrency(approveTarget.Amount) },
              ]
            : []
        }
        confirmLabel="অনুমোদন করুন"
        loading={approving}
        onConfirm={handleApproveEPayment}
        onCancel={() => setApproveTarget(null)}
      />

      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-lg space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              ই-পেমেন্ট বাতিল করুন ({rejectTarget.RequestID})
            </h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                বাতিলের কারণ (ঐচ্ছিক)
              </label>
              <input
                type="text"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="যেমন: TrxID পাওয়া যায়নি বা টাকার পরিমাণ কম"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium"
              >
                ফিরে যান
              </button>
              <button
                type="button"
                disabled={rejecting}
                onClick={handleRejectEPayment}
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
              >
                {rejecting ? 'বাতিল হচ্ছে...' : 'বাতিল নিশ্চিত করুন'}
              </button>
            </div>
          </div>
        </div>
      )}

      <AdminPasswordModal
        open={Boolean(deleteReceipt || deleteEPay)}
        title={
          deleteReceipt
            ? `রিসিট ডিলিট: ${deleteReceipt.ReceiptID} (${formatBnCurrency(deleteReceipt.Amount)})`
            : `ই-পেমেন্ট অনুরোধ ডিলিট: ${deleteEPay?.RequestID || ''}`
        }
        description={
          deleteReceipt
            ? 'রিসিট ডিলিট করলে আদায়কৃত টাকা স্বয়ংক্রিয়ভাবে গ্রাহকের বকেয়া হিসাবে ফেরত যাবে।'
            : 'এই ই-পেমেন্ট অনুরোধটি স্থায়ীভাবে মুছে ফেলা হবে।'
        }
        error={deleteErr}
        loading={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setDeleteReceipt(null);
          setDeleteEPay(null);
        }}
      />
    </div>
  );
};

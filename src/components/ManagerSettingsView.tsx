import React, { useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Eye,
  FileBarChart2,
  MessageCircle,
  MessageSquare,
  Plus,
  Printer,
  Save,
  Send,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import {
  DashboardPayload,
  DueReminderConfig,
  DueReminderResult,
  Expense,
  ExpenseCategory,
  PaymentMethod,
  SettingsData,
  SmsProvider,
} from '../types';
import {
  DEFAULT_DUE_REMINDER_TEMPLATE,
  DEFAULT_LINK_REMINDER_CONFIG,
  EXPENSE_CATEGORIES,
  buildWhatsAppUrl,
  formatBnCurrency,
  formatDueReminderMessage,
  getCurrentMonthStr,
  getMonthLabelBn,
  getTodayStr,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';
import { AdminPasswordModal, ConfirmDialog } from './ConfirmDialog';
import { PrintPayload } from './PrintPreviewModal';

interface ManagerViewProps {
  data: DashboardPayload;
  onRefresh: () => Promise<void>;
  onPrint: (payload: PrintPayload) => void;
}

export const ManagerView: React.FC<ManagerViewProps> = ({ data, onRefresh, onPrint }) => {
  const [tab, setTab] = useState<'cashflow' | 'expenses' | 'reports' | 'broadcast' | 'smslogs'>(
    'cashflow'
  );

  // Cashflow Filters
  const [cfFrom, setCfFrom] = useState('');
  const [cfTo, setCfTo] = useState('');
  const [cfAccount, setCfAccount] = useState<'ALL' | PaymentMethod>('ALL');

  // New Expense State
  const [expDate, setExpDate] = useState(getTodayStr());
  const [expCategory, setExpCategory] = useState<ExpenseCategory>('বেতন');
  const [expAccount, setExpAccount] = useState<PaymentMethod>('Cash');
  const [expAmount, setExpAmount] = useState('');
  const [expNote, setExpNote] = useState('');
  const [confirmExpOpen, setConfirmExpOpen] = useState(false);
  const [savingExp, setSavingExp] = useState(false);

  // Delete Expense
  const [deleteExp, setDeleteExp] = useState<Expense | null>(null);
  const [deleteErr, setDeleteErr] = useState('');
  const [deletingExp, setDeletingExp] = useState(false);

  // Reports Filters
  const [repType, setRepType] = useState<'customers' | 'monthly' | 'collections'>('customers');
  const [repArea, setRepArea] = useState('ALL');
  const [repStatus, setRepStatus] = useState('ALL');
  const [repMonth, setRepMonth] = useState(getCurrentMonthStr());
  const [repFrom, setRepFrom] = useState('');
  const [repTo, setRepTo] = useState('');
  const [repMethod, setRepMethod] = useState<'ALL' | PaymentMethod>('ALL');

  // Broadcast State
  const [bcArea, setBcArea] = useState('ALL');
  const [bcFilter, setBcFilter] = useState<'ALL' | 'DUE_ONLY'>('DUE_ONLY');
  const [bcTemplate, setBcTemplate] = useState(DEFAULT_DUE_REMINDER_TEMPLATE);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sendingBulkSms, setSendingBulkSms] = useState(false);
  const [bulkSmsMsg, setBulkSmsMsg] = useState('');

  const dueMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of data.bills) {
      if (b.DueAmount > 0) {
        map.set(b.CustomerID, (map.get(b.CustomerID) || 0) + b.DueAmount);
      }
    }
    return map;
  }, [data.bills]);

  // Unified Cashflow Entries
  const cashflowRows = useMemo(() => {
    const rows: {
      id: string;
      date: string;
      type: 'জমা' | 'খরচ';
      account: PaymentMethod;
      particulars: string;
      amount: number;
    }[] = [];

    for (const col of data.collections) {
      if (col.PaymentMethod === 'Cash' && col.CollectorRole !== 'Admin') {
        // Collector cash enters office fund only when deposited
        continue;
      }
      rows.push({
        id: col.ReceiptID,
        date: col.Date,
        type: 'জমা',
        account: col.PaymentMethod,
        particulars: `${col.CustomerName} (${col.CustomerID}) — ${getMonthLabelBn(col.BillingMonth)}`,
        amount: col.Amount,
      });
    }

    for (const dep of data.deposits) {
      rows.push({
        id: dep.DepositID,
        date: dep.Date,
        type: 'জমা',
        account: dep.DepositMethod,
        particulars: `কালেক্টর জমা: ${dep.CollectorName}`,
        amount: dep.Amount,
      });
    }

    for (const exp of data.expenses) {
      rows.push({
        id: exp.ExpenseID,
        date: exp.Date,
        type: 'খরচ',
        account: exp.PaymentAccount,
        particulars: `${exp.Category}${exp.Note ? ` — ${exp.Note}` : ''}`,
        amount: exp.Amount,
      });
    }

    return rows
      .filter((r) => {
        if (cfFrom && r.date < cfFrom) return false;
        if (cfTo && r.date > cfTo) return false;
        if (cfAccount !== 'ALL' && r.account !== cfAccount) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data.collections, data.deposits, data.expenses, cfFrom, cfTo, cfAccount]);

  const handleSaveExpense = async () => {
    setSavingExp(true);
    try {
      await api.createExpense({
        Date: expDate,
        Category: expCategory,
        PaymentAccount: expAccount,
        Amount: Number(expAmount),
        Note: expNote,
      });
      setConfirmExpOpen(false);
      setExpAmount('');
      setExpNote('');
      await onRefresh();
    } finally {
      setSavingExp(false);
    }
  };

  const handleDeleteExpense = async (pwd: string) => {
    if (!deleteExp) return;
    setDeletingExp(true);
    setDeleteErr('');
    try {
      await api.deleteExpense(deleteExp.ExpenseID, pwd);
      setDeleteExp(null);
      await onRefresh();
    } catch (err) {
      setDeleteErr((err as Error).message);
    } finally {
      setDeletingExp(false);
    }
  };

  // Expense Category Summary
  const expenseByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of data.expenses) {
      map.set(e.Category, (map.get(e.Category) || 0) + e.Amount);
    }
    return Array.from(map.entries()).map(([category, total]) => ({ category, total }));
  }, [data.expenses]);

  // Broadcast target customers
  const broadcastTargets = useMemo(() => {
    return data.customers.filter((c) => {
      if (bcArea !== 'ALL' && c.Area !== bcArea) return false;
      if (bcFilter === 'DUE_ONLY' && (dueMap.get(c.CustomerID) || 0) <= 0) return false;
      return true;
    });
  }, [data.customers, bcArea, bcFilter, dueMap]);

  const formatBroadcastMsg = (c: (typeof data.customers)[0], keepPayLinkPlaceholder = false) => {
    const due = dueMap.get(c.CustomerID) || 0;
    return formatDueReminderMessage({
      template: bcTemplate,
      name: c.Name,
      customerId: c.CustomerID,
      lastDate: c.NextBillDate || getTodayStr(),
      due,
      companyName: data.settings.CompanyName,
      keepPayLinkPlaceholder,
    });
  };

  // Print Reports Builder
  const triggerReportPrint = () => {
    if (repType === 'customers') {
      const rows = data.customers
        .filter((c) => {
          if (repArea !== 'ALL' && c.Area !== repArea) return false;
          if (repStatus !== 'ALL' && c.Status !== repStatus) return false;
          return true;
        })
        .map((c) => ({
          id: c.CustomerID,
          name: c.Name,
          mobile: toBnDigits(c.Mobile),
          area: c.Area,
          pkg: c.Package,
          bill: formatBnCurrency(c.MonthlyBill),
          due: formatBnCurrency(dueMap.get(c.CustomerID) || 0),
          status: c.Status,
        }));
      onPrint({
        kind: 'a4-report',
        title: 'গ্রাহক তালিকা রিপোর্ট',
        subtitle: `এরিয়া: ${repArea === 'ALL' ? 'সব' : repArea} · স্ট্যাটাস: ${
          repStatus === 'ALL' ? 'সব' : repStatus
        }`,
        summaryRows: [{ label: 'মোট গ্রাহক', value: `${toBnDigits(rows.length)} জন` }],
        columns: [
          { key: 'id', label: 'আইডি' },
          { key: 'name', label: 'নাম' },
          { key: 'mobile', label: 'মোবাইল' },
          { key: 'area', label: 'এরিয়া' },
          { key: 'pkg', label: 'প্যাকেজ' },
          { key: 'bill', label: 'মাসিক বিল', align: 'right' },
          { key: 'due', label: 'বকেয়া', align: 'right' },
          { key: 'status', label: 'অবস্থা' },
        ],
        rows,
      });
    } else if (repType === 'monthly') {
      const rows = data.areas.map((a) => {
        const custIds = new Set(
          data.customers.filter((c) => c.Area === a.AreaName).map((c) => c.CustomerID)
        );
        const areaBills = data.bills.filter(
          (b) => custIds.has(b.CustomerID) && b.BillingMonth === repMonth
        );
        const billed = areaBills.reduce((s, b) => s + b.Amount, 0);
        const paid = areaBills.reduce((s, b) => s + b.PaidAmount, 0);
        const due = areaBills.reduce((s, b) => s + b.DueAmount, 0);
        return {
          area: a.AreaName,
          count: toBnDigits(custIds.size),
          billed: formatBnCurrency(billed),
          paid: formatBnCurrency(paid),
          due: formatBnCurrency(due),
        };
      });
      onPrint({
        kind: 'a4-report',
        title: `মাসিক বিল ও কালেকশন রিপোর্ট — ${getMonthLabelBn(repMonth)}`,
        columns: [
          { key: 'area', label: 'এরিয়া' },
          { key: 'count', label: 'গ্রাহক', align: 'right' },
          { key: 'billed', label: 'মোট বিল', align: 'right' },
          { key: 'paid', label: 'আদায়', align: 'right' },
          { key: 'due', label: 'বকেয়া', align: 'right' },
        ],
        rows,
      });
    } else {
      const cols = data.collections.filter((c) => {
        if (repFrom && c.Date < repFrom) return false;
        if (repTo && c.Date > repTo) return false;
        if (repMethod !== 'ALL' && c.PaymentMethod !== repMethod) return false;
        return true;
      });
      const total = cols.reduce((s, c) => s + c.Amount, 0);
      onPrint({
        kind: 'a4-report',
        title: 'বিল আদায় রিপোর্ট',
        subtitle: `মাধ্যম: ${repMethod === 'ALL' ? 'সব' : paymentMethodLabel(repMethod)}`,
        summaryRows: [
          { label: 'মোট রিসিট', value: `${toBnDigits(cols.length)}টি` },
          { label: 'সর্বমোট আদায়', value: formatBnCurrency(total) },
        ],
        columns: [
          { key: 'date', label: 'তারিখ' },
          { key: 'receipt', label: 'রিসিট' },
          { key: 'customer', label: 'গ্রাহক' },
          { key: 'month', label: 'মাস' },
          { key: 'method', label: 'মাধ্যম ও TrxID' },
          { key: 'amount', label: 'পরিমাণ', align: 'right' },
        ],
        rows: cols.map((c) => ({
          date: toBnDigits(c.Date),
          receipt: c.ReceiptID,
          customer: `${c.CustomerName} (${c.CustomerID})`,
          month: getMonthLabelBn(c.BillingMonth),
          method: `${paymentMethodLabel(c.PaymentMethod)}${c.TrxID ? ` (${c.TrxID})` : ''}`,
          amount: formatBnCurrency(c.Amount),
        })),
      });
    }
  };

  const b = data.accountBalances;

  return (
    <div className="space-y-5">
      {/* Multi-Account Fund Balances */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-slate-900">ম্যানেজার — ফান্ড, খরচ ও রিপোর্ট</h2>
            <p className="text-xs text-slate-500">
              মোট জমা {formatBnCurrency(b.totalIncome)} − মোট খরচ {formatBnCurrency(b.totalExpense)} = বর্তমান ব্যালেন্স{' '}
              <strong className="text-emerald-700">{formatBnCurrency(b.netBalance)}</strong>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ['cashflow', 'জমা খরচ'],
                ['expenses', 'খরচ'],
                ['reports', 'রিপোর্টসমূহ'],
                ['broadcast', 'ব্রডকাস্ট (SMS/WA)'],
                ['smslogs', `SMS লগ (${toBnDigits(data.smsLogs.length)})`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  tab === k
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 text-xs tabular-nums">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-slate-500">নগদ ক্যাশ (Cash)</span>
            <p className="mt-1 font-mono-num text-base font-bold text-emerald-700">
              {formatBnCurrency(b.Cash)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-slate-500">বিকাশ (bKash)</span>
            <p className="mt-1 font-mono-num text-base font-bold text-[#E2136E]">
              {formatBnCurrency(b.bKash)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-slate-500">নগদ (Nagad)</span>
            <p className="mt-1 font-mono-num text-base font-bold text-[#C26A00]">
              {formatBnCurrency(b.Nagad)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-slate-500">রকেট (Rocket)</span>
            <p className="mt-1 font-mono-num text-base font-bold text-[#8C3494]">
              {formatBnCurrency(b.Rocket)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-slate-500">ব্যাংক (Bank)</span>
            <p className="mt-1 font-mono-num text-base font-bold text-indigo-700">
              {formatBnCurrency(b.Bank)}
            </p>
          </div>
          <div className="rounded-lg border border-[#0f4c5c]/30 bg-teal-50/50 p-3">
            <span className="font-semibold text-[#0f4c5c]">সর্বমোট ব্যালেন্স</span>
            <p className="mt-1 font-mono-num text-base font-bold text-slate-900">
              {formatBnCurrency(b.netBalance)}
            </p>
          </div>
        </div>
      </section>

      {/* TAB 1: Cashflow Ledger */}
      {tab === 'cashflow' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">শুরুর তারিখ</label>
                <input
                  type="date"
                  value={cfFrom}
                  onChange={(e) => setCfFrom(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-mono-num text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">শেষ তারিখ</label>
                <input
                  type="date"
                  value={cfTo}
                  onChange={(e) => setCfTo(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-mono-num text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">অ্যাকাউন্ট</label>
                <select
                  value={cfAccount}
                  onChange={(e) => setCfAccount(e.target.value as 'ALL' | PaymentMethod)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  <option value="ALL">সব অ্যাকাউন্ট</option>
                  <option value="Cash">Cash</option>
                  <option value="bKash">bKash</option>
                  <option value="Nagad">Nagad</option>
                  <option value="Rocket">Rocket</option>
                  <option value="Bank">Bank</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                onPrint({
                  kind: 'a4-report',
                  title: 'জমা-খরচ ক্যাশফ্লো লেজার',
                  summaryRows: [
                    { label: 'মোট জমা', value: formatBnCurrency(b.totalIncome) },
                    { label: 'মোট খরচ', value: formatBnCurrency(b.totalExpense) },
                    { label: 'নিট ব্যালেন্স', value: formatBnCurrency(b.netBalance) },
                  ],
                  columns: [
                    { key: 'date', label: 'তারিখ' },
                    { key: 'id', label: 'ভাউচার/রিসিট' },
                    { key: 'type', label: 'ধরন' },
                    { key: 'account', label: 'অ্যাকাউন্ট' },
                    { key: 'particulars', label: 'বিবরণ' },
                    { key: 'amount', label: 'টাকা', align: 'right' },
                  ],
                  rows: cashflowRows.map((r) => ({
                    date: toBnDigits(r.date),
                    id: r.id,
                    type: r.type,
                    account: paymentMethodLabel(r.account),
                    particulars: r.particulars,
                    amount: formatBnCurrency(r.amount),
                  })),
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0f4c5c] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#135d66]"
            >
              <Printer className="h-3.5 w-3.5" />
              A4 প্রিন্ট লেজার
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="px-3 py-2.5 text-left font-semibold">তারিখ ও আইডি</th>
                  <th className="px-3 py-2.5 text-left font-semibold">ধরন</th>
                  <th className="px-3 py-2.5 text-left font-semibold">অ্যাকাউন্ট</th>
                  <th className="px-3 py-2.5 text-left font-semibold">বিবরণ</th>
                  <th className="px-3 py-2.5 text-right font-semibold">টাকা</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {cashflowRows.map((r) => (
                  <tr key={`${r.id}-${r.type}`} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5">
                      <span className="font-mono-num font-semibold">{r.id}</span>
                      <span className="block text-[11px] text-slate-500">{toBnDigits(r.date)}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${
                          r.type === 'জমা'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-red-200 bg-red-50 text-red-700'
                        }`}
                      >
                        {r.type}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{paymentMethodLabel(r.account)}</td>
                    <td className="px-3 py-2.5 text-slate-800">{r.particulars}</td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono-num font-bold ${
                        r.type === 'জমা' ? 'text-emerald-700' : 'text-red-600'
                      }`}
                    >
                      {r.type === 'জমা' ? '+' : '-'}
                      {formatBnCurrency(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 2: Expenses */}
      {tab === 'expenses' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-4 space-y-3.5">
            <h3 className="text-base font-bold text-slate-900">নতুন খরচ ভাউচার যোগ করুন</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">তারিখ</label>
              <input
                type="date"
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">খরচের খাত</label>
              <select
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value as ExpenseCategory)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {EXPENSE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                কোন অ্যাকাউন্ট থেকে খরচ
              </label>
              <select
                value={expAccount}
                onChange={(e) => setExpAccount(e.target.value as PaymentMethod)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="Cash">নগদ (Cash)</option>
                <option value="bKash">বিকাশ (bKash)</option>
                <option value="Nagad">নগদ (Nagad)</option>
                <option value="Rocket">রকেট (Rocket)</option>
                <option value="Bank">ব্যাংক (Bank)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">পরিমাণ (৳) *</label>
              <input
                type="number"
                min={1}
                value={expAmount}
                onChange={(e) => setExpAmount(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">বিবরণ / নোট</label>
              <input
                type="text"
                value={expNote}
                onChange={(e) => setExpNote(e.target.value)}
                placeholder="খরচের বিস্তারিত"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <button
              type="button"
              disabled={!Number(expAmount)}
              onClick={() => setConfirmExpOpen(true)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              খরচ সংরক্ষণ করুন
            </button>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-8 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold text-slate-900">খরচের ভাউচার তালিকা</h3>
              <button
                type="button"
                onClick={() =>
                  onPrint({
                    kind: 'a4-report',
                    title: 'খাতভিত্তিক খরচ রিপোর্ট',
                    summaryRows: expenseByCategory.map((ec) => ({
                      label: ec.category,
                      value: formatBnCurrency(ec.total),
                    })),
                    columns: [
                      { key: 'id', label: 'ভাউচার নং' },
                      { key: 'date', label: 'তারিখ' },
                      { key: 'cat', label: 'খাত' },
                      { key: 'acc', label: 'অ্যাকাউন্ট' },
                      { key: 'note', label: 'নোট' },
                      { key: 'amt', label: 'পরিমাণ', align: 'right' },
                    ],
                    rows: data.expenses.map((e) => ({
                      id: e.ExpenseID,
                      date: toBnDigits(e.Date),
                      cat: e.Category,
                      acc: paymentMethodLabel(e.PaymentAccount),
                      note: e.Note || '-',
                      amt: formatBnCurrency(e.Amount),
                    })),
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Printer className="h-3.5 w-3.5" />
                খাতভিত্তিক প্রিন্ট
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="px-3 py-2 text-left">ভাউচার ও তারিখ</th>
                    <th className="px-3 py-2 text-left">খাত</th>
                    <th className="px-3 py-2 text-left">অ্যাকাউন্ট</th>
                    <th className="px-3 py-2 text-left">নোট</th>
                    <th className="px-3 py-2 text-right">পরিমাণ</th>
                    <th className="px-3 py-2 text-right">ডিলিট</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {data.expenses.map((e) => (
                    <tr key={e.ExpenseID} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <span className="font-mono-num font-semibold">{e.ExpenseID}</span>
                        <span className="block text-[11px] text-slate-500">{toBnDigits(e.Date)}</span>
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-900">{e.Category}</td>
                      <td className="px-3 py-2">{paymentMethodLabel(e.PaymentAccount)}</td>
                      <td className="px-3 py-2 text-slate-600">{e.Note || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono-num font-bold text-red-600">
                        {formatBnCurrency(e.Amount)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteErr('');
                            setDeleteExp(e);
                          }}
                          className="rounded border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* TAB 3: Comprehensive A4 Reports */}
      {tab === 'reports' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
          <div>
            <h3 className="text-base font-bold text-slate-900">প্রিন্টেবল A4 রিপোর্ট জেনারেটর</h3>
            <p className="text-xs text-slate-500">
              যেকোনো রিপোর্ট ফিল্টার করে প্রিন্ট বা PDF হিসেবে সংরক্ষণ করুন
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(
              [
                ['customers', 'গ্রাহক তালিকা রিপোর্ট'],
                ['monthly', 'মাসিক বিল ও কালেকশন রিপোর্ট'],
                ['collections', 'বিল আদায় রিপোর্ট'],
              ] as const
            ).map(([k, title]) => (
              <button
                key={k}
                type="button"
                onClick={() => setRepType(k)}
                className={`flex items-center gap-2.5 rounded-xl border p-4 text-left text-sm font-semibold transition-colors ${
                  repType === k
                    ? 'border-[#0f4c5c] bg-teal-50/40 text-[#0f4c5c]'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <FileBarChart2 className="h-4 w-4 shrink-0" />
                <span>{title}</span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            {repType === 'customers' && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">এরিয়া</label>
                  <select
                    value={repArea}
                    onChange={(e) => setRepArea(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="ALL">সব এরিয়া</option>
                    {data.areas.map((a) => (
                      <option key={a.AreaID} value={a.AreaName}>
                        {a.AreaName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">স্ট্যাটাস</label>
                  <select
                    value={repStatus}
                    onChange={(e) => setRepStatus(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="ALL">সব</option>
                    <option value="এক্টিভ">এক্টিভ</option>
                    <option value="ডি-এক্টিভ">ডি-এক্টিভ</option>
                  </select>
                </div>
              </>
            )}

            {repType === 'monthly' && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">মাস নির্বাচন</label>
                <input
                  type="month"
                  value={repMonth}
                  onChange={(e) => setRepMonth(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm"
                />
              </div>
            )}

            {repType === 'collections' && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">শুরুর তারিখ</label>
                  <input
                    type="date"
                    value={repFrom}
                    onChange={(e) => setRepFrom(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">শেষ তারিখ</label>
                  <input
                    type="date"
                    value={repTo}
                    onChange={(e) => setRepTo(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">পেমেন্ট মাধ্যম</label>
                  <select
                    value={repMethod}
                    onChange={(e) => setRepMethod(e.target.value as 'ALL' | PaymentMethod)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="ALL">সব মাধ্যম</option>
                    <option value="Cash">Cash</option>
                    <option value="bKash">bKash</option>
                    <option value="Nagad">Nagad</option>
                    <option value="Rocket">Rocket</option>
                    <option value="Bank">Bank</option>
                  </select>
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={triggerReportPrint}
            className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66]"
          >
            <Printer className="h-4 w-4" />
            A4 রিপোর্ট প্রিভিউ ও প্রিন্ট করুন
          </button>
        </section>
      )}

      {/* TAB 4: Bulk WhatsApp & SMS Broadcast */}
      {tab === 'broadcast' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">বাল্ক SMS ও WhatsApp ব্রডকাস্ট</h3>
              <p className="text-xs text-slate-500">
                প্লেইসহোল্ডার: <code className="font-mono-num">{'{Name}'}</code>,{' '}
                <code className="font-mono-num">{'{ID}'}</code>,{' '}
                <code className="font-mono-num">{'{LastDate}'}</code>,{' '}
                <code className="font-mono-num">{'{DueAmount}'}</code>,{' '}
                <code className="font-mono-num">{'{Due}'}</code>,{' '}
                <code className="font-mono-num">{'{PayLink}'}</code>,{' '}
                <code className="font-mono-num">{'{Company}'}</code>
              </p>
            </div>

            <button
              type="button"
              disabled={sendingBulkSms || broadcastTargets.length === 0}
              onClick={async () => {
                const targetCustomers =
                  selectedIds.length > 0
                    ? broadcastTargets.filter((c) => selectedIds.includes(c.CustomerID))
                    : broadcastTargets;
                if (targetCustomers.length === 0) return;
                setSendingBulkSms(true);
                setBulkSmsMsg('');
                try {
                  const res = await api.broadcastSms(
                    targetCustomers.map((c) => ({
                      customerId: c.CustomerID,
                      message: formatBroadcastMsg(c, true),
                    }))
                  );
                  setBulkSmsMsg(
                    `মোট ${toBnDigits(res.sentCount)} জন গ্রাহকের কাছে বাংলা SMS পাঠানো হয়েছে (বিস্তারিত SMS লগ ট্যাবে দেখুন)।`
                  );
                  await onRefresh();
                } catch (err) {
                  setBulkSmsMsg((err as Error).message);
                } finally {
                  setSendingBulkSms(false);
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#135d66] disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {sendingBulkSms
                ? 'SMS পাঠানো হচ্ছে...'
                : selectedIds.length > 0
                  ? `নির্বাচিত ${toBnDigits(selectedIds.length)} জনকে SMS পাঠান`
                  : `সকল ${toBnDigits(broadcastTargets.length)} জনকে বাল্ক SMS পাঠান`}
            </button>
          </div>

          {bulkSmsMsg && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-medium text-emerald-800">
              {bulkSmsMsg}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">এরিয়া ফিল্টার</label>
              <select
                value={bcArea}
                onChange={(e) => setBcArea(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="ALL">সব এরিয়া</option>
                {data.areas.map((a) => (
                  <option key={a.AreaID} value={a.AreaName}>
                    {a.AreaName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">গ্রাহক ফিল্টার</label>
              <select
                value={bcFilter}
                onChange={(e) => setBcFilter(e.target.value as 'ALL' | 'DUE_ONLY')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="DUE_ONLY">শুধু বকেয়া গ্রাহক</option>
                <option value="ALL">সবাই</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">মেসেজ টেমপ্লেট</label>
            <textarea
              rows={3}
              value={bcTemplate}
              onChange={(e) => setBcTemplate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 p-3 text-sm"
            />
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">নির্বাচন</th>
                  <th className="px-3 py-2 text-left">গ্রাহক</th>
                  <th className="px-3 py-2 text-left">এরিয়া</th>
                  <th className="px-3 py-2 text-right">বকেয়া</th>
                  <th className="px-3 py-2 text-right">পাঠান</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {broadcastTargets.map((c) => {
                  const due = dueMap.get(c.CustomerID) || 0;
                  const checked = selectedIds.includes(c.CustomerID);
                  return (
                    <tr key={c.CustomerID} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedIds((prev) =>
                              checked
                                ? prev.filter((id) => id !== c.CustomerID)
                                : [...prev, c.CustomerID]
                            )
                          }
                          className="h-4 w-4 rounded border-slate-300 text-[#0f4c5c]"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-semibold text-slate-900">{c.Name}</span>
                        <span className="block font-mono-num text-[11px] text-slate-500">
                          {c.CustomerID} · {toBnDigits(c.Mobile)}
                        </span>
                      </td>
                      <td className="px-3 py-2">{c.Area}</td>
                      <td className="px-3 py-2 text-right font-mono-num font-bold text-red-600">
                        {formatBnCurrency(due)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              setSendingBulkSms(true);
                              try {
                                await api.sendSms({
                                  customerId: c.CustomerID,
                                  message: formatBroadcastMsg(c),
                                });
                                setBulkSmsMsg(`${c.Name} (${toBnDigits(c.Mobile)}) নম্বরে SMS পাঠানো হয়েছে।`);
                                await onRefresh();
                              } finally {
                                setSendingBulkSms(false);
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                          >
                            <MessageSquare className="h-3.5 w-3.5 text-[#0f4c5c]" />
                            SMS
                          </button>
                          <a
                            href={buildWhatsAppUrl(c.Mobile, formatBroadcastMsg(c))}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                            WhatsApp
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 5: SMS Delivery Logs */}
      {tab === 'smslogs' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">বাংলা SMS ডেলিভারি লগ</h3>
              <p className="text-xs text-slate-500">
                বিল আদায় ও ব্রডকাস্ট থেকে পাঠানো সকল বাংলা SMS-এর তালিকা
              </p>
            </div>
            <span className="text-xs font-medium text-slate-600">
              মোট রেকর্ড: {toBnDigits(data.smsLogs.length)}টি
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="px-3 py-2.5 text-left font-semibold">সময় ও আইডি</th>
                  <th className="px-3 py-2.5 text-left font-semibold">গ্রাহক ও মোবাইল</th>
                  <th className="px-3 py-2.5 text-left font-semibold">রিসিট</th>
                  <th className="px-3 py-2.5 text-left font-semibold">বাংলা SMS বার্তা</th>
                  <th className="px-3 py-2.5 text-center font-semibold">অবস্থা</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {data.smsLogs.map((log) => (
                  <tr key={log.SmsID} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="font-mono-num font-semibold text-slate-900">{log.SmsID}</span>
                      <span className="block text-[11px] text-slate-500">
                        {toBnDigits(log.Timestamp.slice(0, 16).replace('T', ' '))}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-slate-900">{log.CustomerName}</span>
                      <span className="block font-mono-num text-[11px] text-slate-500">
                        {log.CustomerID} · {toBnDigits(log.Mobile)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono-num text-slate-700">{log.ReceiptID}</td>
                    <td className="px-3 py-2.5 max-w-md">
                      <p className="text-slate-800">{log.Message}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {log.Provider} · {log.GatewayResponse}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${
                          log.Status === 'Sent'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : log.Status === 'Simulated'
                              ? 'border-amber-200 bg-amber-50 text-amber-700'
                              : 'border-red-200 bg-red-50 text-red-700'
                        }`}
                      >
                        {log.Status === 'Sent'
                          ? 'প্রেরিত'
                          : log.Status === 'Simulated'
                            ? 'স্যান্ডবক্স'
                            : 'ব্যর্থ'}
                      </span>
                    </td>
                  </tr>
                ))}
                {data.smsLogs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                      এখনো কোনো SMS পাঠানো হয়নি।
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmExpOpen}
        title="খরচ ভাউচার নিশ্চিত করুন"
        items={[
          { label: 'খাত', value: expCategory },
          { label: 'অ্যাকাউন্ট', value: paymentMethodLabel(expAccount) },
          { label: 'পরিমাণ', value: formatBnCurrency(Number(expAmount)) },
          { label: 'তারিখ', value: expDate },
        ]}
        loading={savingExp}
        onConfirm={handleSaveExpense}
        onCancel={() => setConfirmExpOpen(false)}
      />

      <AdminPasswordModal
        open={Boolean(deleteExp)}
        title={`খরচ ভাউচার ডিলিট: ${deleteExp?.ExpenseID || ''}`}
        description="খরচের ভাউচারটি ডিলিট করলে অ্যাকাউন্ট ব্যালেন্স পুনরায় সমন্বয় হবে।"
        error={deleteErr}
        loading={deletingExp}
        onConfirm={handleDeleteExpense}
        onCancel={() => setDeleteExp(null)}
      />
    </div>
  );
};

interface SettingsViewProps {
  data: DashboardPayload;
  onRefresh: () => Promise<void>;
}

const resolveDueReminder = (dr?: DueReminderConfig): DueReminderConfig => ({
  Enabled: dr?.Enabled ?? DEFAULT_LINK_REMINDER_CONFIG.Enabled,
  SendHour: dr?.SendHour ?? DEFAULT_LINK_REMINDER_CONFIG.SendHour,
  DeadlineDay: dr?.DeadlineDay ?? DEFAULT_LINK_REMINDER_CONFIG.DeadlineDay,
  AutoGenerateBills: dr?.AutoGenerateBills ?? DEFAULT_LINK_REMINDER_CONFIG.AutoGenerateBills,
  Template: dr?.Template || DEFAULT_LINK_REMINDER_CONFIG.Template,
});

export const SettingsView: React.FC<SettingsViewProps> = ({ data, onRefresh }) => {
  const [form, setForm] = useState<Partial<SettingsData> & { CurrentAdminPassword?: string }>({
    ...data.settings,
    DueReminder: resolveDueReminder(data.settings.DueReminder),
    AdminPassword: '',
    CurrentAdminPassword: '',
  });
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [err, setErr] = useState('');

  const [duePreviewLoading, setDuePreviewLoading] = useState(false);
  const [dueRunLoading, setDueRunLoading] = useState(false);
  const [dueResult, setDueResult] = useState<DueReminderResult | null>(null);
  const [dueError, setDueError] = useState('');

  const dueReminder = resolveDueReminder(form.DueReminder);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg('');
    setErr('');
    try {
      await api.updateSettings(form);
      setSavedMsg('সিস্টেম সেটিংস ও ই-বিলিং অ্যাকাউন্ট সফলভাবে সংরক্ষণ করা হয়েছে।');
      setForm((prev) => ({ ...prev, AdminPassword: '', CurrentAdminPassword: '' }));
      await onRefresh();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDuePreview = async () => {
    setDuePreviewLoading(true);
    setDueError('');
    try {
      const res = await api.dueReminderPreview();
      setDueResult(res);
    } catch (error) {
      setDueError((error as Error).message);
    } finally {
      setDuePreviewLoading(false);
    }
  };

  const handleDueRun = async () => {
    setDueRunLoading(true);
    setDueError('');
    try {
      const res = await api.dueReminderRun();
      setDueResult(res);
      await onRefresh();
    } catch (error) {
      setDueError((error as Error).message);
    } finally {
      setDueRunLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <h2 className="text-lg font-bold text-slate-900">কোম্পানি ও নোটিশ সেটিংস</h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">কোম্পানির নাম</label>
              <input
                type="text"
                value={form.CompanyName || ''}
                onChange={(e) => setForm({ ...form, CompanyName: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">ব্যবসার ধরন</label>
              <input
                type="text"
                value={form.BusinessType || ''}
                onChange={(e) => setForm({ ...form, BusinessType: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">ঠিকানা</label>
              <input
                type="text"
                value={form.Address || ''}
                onChange={(e) => setForm({ ...form, Address: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">হেল্পলাইন ফোন</label>
              <input
                type="text"
                value={form.Phone || ''}
                onChange={(e) => setForm({ ...form, Phone: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                স্ক্রলিং নোটিশ বার্তা
              </label>
              <input
                type="text"
                value={form.ScrollingNotice || ''}
                onChange={(e) => setForm({ ...form, ScrollingNotice: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <h2 className="text-lg font-bold text-slate-900">
            ই-বিলিং পেমেন্ট অ্যাকাউন্ট (bKash, Nagad, Rocket, Bank)
          </h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">বিকাশ নম্বর</label>
              <input
                type="text"
                value={form.BkashNumber || ''}
                onChange={(e) => setForm({ ...form, BkashNumber: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">বিকাশ ধরন</label>
              <select
                value={form.BkashType || 'Merchant'}
                onChange={(e) =>
                  setForm({
                    ...form,
                    BkashType: e.target.value as SettingsData['BkashType'],
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="Merchant">Merchant</option>
                <option value="Personal">Personal</option>
                <option value="Agent">Agent</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">রকেট নম্বর</label>
              <input
                type="text"
                value={form.RocketNumber || ''}
                onChange={(e) => setForm({ ...form, RocketNumber: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">নগদ নম্বর</label>
              <input
                type="text"
                value={form.NagadNumber || ''}
                onChange={(e) => setForm({ ...form, NagadNumber: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">নগদ ধরন</label>
              <select
                value={form.NagadType || 'Merchant'}
                onChange={(e) =>
                  setForm({
                    ...form,
                    NagadType: e.target.value as SettingsData['NagadType'],
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="Merchant">Merchant</option>
                <option value="Personal">Personal</option>
                <option value="Agent">Agent</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                ওয়েবহুক সিক্রেট (IPN)
              </label>
              <input
                type="text"
                minLength={16}
                maxLength={128}
                value={form.PaymentGatewayWebhookSecret || ''}
                onChange={(e) =>
                  setForm({ ...form, PaymentGatewayWebhookSecret: e.target.value })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                কমপক্ষে ১৬ অক্ষরের গোপন কী ব্যবহার করুন
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">ব্যাংকের নাম</label>
              <input
                type="text"
                value={form.BankDetails?.BankName || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    BankDetails: { ...form.BankDetails!, BankName: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">অ্যাকাউন্ট নাম</label>
              <input
                type="text"
                value={form.BankDetails?.AccountName || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    BankDetails: { ...form.BankDetails!, AccountName: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">অ্যাকাউন্ট নম্বর</label>
              <input
                type="text"
                value={form.BankDetails?.AccountNo || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    BankDetails: { ...form.BankDetails!, AccountNo: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">শাখা (Branch)</label>
              <input
                type="text"
                value={form.BankDetails?.Branch || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    BankDetails: { ...form.BankDetails!, Branch: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">রাউটিং নম্বর</label>
              <input
                type="text"
                value={form.BankDetails?.Routing || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    BankDetails: { ...form.BankDetails!, Routing: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>
          </div>
        </section>

        {/* SMS Notification Settings (API keys strictly managed server-side via environment variables) */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                SMS গেটওয়ে ও স্বয়ংক্রিয় কনফার্মেশন সেটিংস
              </h2>
              <p className="text-xs text-slate-500">
                বিল আদায় ও ই-পেমেন্ট অনুমোদনের সাথে সাথে গ্রাহকের মোবাইলে স্বয়ংক্রিয় বাংলা SMS পাঠানো হবে
              </p>
            </div>
            <div className="text-xs text-slate-600">
              সার্ভার গেটওয়ে:{' '}
              <span className="font-semibold text-slate-900">
                Twilio ({data.smsEnvStatus.twilioConfigured ? 'যুক্ত আছে' : 'অযুক্ত'}) · Local BD API (
                {data.smsEnvStatus.localConfigured ? 'যুক্ত আছে' : 'অযুক্ত'})
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <input
              id="sms-enabled-toggle"
              type="checkbox"
              checked={Boolean(form.SmsConfig?.Enabled)}
              onChange={(e) =>
                setForm({
                  ...form,
                  SmsConfig: { ...form.SmsConfig!, Enabled: e.target.checked },
                })
              }
              className="h-4 w-4 rounded border-slate-300 text-[#0f4c5c]"
            />
            <label htmlFor="sms-enabled-toggle" className="cursor-pointer text-sm font-semibold text-slate-900">
              বিল আদায় সফল হলে স্বয়ংক্রিয়ভাবে বাংলা SMS পাঠান
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">SMS গেটওয়ে প্রোভাইডার</label>
              <select
                value={form.SmsConfig?.Provider || 'sandbox'}
                onChange={(e) =>
                  setForm({
                    ...form,
                    SmsConfig: {
                      ...form.SmsConfig!,
                      Provider: e.target.value as SmsProvider,
                    },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="sandbox">স্যান্ডবক্স মোড (টেস্টিং ও লগ সংরক্ষণ)</option>
                <option value="twilio">Twilio SMS API (সার্ভার Env ভেরিয়েবল)</option>
                <option value="local_bd">লোকাল বাংলাদেশি SMS API (BulkSMSBD / SSL / GreenWeb)</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                সেন্ডার আইডি / মাস্কিং নাম (Sender ID)
              </label>
              <input
                type="text"
                value={form.SmsConfig?.SenderId || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    SmsConfig: { ...form.SmsConfig!, SenderId: e.target.value },
                  })
                }
                placeholder="যেমন: NetBillISP"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                বাংলা পেমেন্ট কনফার্মেশন SMS টেমপ্লেট
              </label>
              <textarea
                rows={2}
                value={form.SmsConfig?.PaymentSmsTemplate || ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    SmsConfig: {
                      ...form.SmsConfig!,
                      PaymentSmsTemplate: e.target.value,
                    },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-3 text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                প্লেইসহোল্ডারসমূহ: <code className="font-mono-num">{'{Name}'}</code>,{' '}
                <code className="font-mono-num">{'{ID}'}</code>,{' '}
                <code className="font-mono-num">{'{Month}'}</code>,{' '}
                <code className="font-mono-num">{'{Amount}'}</code>,{' '}
                <code className="font-mono-num">{'{Method}'}</code>,{' '}
                <code className="font-mono-num">{'{TrxID}'}</code>,{' '}
                <code className="font-mono-num">{'{ReceiptID}'}</code>,{' '}
                <code className="font-mono-num">{'{Company}'}</code>
              </p>
            </div>
          </div>

          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
            নিরাপত্তার স্বার্থে Twilio Auth Token অথবা Local SMS API Key সরাসরি সার্ভার এনভায়রনমেন্ট
            (Secrets / <code className="font-mono-num">.env</code>) থেকে ব্যবহৃত হয়।
          </p>
        </section>

        {/* One-time Permanent Payment Link SMS & Automatic Monthly Billing */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                <CalendarClock className="h-5 w-5 text-[#0f4c5c]" />
                <span>পেমেন্ট লিংক SMS ও মাসিক বিল</span>
              </h2>
              <p className="text-xs text-slate-500">
                প্রতিটি সক্রিয় গ্রাহককে একবার স্থায়ী পেমেন্ট লিংক SMS পাঠানো হবে এবং প্রতি মাসে স্বয়ংক্রিয়ভাবে নতুন মাসের বিল তৈরি হবে।
              </p>
            </div>
            {dueResult?.lastRunDate && (
              <span className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                সর্বশেষ প্রেরণ: <strong className="font-mono-num">{dueResult.lastRunDate}</strong>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label
              htmlFor="due-reminder-enabled"
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
            >
              <input
                id="due-reminder-enabled"
                type="checkbox"
                checked={dueReminder.Enabled}
                onChange={(e) =>
                  setForm({
                    ...form,
                    DueReminder: { ...dueReminder, Enabled: e.target.checked },
                  })
                }
                className="h-4 w-4 rounded border-slate-300 text-[#0f4c5c]"
              />
              <div>
                <span className="block text-sm font-semibold text-slate-900">
                  স্বয়ংক্রিয় পেমেন্ট লিংক SMS চালু করুন
                </span>
                <span className="block text-[11px] text-slate-500">
                  প্রতিটি গ্রাহক একবারই লিংক পাবেন (ডিফল্ট বন্ধ)
                </span>
              </div>
            </label>

            <label
              htmlFor="due-reminder-autobill"
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
            >
              <input
                id="due-reminder-autobill"
                type="checkbox"
                checked={dueReminder.AutoGenerateBills}
                onChange={(e) =>
                  setForm({
                    ...form,
                    DueReminder: { ...dueReminder, AutoGenerateBills: e.target.checked },
                  })
                }
                className="h-4 w-4 rounded border-slate-300 text-[#0f4c5c]"
              />
              <div>
                <span className="block text-sm font-semibold text-slate-900">
                  স্বয়ংক্রিয় মাসিক বিল তৈরি করুন
                </span>
                <span className="block text-[11px] text-slate-500">
                  নতুন মাসে প্রবেশ করলে সক্রিয় গ্রাহকদের বিল তৈরি হবে
                </span>
              </div>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                SMS পাঠানোর সময় (ঘণ্টা, ০–২৩ · বাংলাদেশ সময়)
              </label>
              <input
                type="number"
                min={0}
                max={23}
                value={dueReminder.SendHour}
                onChange={(e) =>
                  setForm({
                    ...form,
                    DueReminder: { ...dueReminder, SendHour: Number(e.target.value) },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                পেমেন্টের শেষ তারিখ (প্রতি মাসের দিন, ১–৩১)
              </label>
              <input
                type="number"
                min={1}
                max={31}
                value={dueReminder.DeadlineDay}
                onChange={(e) =>
                  setForm({
                    ...form,
                    DueReminder: { ...dueReminder, DeadlineDay: Number(e.target.value) },
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                স্থায়ী পেমেন্ট লিংক SMS টেমপ্লেট
              </label>
              <textarea
                rows={3}
                value={dueReminder.Template}
                onChange={(e) =>
                  setForm({
                    ...form,
                    DueReminder: { ...dueReminder, Template: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-3 text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                প্লেইসহোল্ডারসমূহ: <code className="font-mono-num">{'{Name}'}</code>,{' '}
                <code className="font-mono-num">{'{ID}'}</code>,{' '}
                <code className="font-mono-num">{'{DeadlineDay}'}</code>,{' '}
                <code className="font-mono-num">{'{PayLink}'}</code>,{' '}
                <code className="font-mono-num">{'{Company}'}</code>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
            <button
              type="button"
              disabled={duePreviewLoading || dueRunLoading}
              onClick={handleDuePreview}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <Eye className="h-3.5 w-3.5 text-[#0f4c5c]" />
              {duePreviewLoading ? 'হিসাব হচ্ছে...' : 'কারা পাবেন দেখুন'}
            </button>

            <button
              type="button"
              disabled={duePreviewLoading || dueRunLoading}
              onClick={handleDueRun}
              className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#135d66] disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {dueRunLoading ? 'পাঠানো হচ্ছে...' : 'এখনই পাঠান'}
            </button>

            <span className="text-[11px] text-slate-500">
              সেটিংস পরিবর্তন করলে প্রথমে নিচের "সেটিংস সংরক্ষণ করুন" বাটনে ক্লিক করুন।
            </span>
          </div>

          {dueError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
              {dueError}
            </div>
          )}

          {dueResult && (
            <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 text-xs space-y-2">
              <div className="flex flex-wrap gap-4 font-semibold text-slate-800">
                <span>নতুন লিংক পাবেন: {toBnDigits(dueResult.eligible)} জন</span>
                <span>ইতিমধ্যে পেয়েছেন: {toBnDigits(dueResult.alreadySent)} জন</span>
                <span>নতুন বিল তৈরি: {toBnDigits(dueResult.generatedBills)}টি</span>
                {(dueResult.sent > 0 || dueResult.failed > 0) && (
                  <span className="text-emerald-700">
                    পাঠানো হয়েছে: {toBnDigits(dueResult.sent)} জন
                    {dueResult.failed > 0 ? ` (ব্যর্থ: ${toBnDigits(dueResult.failed)})` : ''}
                  </span>
                )}
              </div>

              {!dueResult.hasLink && (
                <p className="text-amber-700">
                  সতর্কতা: পেমেন্ট লিংকের জন্য <code className="font-mono-num">.env</code> ফাইলে{' '}
                  <code className="font-mono-num">APP_URL</code> সেট করুন অথবা আপনার আসল ডোমেইন দিয়ে খুলুন (localhost লিংক গ্রাহকের ফোনে খুলবে না)।
                </p>
              )}

              {dueResult.sample && (
                <div className="rounded border border-slate-200 bg-white p-2.5 text-slate-700">
                  <span className="block font-semibold text-slate-500 mb-1">নমুনা SMS:</span>
                  {dueResult.sample}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <h2 className="text-lg font-bold text-slate-900">অ্যাডমিন নিরাপত্তা ও পাসওয়ার্ড</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                অ্যাডমিন ইউজারনেম
              </label>
              <input
                type="text"
                pattern="^[A-Za-z0-9._-]{3,32}$"
                value={form.AdminUsername || ''}
                onChange={(e) => setForm({ ...form, AdminUsername: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                ৩–৩২ অক্ষর (ইংরেজি অক্ষর, সংখ্যা, . _ -)
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                বর্তমান অ্যাডমিন পাসওয়ার্ড
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required={Boolean(form.AdminPassword && form.AdminPassword.trim())}
                value={form.CurrentAdminPassword || ''}
                onChange={(e) => setForm({ ...form, CurrentAdminPassword: e.target.value })}
                placeholder="পাসওয়ার্ড পরিবর্তন করতে চাইলে লিখুন"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                নতুন অ্যাডমিন পাসওয়ার্ড (ঐচ্ছিক)
              </label>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={form.AdminPassword || ''}
                onChange={(e) => setForm({ ...form, AdminPassword: e.target.value })}
                placeholder="অপরিবর্তিত রাখতে খালি রাখুন (৮+ অক্ষর)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                কমপক্ষে ৮ অক্ষরের শক্তিশালী পাসওয়ার্ড দিন
              </p>
            </div>
          </div>

          {savedMsg && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{savedMsg}</span>
            </div>
          )}

          {err && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {err}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {saving ? 'সংরক্ষণ হচ্ছে...' : 'সেটিংস সংরক্ষণ করুন'}
          </button>
        </section>
      </form>
    </div>
  );
};

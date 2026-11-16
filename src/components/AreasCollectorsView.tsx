import React, { useMemo, useState } from 'react';
import {
  Edit3,
  FileText,
  MapPin,
  MessageCircle,
  Plus,
  Printer,
  Trash2,
  UserCheck,
  Wallet,
  X,
} from 'lucide-react';
import { api } from '../api';
import {
  Area,
  AreaServiceType,
  Collector,
  CollectorDeposit,
  CollectorSummary,
  DashboardPayload,
  PaymentMethod,
  SessionUser,
} from '../types';
import {
  buildWhatsAppUrl,
  formatBnCurrency,
  getMonthLabelBn,
  getTodayStr,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';
import { AdminPasswordModal, ConfirmDialog } from './ConfirmDialog';
import { PrintPayload } from './PrintPreviewModal';

interface AreasViewProps {
  data: DashboardPayload;
  onRefresh: () => Promise<void>;
}

export const AreasView: React.FC<AreasViewProps> = ({ data, onRefresh }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Area | null>(null);
  const [areaName, setAreaName] = useState('');
  const [serviceType, setServiceType] = useState<AreaServiceType>('Both');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Area | null>(null);
  const [deleteErr, setDeleteErr] = useState('');
  const [deleting, setDeleting] = useState(false);

  const areaStats = useMemo(() => {
    return data.areas.map((a) => {
      const custs = data.customers.filter((c) => c.Area === a.AreaName);
      const active = custs.filter((c) => c.Status === 'এক্টিভ').length;
      const ids = new Set(custs.map((c) => c.CustomerID));
      const due = data.bills
        .filter((b) => ids.has(b.CustomerID))
        .reduce((s, b) => s + b.DueAmount, 0);
      return { area: a, total: custs.length, active, due };
    });
  }, [data]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      if (editing) {
        await api.updateArea(editing.AreaID, { AreaName: areaName, ServiceType: serviceType });
      } else {
        await api.createArea({ AreaName: areaName, ServiceType: serviceType });
      }
      setModalOpen(false);
      await onRefresh();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (pwd: string) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteErr('');
    try {
      await api.deleteArea(deleteTarget.AreaID, pwd);
      setDeleteTarget(null);
      await onRefresh();
    } catch (error) {
      setDeleteErr((error as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900">এরিয়া ও জোন ব্যবস্থাপনা</h2>
          <p className="text-xs text-slate-500">
            ইন্টারনেট ও ক্যাবল টিভি সার্ভিস জোনসমূহ পরিচালনা করুন
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setAreaName('');
            setServiceType('Both');
            setErr('');
            setModalOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66]"
        >
          <Plus className="h-4 w-4" />
          নতুন এরিয়া যোগ করুন
        </button>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {areaStats.map(({ area, total, active, due }) => (
          <div
            key={area.AreaID}
            className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5"
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-[#0f4c5c]" />
                  <h3 className="text-base font-bold text-slate-900">{area.AreaName}</h3>
                </div>
                <span className="text-xs font-medium text-slate-500">
                  {area.ServiceType === 'Both'
                    ? 'ইন্টারনেট ও ডিস'
                    : area.ServiceType === 'Internet'
                      ? 'ইন্টারনেট'
                      : 'ক্যাবল টিভি'}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs tabular-nums">
                <div>
                  <span className="text-slate-500">গ্রাহক</span>
                  <p className="font-bold text-slate-900">{toBnDigits(total)} জন</p>
                </div>
                <div>
                  <span className="text-slate-500">এক্টিভ</span>
                  <p className="font-bold text-emerald-700">{toBnDigits(active)} জন</p>
                </div>
                <div>
                  <span className="text-slate-500">মোট বকেয়া</span>
                  <p className="font-bold text-red-600">{formatBnCurrency(due)}</p>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => {
                  setEditing(area);
                  setAreaName(area.AreaName);
                  setServiceType(area.ServiceType);
                  setErr('');
                  setModalOpen(true);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Edit3 className="h-3.5 w-3.5" />
                এডিট
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteErr('');
                  setDeleteTarget(area);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
                ডিলিট
              </button>
            </div>
          </div>
        ))}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <form
            onSubmit={handleSave}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-base font-bold text-slate-900">
                {editing ? 'এরিয়া আপডেট' : 'নতুন এরিয়া'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">এরিয়ার নাম *</label>
                <input
                  type="text"
                  required
                  value={areaName}
                  onChange={(e) => setAreaName(e.target.value)}
                  placeholder="যেমন: মিরপুর ১০"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">সার্ভিসের ধরন</label>
                <select
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value as AreaServiceType)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="Both">ইন্টারনেট ও ক্যাবল টিভি উভয়ই</option>
                  <option value="Internet">শুধু ব্রডব্যান্ড ইন্টারনেট</option>
                  <option value="Cable TV">শুধু ক্যাবল টিভি (ডিস)</option>
                </select>
              </div>
              {err && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {err}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium"
              >
                বাতিল
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-[#0f4c5c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#135d66]"
              >
                {saving ? 'সংরক্ষণ হচ্ছে...' : 'সংরক্ষণ করুন'}
              </button>
            </div>
          </form>
        </div>
      )}

      <AdminPasswordModal
        open={Boolean(deleteTarget)}
        title={`এরিয়া ডিলিট: ${deleteTarget?.AreaName || ''}`}
        description="এরিয়াটি ডিলিট করতে আপনার অ্যাডমিন পাসওয়ার্ড দিন।"
        error={deleteErr}
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};

interface CollectorsViewProps {
  data: DashboardPayload;
  user: SessionUser;
  onRefresh: () => Promise<void>;
  onPrint: (payload: PrintPayload) => void;
}

export const CollectorsView: React.FC<CollectorsViewProps> = ({
  data,
  user,
  onRefresh,
  onPrint,
}) => {
  const isAdmin = user.role === 'Admin';

  // Collector Add/Edit Modal
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Collector | null>(null);
  const [formState, setFormState] = useState({
    Name: '',
    Mobile: '',
    Username: '',
    Password: '',
    AssignedAreas: [] as string[],
    Status: 'এক্টিভ' as Collector['Status'],
  });
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);

  // Deposit Modal
  const [depositTarget, setDepositTarget] = useState<CollectorSummary | null>(null);
  const [depositAmt, setDepositAmt] = useState('');
  const [depositMethod, setDepositMethod] = useState<Exclude<PaymentMethod, 'Rocket'>>('Cash');
  const [depositTrx, setDepositTrx] = useState('');
  const [depositNote, setDepositNote] = useState('');
  const [confirmDepositOpen, setConfirmDepositOpen] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [savedDeposit, setSavedDeposit] = useState<{
    deposit: CollectorDeposit;
    mobile: string;
  } | null>(null);

  // Ledger Modal / Inline for Collector Role
  const [ledgerTarget, setLedgerTarget] = useState<CollectorSummary | null>(
    isAdmin ? null : data.collectorSummaries[0] || null
  );
  const [ledgerFrom, setLedgerFrom] = useState('');
  const [ledgerTo, setLedgerTo] = useState('');
  const [ledgerArea, setLedgerArea] = useState('ALL');

  // Delete Modal
  const [deleteTarget, setDeleteTarget] = useState<CollectorSummary | null>(null);
  const [deleteErr, setDeleteErr] = useState('');
  const [deleting, setDeleting] = useState(false);

  const openAddCollector = () => {
    setEditing(null);
    setFormErr('');
    setFormState({
      Name: '',
      Mobile: '',
      Username: '',
      Password: '',
      AssignedAreas: [],
      Status: 'এক্টিভ',
    });
    setFormOpen(true);
  };

  const openEditCollector = (col: Collector) => {
    setEditing(col);
    setFormErr('');
    setFormState({
      Name: col.Name,
      Mobile: col.Mobile,
      Username: col.Username,
      Password: '',
      AssignedAreas: col.AssignedAreas,
      Status: col.Status,
    });
    setFormOpen(true);
  };

  const toggleAreaCheckbox = (areaName: string) => {
    setFormState((prev) => ({
      ...prev,
      AssignedAreas: prev.AssignedAreas.includes(areaName)
        ? prev.AssignedAreas.filter((a) => a !== areaName)
        : [...prev.AssignedAreas, areaName],
    }));
  };

  const handleSaveCollector = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormErr('');
    try {
      if (editing) {
        await api.updateCollector(editing.CollectorID, formState);
      } else {
        await api.createCollector(formState);
      }
      setFormOpen(false);
      await onRefresh();
    } catch (err) {
      setFormErr((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCommitDeposit = async () => {
    if (!depositTarget) return;
    setDepositing(true);
    try {
      const res = await api.createDeposit({
        collectorUsername: depositTarget.Username,
        amount: Number(depositAmt),
        depositMethod,
        trxId: depositTrx,
        note: depositNote,
        date: getTodayStr(),
      });
      setConfirmDepositOpen(false);
      setSavedDeposit({ deposit: res.deposit, mobile: depositTarget.Mobile });
      setDepositTarget(null);
      await onRefresh();
    } catch (err) {
      setConfirmDepositOpen(false);
      setFormErr((err as Error).message);
    } finally {
      setDepositing(false);
    }
  };

  const handleDeleteCollector = async (pwd: string) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteErr('');
    try {
      await api.deleteCollector(deleteTarget.CollectorID, pwd);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setDeleteErr((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const activeLedgerSummary = isAdmin ? ledgerTarget : data.collectorSummaries[0] || null;

  const ledgerData = useMemo(() => {
    if (!activeLedgerSummary) return { collections: [], deposits: [] };
    const cols = data.collections.filter((c) => {
      if (c.CollectedBy !== activeLedgerSummary.Username) return false;
      if (ledgerFrom && c.Date < ledgerFrom) return false;
      if (ledgerTo && c.Date > ledgerTo) return false;
      if (ledgerArea !== 'ALL' && c.Area !== ledgerArea) return false;
      return true;
    });
    const deps = data.deposits.filter((d) => {
      if (d.CollectorUsername !== activeLedgerSummary.Username) return false;
      if (ledgerFrom && d.Date < ledgerFrom) return false;
      if (ledgerTo && d.Date > ledgerTo) return false;
      return true;
    });
    return { collections: cols, deposits: deps };
  }, [activeLedgerSummary, data.collections, data.deposits, ledgerFrom, ledgerTo, ledgerArea]);

  const renderLedgerPanel = (target: CollectorSummary) => (
    <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
        <div>
          <h3 className="text-base font-bold text-slate-900">
            কালেক্টর লেজার — {target.Name}
          </h3>
          <p className="text-xs text-slate-500">
            দায়িত্বপ্রাপ্ত এরিয়া: {target.AssignedAreas.join(', ') || 'নির্ধারিত নেই'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onPrint({
                kind: 'a4-report',
                title: `কালেক্টর লেজার: ${target.Name} (${target.Username})`,
                subtitle: `এরিয়া: ${target.AssignedAreas.join(', ')}`,
                summaryRows: [
                  { label: 'নগদ আদায়', value: formatBnCurrency(target.cashCollected) },
                  { label: 'ডিজিটাল আদায়', value: formatBnCurrency(target.digitalCollected) },
                  { label: 'অফিসে জমা', value: formatBnCurrency(target.totalDeposited) },
                  { label: 'হাতে থাকা ক্যাশ', value: formatBnCurrency(target.handCash) },
                ],
                columns: [
                  { key: 'date', label: 'তারিখ' },
                  { key: 'receipt', label: 'রিসিট' },
                  { key: 'customer', label: 'গ্রাহক ও এরিয়া' },
                  { key: 'month', label: 'মাস' },
                  { key: 'method', label: 'মাধ্যম' },
                  { key: 'amount', label: 'টাকা', align: 'right' },
                ],
                rows: ledgerData.collections.map((c) => ({
                  date: toBnDigits(c.Date),
                  receipt: c.ReceiptID,
                  customer: `${c.CustomerName} (${c.Area})`,
                  month: getMonthLabelBn(c.BillingMonth),
                  method: paymentMethodLabel(c.PaymentMethod),
                  amount: formatBnCurrency(c.Amount),
                })),
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0f4c5c] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#135d66]"
          >
            <Printer className="h-3.5 w-3.5" />
            A4 প্রিন্ট লেজার
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setLedgerTarget(null)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
            >
              বন্ধ করুন
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">শুরুর তারিখ</label>
          <input
            type="date"
            value={ledgerFrom}
            onChange={(e) => setLedgerFrom(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono-num text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">শেষ তারিখ</label>
          <input
            type="date"
            value={ledgerTo}
            onChange={(e) => setLedgerTo(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono-num text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">এরিয়া ফিল্টার</label>
          <select
            value={ledgerArea}
            onChange={(e) => setLedgerArea(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
          >
            <option value="ALL">সব এরিয়া</option>
            {target.AssignedAreas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary KPI */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs tabular-nums">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <span className="text-slate-500">মোট নগদ আদায়</span>
          <p className="mt-1 font-mono-num text-base font-bold text-slate-900">
            {formatBnCurrency(target.cashCollected)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <span className="text-slate-500">ডিজিটাল আদায়</span>
          <p className="mt-1 font-mono-num text-base font-bold text-[#0f4c5c]">
            {formatBnCurrency(target.digitalCollected)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <span className="text-slate-500">অফিসে জমা</span>
          <p className="mt-1 font-mono-num text-base font-bold text-emerald-700">
            {formatBnCurrency(target.totalDeposited)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <span className="text-slate-500">হাতে থাকা ক্যাশ</span>
          <p className="mt-1 font-mono-num text-base font-bold text-amber-700">
            {formatBnCurrency(target.handCash)}
          </p>
        </div>
      </div>

      {/* Collections Table */}
      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-700">আদায়কৃত বিলের তালিকা</h4>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">রিসিট ও তারিখ</th>
                <th className="px-3 py-2 text-left">গ্রাহক ও এরিয়া</th>
                <th className="px-3 py-2 text-left">বিলের মাস</th>
                <th className="px-3 py-2 text-left">মাধ্যম</th>
                <th className="px-3 py-2 text-right">পরিমাণ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {ledgerData.collections.map((c) => (
                <tr key={c.ReceiptID}>
                  <td className="px-3 py-2">
                    <span className="font-mono-num font-semibold">{c.ReceiptID}</span>
                    <span className="block text-[11px] text-slate-500">{toBnDigits(c.Date)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-slate-900">{c.CustomerName}</span>
                    <span className="block text-[11px] text-slate-500">{c.Area}</span>
                  </td>
                  <td className="px-3 py-2">{getMonthLabelBn(c.BillingMonth)}</td>
                  <td className="px-3 py-2">{paymentMethodLabel(c.PaymentMethod)}</td>
                  <td className="px-3 py-2 text-right font-mono-num font-bold text-slate-900">
                    {formatBnCurrency(c.Amount)}
                  </td>
                </tr>
              ))}
              {ledgerData.collections.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-5 text-center text-slate-500">
                    কোনো আদায়ের তথ্য পাওয়া যায়নি।
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Deposits History */}
      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-700">অফিসে জমার বিবরণ</h4>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">জমা আইডি ও তারিখ</th>
                <th className="px-3 py-2 text-left">মাধ্যম ও TrxID</th>
                <th className="px-3 py-2 text-left">নোট</th>
                <th className="px-3 py-2 text-right">পরিমাণ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {ledgerData.deposits.map((d) => (
                <tr key={d.DepositID}>
                  <td className="px-3 py-2">
                    <span className="font-mono-num font-semibold">{d.DepositID}</span>
                    <span className="block text-[11px] text-slate-500">{toBnDigits(d.Date)}</span>
                  </td>
                  <td className="px-3 py-2">
                    {paymentMethodLabel(d.DepositMethod)}
                    {d.TrxID && (
                      <span className="block font-mono-num text-[11px] text-slate-500">
                        {d.TrxID}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{d.Note || '-'}</td>
                  <td className="px-3 py-2 text-right font-mono-num font-bold text-emerald-700">
                    {formatBnCurrency(d.Amount)}
                  </td>
                </tr>
              ))}
              {ledgerData.deposits.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-5 text-center text-slate-500">
                    এখনো অফিসে কোনো জমা হয়নি।
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );

  // If Collector logged in, show My Ledger directly
  if (!isAdmin) {
    return activeLedgerSummary ? (
      renderLedgerPanel(activeLedgerSummary)
    ) : (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        কালেক্টর প্রোফাইল পাওয়া যায়নি।
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900">কালেক্টর ও মাঠপর্যায়ের হিসাব</h2>
          <p className="text-xs text-slate-500">
            একাধিক এরিয়া বণ্টন, নগদ বনাম ডিজিটাল আদায় ট্র্যাকিং এবং অফিসে ক্যাশ জমা গ্রহণ
          </p>
        </div>
        <button
          type="button"
          onClick={openAddCollector}
          className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66]"
        >
          <Plus className="h-4 w-4" />
          নতুন কালেক্টর যোগ করুন
        </button>
      </section>

      {savedDeposit && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3.5 text-sm text-emerald-900">
          <div>
            <p className="font-bold">
              কালেক্টরের জমা সফল হয়েছে! ({savedDeposit.deposit.DepositID})
            </p>
            <p className="text-xs text-emerald-800">
              {savedDeposit.deposit.CollectorName} ·{' '}
              {formatBnCurrency(savedDeposit.deposit.Amount)} ·{' '}
              {paymentMethodLabel(savedDeposit.deposit.DepositMethod)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onPrint({
                  kind: 'pos-deposit',
                  receiptId: savedDeposit.deposit.DepositID,
                  date: savedDeposit.deposit.Date,
                  customerOrCollectorName: savedDeposit.deposit.CollectorName,
                  mobile: savedDeposit.mobile,
                  amount: savedDeposit.deposit.Amount,
                  paymentMethod: savedDeposit.deposit.DepositMethod,
                  trxId: savedDeposit.deposit.TrxID,
                  collectedBy: 'অফিস ক্যাশ/অ্যাডমিন',
                  note: savedDeposit.deposit.Note,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0f4c5c] px-3 py-1.5 text-xs font-semibold text-white"
            >
              <Printer className="h-3.5 w-3.5" />
              POS জমা রিসিট
            </button>
            <a
              href={buildWhatsAppUrl(
                savedDeposit.mobile,
                `প্রিয় ${savedDeposit.deposit.CollectorName}, আপনার জমাকৃত ${formatBnCurrency(
                  savedDeposit.deposit.Amount
                )} (${paymentMethodLabel(
                  savedDeposit.deposit.DepositMethod
                )}) অফিসে গৃহীত হয়েছে। রিসিট: ${savedDeposit.deposit.DepositID}।`
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp কনফার্মেশন
            </a>
            <button
              type="button"
              onClick={() => setSavedDeposit(null)}
              className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800"
            >
              বন্ধ করুন
            </button>
          </div>
        </div>
      )}

      {/* Collector Cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.collectorSummaries.map((cs) => {
          const fullCol = data.collectors.find((c) => c.CollectorID === cs.CollectorID);
          return (
            <div
              key={cs.CollectorID}
              className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <UserCheck className="h-4 w-4 text-[#0f4c5c]" />
                    <h3 className="text-base font-bold text-slate-900">{cs.Name}</h3>
                  </div>
                  <p className="mt-0.5 font-mono-num text-xs text-slate-500">
                    ইউজার: {cs.Username} · মোবাইল: {toBnDigits(cs.Mobile)}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    দায়িত্বপ্রাপ্ত এরিয়া: {cs.AssignedAreas.join(', ') || 'নেই'}
                  </p>
                </div>
                <span
                  className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                    cs.Status === 'এক্টিভ'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                >
                  {cs.Status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs tabular-nums">
                <div>
                  <span className="text-slate-500">নগদ আদায়</span>
                  <p className="font-mono-num font-bold text-slate-900">
                    {formatBnCurrency(cs.cashCollected)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">ডিজিটাল আদায়</span>
                  <p className="font-mono-num font-bold text-[#0f4c5c]">
                    {formatBnCurrency(cs.digitalCollected)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">অফিসে জমা</span>
                  <p className="font-mono-num font-bold text-emerald-700">
                    {formatBnCurrency(cs.totalDeposited)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">হাতে ক্যাশ</span>
                  <p className="font-mono-num font-bold text-amber-700">
                    {formatBnCurrency(cs.handCash)}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDepositTarget(cs);
                      setDepositAmt(String(cs.handCash > 0 ? cs.handCash : ''));
                      setDepositMethod('Cash');
                      setDepositTrx('');
                      setDepositNote('');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#0f4c5c] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#135d66]"
                  >
                    <Wallet className="h-3.5 w-3.5" />
                    জমা নিন
                  </button>
                  <button
                    type="button"
                    onClick={() => setLedgerTarget(cs)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    কালেক্টর লেজার
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {fullCol && (
                    <button
                      type="button"
                      onClick={() => openEditCollector(fullCol)}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                      title="এডিট"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteErr('');
                      setDeleteTarget(cs);
                    }}
                    className="rounded-lg border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100"
                    title="ডিলিট"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Expanded Collector Ledger */}
      {ledgerTarget && renderLedgerPanel(ledgerTarget)}

      {/* Add/Edit Collector Modal */}
      {formOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <form
            onSubmit={handleSaveCollector}
            className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-base font-bold text-slate-900">
                {editing ? 'কালেক্টর তথ্য আপডেট' : 'নতুন কালেক্টর যোগ করুন'}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3.5 overflow-y-auto p-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">নাম *</label>
                  <input
                    type="text"
                    required
                    value={formState.Name}
                    onChange={(e) => setFormState({ ...formState, Name: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">মোবাইল *</label>
                  <input
                    type="text"
                    required
                    value={formState.Mobile}
                    onChange={(e) => setFormState({ ...formState, Mobile: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">
                    ইউজারনেম *
                  </label>
                  <input
                    type="text"
                    required
                    pattern="^[A-Za-z0-9._-]{3,32}$"
                    disabled={Boolean(editing)}
                    value={formState.Username}
                    onChange={(e) => setFormState({ ...formState, Username: e.target.value })}
                    placeholder="যেমন: karim_bd"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm disabled:bg-slate-100"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    ৩–৩২ অক্ষর: ইংরেজি অক্ষর, সংখ্যা, . _ -
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">
                    {editing ? 'নতুন পাসওয়ার্ড (ঐচ্ছিক)' : 'পাসওয়ার্ড *'}
                  </label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required={!editing}
                    minLength={8}
                    value={formState.Password}
                    onChange={(e) => setFormState({ ...formState, Password: e.target.value })}
                    placeholder={
                      editing
                        ? 'পরিবর্তন করতে চাইলে ৮+ অক্ষর'
                        : 'কমপক্ষে ৮ অক্ষরের শক্ত পাসওয়ার্ড'
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    কমপক্ষে ৮ অক্ষরের শক্ত পাসওয়ার্ড
                  </p>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                  দায়িত্বপ্রাপ্ত এরিয়া নির্বাচন করুন (একাধিক সম্ভব)
                </label>
                <div className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                  {data.areas.map((a) => (
                    <label key={a.AreaID} className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-800">
                      <input
                        type="checkbox"
                        checked={formState.AssignedAreas.includes(a.AreaName)}
                        onChange={() => toggleAreaCheckbox(a.AreaName)}
                        className="h-4 w-4 rounded border-slate-300 text-[#0f4c5c]"
                      />
                      {a.AreaName}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">স্ট্যাটাস</label>
                <select
                  value={formState.Status}
                  onChange={(e) =>
                    setFormState({ ...formState, Status: e.target.value as Collector['Status'] })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="এক্টিভ">এক্টিভ</option>
                  <option value="ডি-এক্টিভ">ডি-এক্টিভ</option>
                </select>
              </div>

              {formErr && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {formErr}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium"
              >
                বাতিল
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-[#0f4c5c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#135d66]"
              >
                {saving ? 'সংরক্ষণ হচ্ছে...' : 'সংরক্ষণ করুন'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Deposit Modal */}
      {depositTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <div>
                <h3 className="text-base font-bold text-slate-900">কালেক্টরের কাছ থেকে জমা নিন</h3>
                <p className="text-xs text-slate-500">
                  {depositTarget.Name} · হাতে ক্যাশ: {formatBnCurrency(depositTarget.handCash)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDepositTarget(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 p-5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  জমার পরিমাণ (৳) *
                </label>
                <input
                  type="number"
                  min={1}
                  value={depositAmt}
                  onChange={(e) => setDepositAmt(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">জমার মাধ্যম</label>
                <select
                  value={depositMethod}
                  onChange={(e) =>
                    setDepositMethod(e.target.value as Exclude<PaymentMethod, 'Rocket'>)
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="Cash">নগদ (Cash)</option>
                  <option value="bKash">বিকাশ (bKash)</option>
                  <option value="Nagad">নগদ (Nagad)</option>
                  <option value="Bank">ব্যাংক (Bank)</option>
                </select>
              </div>
              {depositMethod !== 'Cash' && (
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">TrxID</label>
                  <input
                    type="text"
                    value={depositTrx}
                    onChange={(e) => setDepositTrx(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-num text-sm"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">নোট</label>
                <input
                  type="text"
                  value={depositNote}
                  onChange={(e) => setDepositNote(e.target.value)}
                  placeholder="জমা সংক্রান্ত নোট"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setDepositTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium"
              >
                বাতিল
              </button>
              <button
                type="button"
                disabled={!Number(depositAmt)}
                onClick={() => setConfirmDepositOpen(true)}
                className="rounded-lg bg-[#0f4c5c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#135d66]"
              >
                জমা নিশ্চিত করুন
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDepositOpen}
        title="কালেক্টর জমা নিশ্চিত করুন"
        items={[
          { label: 'কালেক্টর', value: depositTarget?.Name || '' },
          { label: 'জমার পরিমাণ', value: formatBnCurrency(Number(depositAmt)) },
          { label: 'মাধ্যম', value: paymentMethodLabel(depositMethod) },
        ]}
        loading={depositing}
        onConfirm={handleCommitDeposit}
        onCancel={() => setConfirmDepositOpen(false)}
      />

      <AdminPasswordModal
        open={Boolean(deleteTarget)}
        title={`কালেক্টর ডিলিট: ${deleteTarget?.Name || ''}`}
        description="এই কালেক্টরকে ডিলিট করতে অ্যাডমিন পাসওয়ার্ড দিন।"
        error={deleteErr}
        loading={deleting}
        onConfirm={handleDeleteCollector}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};

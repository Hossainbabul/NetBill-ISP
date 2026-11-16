import React, { useMemo, useState } from 'react';
import {
  FileText,
  Link2,
  MessageCircle,
  MoreVertical,
  Plus,
  Printer,
  Receipt,
  Search,
  Trash2,
  Edit3,
  Power,
  X,
} from 'lucide-react';
import { api } from '../api';
import { Customer, DashboardPayload, ServiceType, SessionUser } from '../types';
import {
  CABLE_PACKAGES,
  INTERNET_PACKAGES,
  buildPayPortalUrl,
  buildWhatsAppUrl,
  formatBnCurrency,
  getMonthLabelBn,
  getTodayStr,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';
import { AdminPasswordModal, ConfirmDialog } from './ConfirmDialog';
import { PrintPayload } from './PrintPreviewModal';

interface CustomersViewProps {
  data: DashboardPayload;
  user: SessionUser;
  onRefresh: () => Promise<void>;
  onCollect: (customer: Customer) => void;
  onPrint: (payload: PrintPayload) => void;
}

export const CustomersView: React.FC<CustomersViewProps> = ({
  data,
  user,
  onRefresh,
  onCollect,
  onPrint,
}) => {
  const isAdmin = user.role === 'Admin';
  const [search, setSearch] = useState('');
  const [areaFilter, setAreaFilter] = useState('ALL');
  const [pkgFilter, setPkgFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'এক্টিভ' | 'ডি-এক্টিভ'>('ALL');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Add/Edit Modal State
  const [formOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [formState, setFormState] = useState({
    CustomerID: '',
    Name: '',
    Mobile: '',
    Area: data.areas[0]?.AreaName || '',
    Address: '',
    ServiceType: 'Internet' as ServiceType,
    Package: '30 Mbps',
    MonthlyBill: '800',
    ConnectionDate: getTodayStr(),
    Status: 'এক্টিভ' as Customer['Status'],
    OpeningBalance: '0',
    Note: '',
  });
  const [formError, setFormError] = useState('');
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Ledger Modal
  const [ledgerCustomer, setLedgerCustomer] = useState<Customer | null>(null);

  // Delete Modal
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const dueMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of data.bills) {
      if (b.DueAmount > 0) {
        map.set(b.CustomerID, (map.get(b.CustomerID) || 0) + b.DueAmount);
      }
    }
    return map;
  }, [data.bills]);

  const allPackages = useMemo(() => {
    const set = new Set<string>([...INTERNET_PACKAGES, ...CABLE_PACKAGES]);
    data.customers.forEach((c) => set.add(c.Package));
    return Array.from(set);
  }, [data.customers]);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.customers.filter((c) => {
      if (areaFilter !== 'ALL' && c.Area !== areaFilter) return false;
      if (pkgFilter !== 'ALL' && c.Package !== pkgFilter) return false;
      if (statusFilter !== 'ALL' && c.Status !== statusFilter) return false;
      if (q) {
        const hay = `${c.CustomerID} ${c.Name} ${c.Mobile} ${c.Area}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data.customers, areaFilter, pkgFilter, statusFilter, search]);

  const openAddModal = () => {
    const nextNum = 1001 + data.customers.length + Math.floor(Math.random() * 50);
    setEditingCustomer(null);
    setFormError('');
    setFormState({
      CustomerID: `NB-${nextNum}`,
      Name: '',
      Mobile: '',
      Area: data.areas[0]?.AreaName || '',
      Address: '',
      ServiceType: 'Internet',
      Package: '30 Mbps',
      MonthlyBill: '800',
      ConnectionDate: getTodayStr(),
      Status: 'এক্টিভ',
      OpeningBalance: '0',
      Note: '',
    });
    setFormOpen(true);
  };

  const openEditModal = (c: Customer) => {
    setEditingCustomer(c);
    setFormError('');
    setFormState({
      CustomerID: c.CustomerID,
      Name: c.Name,
      Mobile: c.Mobile,
      Area: c.Area,
      Address: c.Address,
      ServiceType: c.ServiceType,
      Package: c.Package,
      MonthlyBill: String(c.MonthlyBill),
      ConnectionDate: c.ConnectionDate,
      Status: c.Status,
      OpeningBalance: String(c.OpeningBalance),
      Note: c.Note,
    });
    setOpenMenuId(null);
    setFormOpen(true);
  };

  const handleFormPreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!formState.CustomerID.trim() || !formState.Name.trim() || !formState.Mobile.trim()) {
      setFormError('গ্রাহক আইডি, নাম এবং মোবাইল নম্বর আবশ্যক।');
      return;
    }
    setConfirmSaveOpen(true);
  };

  const handleCommitSave = async () => {
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        ...formState,
        MonthlyBill: Number(formState.MonthlyBill),
        OpeningBalance: Number(formState.OpeningBalance || 0),
      };
      if (editingCustomer) {
        await api.updateCustomer(editingCustomer.CustomerID, payload);
      } else {
        await api.createCustomer(payload);
      }
      setConfirmSaveOpen(false);
      setFormOpen(false);
      await onRefresh();
    } catch (err) {
      setConfirmSaveOpen(false);
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (c: Customer) => {
    setOpenMenuId(null);
    await api.toggleCustomerStatus(c.CustomerID);
    await onRefresh();
  };

  const handleConfirmDelete = async (adminPassword: string) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api.deleteCustomer(deleteTarget.CustomerID, adminPassword);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const getPayLinkWa = (c: Customer) => {
    const due = dueMap.get(c.CustomerID) || 0;
    const payLink = buildPayPortalUrl(c.CustomerID);
    const text = `আসসালামু আলাইকুম ${c.Name} (আইডি: ${c.CustomerID}), আপনার বর্তমান মোট বকেয়া ${formatBnCurrency(
      due
    )}। ঘরে বসে বিকাশ/নগদ/রকেট বা ব্যাংকের মাধ্যমে বিল পরিশোধ করতে নিচের লিংকে ক্লিক করুন:\n${payLink}\n- ${
      data.settings.CompanyName
    }`;
    return buildWhatsAppUrl(c.Mobile, text);
  };

  const getRegReceiptWa = (c: Customer) => {
    const text = `স্বাগতম ${c.Name}! ${data.settings.CompanyName}-এ আপনার সংযোগ সফলভাবে নিবন্ধিত হয়েছে।\nগ্রাহক আইডি: ${
      c.CustomerID
    }\nএরিয়া: ${c.Area}\nপ্যাকেজ: ${c.Package}\nমাসিক বিল: ${formatBnCurrency(
      c.MonthlyBill
    )}\nঅনলাইন বিল পেমেন্ট লিংক: ${buildPayPortalUrl(c.CustomerID)}`;
    return buildWhatsAppUrl(c.Mobile, text);
  };

  const ledgerEntries = useMemo(() => {
    if (!ledgerCustomer) return { bills: [], collections: [], totalDue: 0, totalPaid: 0 };
    const custBills = data.bills.filter((b) => b.CustomerID === ledgerCustomer.CustomerID);
    const custCols = data.collections.filter((c) => c.CustomerID === ledgerCustomer.CustomerID);
    return {
      bills: custBills,
      collections: custCols,
      totalDue: custBills.reduce((s, b) => s + b.DueAmount, 0),
      totalPaid: custCols.reduce((s, c) => s + c.Amount, 0),
    };
  }, [ledgerCustomer, data.bills, data.collections]);

  return (
    <div className="space-y-5">
      {/* Header & Filter Bar */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-lg font-bold text-slate-900">গ্রাহক ব্যবস্থাপনা</h2>
            <p className="text-xs text-slate-500">
              মোট {toBnDigits(filteredCustomers.length)} জন গ্রাহক প্রদর্শিত হচ্ছে
            </p>
          </div>
          <button
            type="button"
            onClick={openAddModal}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            নতুন গ্রাহক যোগ করুন
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="নাম, আইডি বা মোবাইল দিয়ে খুঁজুন"
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
            />
          </div>

          <select
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
          >
            <option value="ALL">সব এরিয়া</option>
            {data.areas.map((a) => (
              <option key={a.AreaID} value={a.AreaName}>
                {a.AreaName}
              </option>
            ))}
          </select>

          <select
            value={pkgFilter}
            onChange={(e) => setPkgFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-[#0f4c5c] focus:outline-none"
          >
            <option value="ALL">সব প্যাকেজ</option>
            {allPackages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(['ALL', 'এক্টিভ', 'ডি-এক্টিভ'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  statusFilter === st
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st === 'ALL' ? 'সব' : st}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Customer List Table */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-visible">
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="px-4 py-3 text-left font-semibold">আইডি ও নাম</th>
                <th className="px-4 py-3 text-left font-semibold">এরিয়া ও সার্ভিস</th>
                <th className="px-4 py-3 text-left font-semibold">প্যাকেজ</th>
                <th className="px-4 py-3 text-right font-semibold">মাসিক বিল</th>
                <th className="px-4 py-3 text-right font-semibold">মোট বকেয়া</th>
                <th className="px-4 py-3 text-center font-semibold">স্ট্যাটাস</th>
                <th className="px-4 py-3 text-right font-semibold">অ্যাকশন</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {filteredCustomers.map((c) => {
                const due = dueMap.get(c.CustomerID) || 0;
                const menuOpen = openMenuId === c.CustomerID;
                return (
                  <tr key={c.CustomerID} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">{c.Name}</p>
                      <p className="font-mono-num text-xs text-slate-500">
                        {c.CustomerID} · {toBnDigits(c.Mobile)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{c.Area}</p>
                      <p className="text-xs text-slate-500">
                        {c.ServiceType === 'Internet' ? 'ব্রডব্যান্ড ইন্টারনেট' : 'ক্যাবল টিভি (ডিস)'}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-800">{c.Package}</td>
                    <td className="px-4 py-3 text-right font-mono-num font-semibold text-slate-900">
                      {formatBnCurrency(c.MonthlyBill)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono-num font-bold">
                      <span className={due > 0 ? 'text-red-600' : 'text-emerald-600'}>
                        {formatBnCurrency(due)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${
                          c.Status === 'এক্টিভ'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-red-200 bg-red-50 text-red-700'
                        }`}
                      >
                        {c.Status}
                      </span>
                    </td>
                    <td className="relative px-4 py-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onCollect(c)}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#0f4c5c] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#135d66] whitespace-nowrap"
                        >
                          <Receipt className="h-3.5 w-3.5" />
                          বিল নিন
                        </button>
                        <button
                          type="button"
                          onClick={() => setOpenMenuId(menuOpen ? null : c.CustomerID)}
                          className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100"
                          aria-label="আরও অপশন"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      </div>

                      {menuOpen && (
                        <div className="absolute right-4 top-12 z-30 w-60 rounded-xl border border-slate-200 bg-white py-1.5 text-left shadow-lg">
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              onCollect(c);
                            }}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Receipt className="h-3.5 w-3.5 text-[#0f4c5c]" />
                            বিল গ্রহণ করুন
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              setLedgerCustomer(c);
                            }}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <FileText className="h-3.5 w-3.5 text-slate-600" />
                            গ্রাহক লেজার ও প্রিন্ট
                          </button>

                          <a
                            href={getPayLinkWa(c)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setOpenMenuId(null)}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                          >
                            <Link2 className="h-3.5 w-3.5" />
                            ই-বিল পেমেন্ট লিংক (WhatsApp)
                          </a>

                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              onPrint({
                                kind: 'pos-registration',
                                receiptId: `REG-${c.CustomerID}`,
                                date: c.ConnectionDate,
                                customerOrCollectorName: c.Name,
                                customerId: c.CustomerID,
                                mobile: c.Mobile,
                                area: c.Area,
                                packageName: c.Package,
                                amount: c.MonthlyBill,
                                note: c.Address,
                              });
                            }}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Printer className="h-3.5 w-3.5 text-slate-600" />
                            প্রিন্ট (POS স্লিপ)
                          </button>

                          <a
                            href={getRegReceiptWa(c)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setOpenMenuId(null)}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                            WhatsApp এ নিবন্ধন রিসিভ
                          </a>

                          <div className="my-1 border-t border-slate-100" />

                          <button
                            type="button"
                            onClick={() => openEditModal(c)}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Edit3 className="h-3.5 w-3.5 text-slate-600" />
                            তথ্য এডিট করুন
                          </button>

                          <button
                            type="button"
                            onClick={() => handleToggleStatus(c)}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50"
                          >
                            <Power className="h-3.5 w-3.5" />
                            স্ট্যাটাস পরিবর্তন ({c.Status === 'এক্টিভ' ? 'ডি-এক্টিভ' : 'এক্টিভ'})
                          </button>

                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                setDeleteError('');
                                setDeleteTarget(c);
                              }}
                              className="flex w-full items-center gap-2 px-3.5 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              ডিলিট করুন
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}

              {filteredCustomers.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">
                    কোনো গ্রাহক পাওয়া যায়নি। নতুন গ্রাহক যোগ করুন অথবা ফিল্টার পরিবর্তন করুন।
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Add / Edit Customer Modal */}
      {formOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <form
            onSubmit={handleFormPreSubmit}
            className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-base font-bold text-slate-900">
                {editingCustomer ? 'গ্রাহকের তথ্য পরিবর্তন' : 'নতুন গ্রাহক নিবন্ধন'}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3.5 overflow-y-auto px-5 py-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">গ্রাহক আইডি *</label>
                <input
                  type="text"
                  required
                  disabled={Boolean(editingCustomer)}
                  value={formState.CustomerID}
                  onChange={(e) => setFormState({ ...formState, CustomerID: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm disabled:bg-slate-100"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">গ্রাহকের নাম *</label>
                <input
                  type="text"
                  required
                  value={formState.Name}
                  onChange={(e) => setFormState({ ...formState, Name: e.target.value })}
                  placeholder="সম্পূর্ণ নাম লিখুন"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  মোবাইল / WhatsApp *
                </label>
                <input
                  type="text"
                  required
                  value={formState.Mobile}
                  onChange={(e) => setFormState({ ...formState, Mobile: e.target.value })}
                  placeholder="017..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">এরিয়া *</label>
                <select
                  value={formState.Area}
                  onChange={(e) => setFormState({ ...formState, Area: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {data.areas.map((a) => (
                    <option key={a.AreaID} value={a.AreaName}>
                      {a.AreaName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">সার্ভিসের ধরন</label>
                <select
                  disabled={Boolean(editingCustomer) && !isAdmin}
                  value={formState.ServiceType}
                  onChange={(e) => {
                    const st = e.target.value as ServiceType;
                    setFormState({
                      ...formState,
                      ServiceType: st,
                      Package: st === 'Internet' ? '30 Mbps' : 'Cable TV Basic',
                      MonthlyBill: st === 'Internet' ? '800' : '300',
                    });
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                >
                  <option value="Internet">ব্রডব্যান্ড ইন্টারনেট (ISP)</option>
                  <option value="Cable TV">ক্যাবল টিভি (ডিস লাইন)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">প্যাকেজ</label>
                <select
                  disabled={Boolean(editingCustomer) && !isAdmin}
                  value={formState.Package}
                  onChange={(e) => setFormState({ ...formState, Package: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                >
                  {(formState.ServiceType === 'Internet' ? INTERNET_PACKAGES : CABLE_PACKAGES).map(
                    (p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    )
                  )}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">মাসিক বিল (৳) *</label>
                <input
                  type="number"
                  min={0}
                  required
                  disabled={Boolean(editingCustomer) && !isAdmin}
                  value={formState.MonthlyBill}
                  onChange={(e) => setFormState({ ...formState, MonthlyBill: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm disabled:bg-slate-100 disabled:text-slate-500"
                />
                {Boolean(editingCustomer) && !isAdmin && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    সার্ভিস, প্যাকেজ ও বিল শুধু অ্যাডমিন পরিবর্তন করতে পারবেন
                  </p>
                )}
              </div>

              {!editingCustomer && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      সংযোগের তারিখ
                    </label>
                    <input
                      type="date"
                      value={formState.ConnectionDate}
                      onChange={(e) =>
                        setFormState({ ...formState, ConnectionDate: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm"
                    />
                  </div>
                  {isAdmin && (
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-700">
                        পূর্বের বকেয়া (Opening Balance)
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={formState.OpeningBalance}
                        onChange={(e) =>
                          setFormState({ ...formState, OpeningBalance: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm"
                      />
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">স্ট্যাটাস</label>
                <select
                  value={formState.Status}
                  onChange={(e) =>
                    setFormState({ ...formState, Status: e.target.value as Customer['Status'] })
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="এক্টিভ">এক্টিভ</option>
                  <option value="ডি-এক্টিভ">ডি-এক্টিভ</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-semibold text-slate-700">ঠিকানা</label>
                <input
                  type="text"
                  value={formState.Address}
                  onChange={(e) => setFormState({ ...formState, Address: e.target.value })}
                  placeholder="বাসা/ফ্ল্যাট/রোড"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-semibold text-slate-700">নোট</label>
                <input
                  type="text"
                  value={formState.Note}
                  onChange={(e) => setFormState({ ...formState, Note: e.target.value })}
                  placeholder="ঐচ্ছিক মন্তব্য"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              {formError && (
                <p className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {formError}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
              >
                বাতিল
              </button>
              <button
                type="submit"
                className="rounded-lg bg-[#0f4c5c] px-4 py-2 text-sm font-semibold text-white hover:bg-[#135d66]"
              >
                {editingCustomer ? 'আপডেট করুন' : 'সংরক্ষণ করুন'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Customer Ledger Modal */}
      {ledgerCustomer && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  গ্রাহক লেজার — {ledgerCustomer.Name}
                </h3>
                <p className="text-xs text-slate-500">
                  আইডি: {ledgerCustomer.CustomerID} · {ledgerCustomer.Area} · {ledgerCustomer.Package}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onPrint({
                      kind: 'a4-report',
                      title: `গ্রাহক লেজার: ${ledgerCustomer.Name} (${ledgerCustomer.CustomerID})`,
                      subtitle: `এরিয়া: ${ledgerCustomer.Area} · প্যাকেজ: ${ledgerCustomer.Package} · মোবাইল: ${ledgerCustomer.Mobile}`,
                      summaryRows: [
                        { label: 'মাসিক বিল', value: formatBnCurrency(ledgerCustomer.MonthlyBill) },
                        { label: 'মোট পরিশোধিত', value: formatBnCurrency(ledgerEntries.totalPaid) },
                        { label: 'বর্তমান বকেয়া', value: formatBnCurrency(ledgerEntries.totalDue) },
                        { label: 'স্ট্যাটাস', value: ledgerCustomer.Status },
                      ],
                      columns: [
                        { key: 'date', label: 'তারিখ' },
                        { key: 'month', label: 'বিলের মাস' },
                        { key: 'receipt', label: 'রিসিট / ধরন' },
                        { key: 'method', label: 'মাধ্যম ও TrxID' },
                        { key: 'amount', label: 'টাকা', align: 'right' },
                      ],
                      rows: ledgerEntries.collections.map((col) => ({
                        date: toBnDigits(col.Date),
                        month: getMonthLabelBn(col.BillingMonth),
                        receipt: col.ReceiptID,
                        method: `${paymentMethodLabel(col.PaymentMethod)}${col.TrxID ? ` (${col.TrxID})` : ''}`,
                        amount: formatBnCurrency(col.Amount),
                      })),
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0f4c5c] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#135d66]"
                >
                  <Printer className="h-3.5 w-3.5" />
                  A4 প্রিন্ট
                </button>
                <button
                  type="button"
                  onClick={() => setLedgerCustomer(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="space-y-5 overflow-y-auto p-5">
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <span className="text-slate-500">মাসিক বিল</span>
                  <p className="mt-1 font-mono-num text-base font-bold text-slate-900">
                    {formatBnCurrency(ledgerCustomer.MonthlyBill)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <span className="text-slate-500">মোট পরিশোধিত</span>
                  <p className="mt-1 font-mono-num text-base font-bold text-emerald-700">
                    {formatBnCurrency(ledgerEntries.totalPaid)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <span className="text-slate-500">বর্তমান বকেয়া</span>
                  <p className="mt-1 font-mono-num text-base font-bold text-red-600">
                    {formatBnCurrency(ledgerEntries.totalDue)}
                  </p>
                </div>
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-slate-900">মাসিক বিলের তালিকা</h4>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">বিলের মাস</th>
                        <th className="px-3 py-2 text-right">বিল</th>
                        <th className="px-3 py-2 text-right">পরিশোধ</th>
                        <th className="px-3 py-2 text-right">বকেয়া</th>
                        <th className="px-3 py-2 text-right">অবস্থা</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 tabular-nums">
                      {ledgerEntries.bills.map((b) => (
                        <tr key={b.BillID}>
                          <td className="px-3 py-2 font-medium text-slate-900">{b.MonthLabel}</td>
                          <td className="px-3 py-2 text-right">{formatBnCurrency(b.Amount)}</td>
                          <td className="px-3 py-2 text-right text-emerald-700">
                            {formatBnCurrency(b.PaidAmount)}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-red-600">
                            {formatBnCurrency(b.DueAmount)}
                          </td>
                          <td className="px-3 py-2 text-right">{b.Status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-slate-900">পেমেন্ট হিস্ট্রি</h4>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">রিসিট ও তারিখ</th>
                        <th className="px-3 py-2 text-left">মাস</th>
                        <th className="px-3 py-2 text-left">মাধ্যম ও TrxID</th>
                        <th className="px-3 py-2 text-left">আদায়কারী</th>
                        <th className="px-3 py-2 text-right">টাকা</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 tabular-nums">
                      {ledgerEntries.collections.map((c) => (
                        <tr key={c.ReceiptID}>
                          <td className="px-3 py-2">
                            <span className="font-mono-num font-semibold">{c.ReceiptID}</span>
                            <span className="block text-[11px] text-slate-500">
                              {toBnDigits(c.Date)}
                            </span>
                          </td>
                          <td className="px-3 py-2">{getMonthLabelBn(c.BillingMonth)}</td>
                          <td className="px-3 py-2">
                            {paymentMethodLabel(c.PaymentMethod)}
                            {c.TrxID && (
                              <span className="block font-mono-num text-[11px] text-slate-500">
                                {c.TrxID}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">{c.CollectedBy}</td>
                          <td className="px-3 py-2 text-right font-bold text-emerald-700">
                            {formatBnCurrency(c.Amount)}
                          </td>
                        </tr>
                      ))}
                      {ledgerEntries.collections.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                            এখনো কোনো পেমেন্ট পাওয়া যায়নি।
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmSaveOpen}
        title={editingCustomer ? 'গ্রাহক তথ্য আপডেট নিশ্চিত করুন' : 'নতুন গ্রাহক নিবন্ধন নিশ্চিত করুন'}
        items={[
          { label: 'গ্রাহক আইডি', value: formState.CustomerID },
          { label: 'নাম', value: formState.Name },
          { label: 'মোবাইল', value: formState.Mobile },
          { label: 'এরিয়া', value: formState.Area },
          { label: 'প্যাকেজ', value: formState.Package },
          { label: 'মাসিক বিল', value: formatBnCurrency(Number(formState.MonthlyBill)) },
          ...(!editingCustomer && Number(formState.OpeningBalance) > 0
            ? [
                {
                  label: 'পূর্বের বকেয়া',
                  value: formatBnCurrency(Number(formState.OpeningBalance)),
                },
              ]
            : []),
        ]}
        loading={saving}
        onConfirm={handleCommitSave}
        onCancel={() => setConfirmSaveOpen(false)}
      />

      <AdminPasswordModal
        open={Boolean(deleteTarget)}
        title={`গ্রাহক ডিলিট: ${deleteTarget?.Name || ''} (${deleteTarget?.CustomerID || ''})`}
        description="এই গ্রাহককে ডিলিট করলে তার সকল বকেয়া বিলের হিসাব মুছে যাবে।"
        error={deleteError}
        loading={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};

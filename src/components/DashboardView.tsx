import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CreditCard,
  TrendingUp,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import { Customer, DashboardPayload, SessionUser } from '../types';
import {
  formatBnCurrency,
  getCurrentMonthStr,
  getLastNMonths,
  getMonthLabelBn,
  paymentMethodBadgeClass,
  paymentMethodLabel,
  toBnDigits,
} from '../utils/bengali';

interface DashboardViewProps {
  data: DashboardPayload;
  user: SessionUser;
  onNavigateBilling: (subTab?: 'collections' | 'generate' | 'epay') => void;
  onQuickCollect: (customer: Customer) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
  user,
  onNavigateBilling,
  onQuickCollect,
}) => {
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthStr());
  const [hoveredMonth, setHoveredMonth] = useState<string | null>(null);

  const isAdmin = user.role === 'Admin';

  const metrics = useMemo(() => {
    const monthBills = data.bills.filter((b) => b.BillingMonth === selectedMonth);
    const monthlyBillTotal = monthBills.reduce((s, b) => s + b.Amount, 0);

    const monthCollections = data.collections.filter(
      (c) => c.BillingMonth === selectedMonth || c.Date.startsWith(selectedMonth)
    );
    const monthCollectedTotal = monthCollections.reduce((s, c) => s + c.Amount, 0);
    const receiptCount = monthCollections.length;

    const totalDue = data.bills.reduce((s, b) => s + b.DueAmount, 0);
    const collectionRate =
      monthlyBillTotal > 0
        ? Math.min(100, Math.round((monthCollectedTotal / monthlyBillTotal) * 100))
        : 0;

    const collectorHandCash = data.collectorSummaries.reduce((s, c) => s + c.handCash, 0);
    const pendingEPayments = data.ePayments.filter((e) => e.Status === 'Pending');
    const pendingEAmount = pendingEPayments.reduce((s, e) => s + e.Amount, 0);

    return {
      monthlyBillTotal,
      monthCollectedTotal,
      receiptCount,
      totalDue,
      collectionRate,
      collectorHandCash,
      pendingECount: pendingEPayments.length,
      pendingEAmount,
    };
  }, [data, selectedMonth]);

  // 6-month Bar Chart data
  const sixMonthsChart = useMemo(() => {
    const months = getLastNMonths(6, selectedMonth);
    const points = months.map((ym) => {
      const total = data.collections
        .filter((c) => c.BillingMonth === ym || c.Date.startsWith(ym))
        .reduce((s, c) => s + c.Amount, 0);
      return { ym, label: getMonthLabelBn(ym).split(' ')[0], fullLabel: getMonthLabelBn(ym), total };
    });
    const maxVal = Math.max(1000, ...points.map((p) => p.total));
    return { points, maxVal };
  }, [data.collections, selectedMonth]);

  // Area breakdown
  const areaBreakdown = useMemo(() => {
    return data.areas.map((area) => {
      const areaCusts = data.customers.filter((c) => c.Area === area.AreaName);
      const activeCount = areaCusts.filter((c) => c.Status === 'এক্টিভ').length;
      const custIds = new Set(areaCusts.map((c) => c.CustomerID));
      const due = data.bills
        .filter((b) => custIds.has(b.CustomerID))
        .reduce((s, b) => s + b.DueAmount, 0);
      const paid = data.collections
        .filter((c) => c.Area === area.AreaName && (c.BillingMonth === selectedMonth || c.Date.startsWith(selectedMonth)))
        .reduce((s, c) => s + c.Amount, 0);

      return {
        areaName: area.AreaName,
        totalCustomers: areaCusts.length,
        activeCount,
        due,
        paid,
      };
    });
  }, [data, selectedMonth]);

  // Package breakdown
  const packageBreakdown = useMemo(() => {
    const map = new Map<
      string,
      { pkg: string; count: number; monthlyRevenue: number; custIds: Set<string> }
    >();
    for (const c of data.customers) {
      const entry = map.get(c.Package) || {
        pkg: c.Package,
        count: 0,
        monthlyRevenue: 0,
        custIds: new Set<string>(),
      };
      entry.count += 1;
      if (c.Status === 'এক্টিভ') {
        entry.monthlyRevenue += c.MonthlyBill;
      }
      entry.custIds.add(c.CustomerID);
      map.set(c.Package, entry);
    }

    return Array.from(map.values())
      .map((entry) => {
        const due = data.bills
          .filter((b) => entry.custIds.has(b.CustomerID))
          .reduce((s, b) => s + b.DueAmount, 0);
        return {
          pkg: entry.pkg,
          count: entry.count,
          monthlyRevenue: entry.monthlyRevenue,
          due,
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // Top Dues
  const topDues = useMemo(() => {
    const dueByCust = new Map<string, number>();
    for (const b of data.bills) {
      if (b.DueAmount > 0) {
        dueByCust.set(b.CustomerID, (dueByCust.get(b.CustomerID) || 0) + b.DueAmount);
      }
    }
    return data.customers
      .map((c) => ({ customer: c, due: dueByCust.get(c.CustomerID) || 0 }))
      .filter((x) => x.due > 0)
      .sort((a, b) => b.due - a.due)
      .slice(0, 6);
  }, [data]);

  const recentCollections = useMemo(() => data.collections.slice(0, 7), [data.collections]);

  return (
    <div className="space-y-6">
      {/* Greeting & Month Hero Bar */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div>
            <p className="text-xs font-medium text-slate-500">
              স্বাগতম, {user.name} · {isAdmin ? 'অ্যাডমিনিস্ট্রেটর প্যানেল' : `দায়িত্বপ্রাপ্ত এরিয়া: ${user.assignedAreas.join(', ')}`}
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">
              {getMonthLabelBn(selectedMonth)} — মোট আদায়{' '}
              <span className="font-mono-num text-[#0f4c5c]">
                {formatBnCurrency(metrics.monthCollectedTotal)}
              </span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 tabular-nums">
              <span>
                আদায়ের হার: <strong className="text-emerald-700">{toBnDigits(metrics.collectionRate)}%</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                মাসিক বিল: <strong className="text-slate-900">{formatBnCurrency(metrics.monthlyBillTotal)}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                রিসিট সংখ্যা: <strong className="text-slate-900">{toBnDigits(metrics.receiptCount)}টি</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                সর্বমোট বকেয়া: <strong className="text-red-600">{formatBnCurrency(metrics.totalDue)}</strong>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2">
              <Calendar className="h-4 w-4 text-slate-500" />
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="bg-transparent font-mono-num text-xs font-medium text-slate-800 focus:outline-none"
              />
            </div>

            {isAdmin && (
              <button
                type="button"
                onClick={() => onNavigateBilling('generate')}
                className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#135d66] whitespace-nowrap shrink-0"
              >
                <Zap className="h-4 w-4" />
                বিল জেনারেট
              </button>
            )}
          </div>
        </div>
      </section>

      {/* 4 KPI Cards */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>মোট বকেয়া</span>
            <Users className="h-4 w-4 text-red-500" />
          </div>
          <p className="mt-2 font-mono-num text-2xl font-bold text-red-600">
            {formatBnCurrency(metrics.totalDue)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            সক্রিয় গ্রাহক: {toBnDigits(data.customers.filter((c) => c.Status === 'এক্টিভ').length)} জন
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>কালেক্টরের কাছে জমা</span>
            <Wallet className="h-4 w-4 text-amber-600" />
          </div>
          <p className="mt-2 font-mono-num text-2xl font-bold text-slate-900">
            {formatBnCurrency(metrics.collectorHandCash)}
          </p>
          <p className="mt-1 text-xs text-slate-500">হাতে থাকা নগদ ক্যাশ (জমার অপেক্ষায়)</p>
        </div>

        {isAdmin ? (
          <button
            type="button"
            onClick={() => onNavigateBilling('epay')}
            className="rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-[#0f4c5c] hover:bg-teal-50/20"
          >
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>অপেক্ষমাণ ই-পেমেন্ট</span>
              <CreditCard className="h-4 w-4 text-[#E2136E]" />
            </div>
            <p className="mt-2 font-mono-num text-2xl font-bold text-slate-900">
              {toBnDigits(metrics.pendingECount)}টি · {formatBnCurrency(metrics.pendingEAmount)}
            </p>
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[#0f4c5c]">
              যাচাই করতে ক্লিক করুন <ArrowRight className="h-3.5 w-3.5" />
            </p>
          </button>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>আমার ডিজিটাল আদায়</span>
              <CreditCard className="h-4 w-4 text-[#0f4c5c]" />
            </div>
            <p className="mt-2 font-mono-num text-2xl font-bold text-slate-900">
              {formatBnCurrency(data.collectorSummaries[0]?.digitalCollected || 0)}
            </p>
            <p className="mt-1 text-xs text-slate-500">সরাসরি কোম্পানি অ্যাকাউন্টে জমা</p>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>{isAdmin ? 'বর্তমান ফান্ড ব্যালেন্স' : 'আমার অফিসে জমা'}</span>
            <TrendingUp className="h-4 w-4 text-emerald-600" />
          </div>
          {isAdmin ? (
            <>
              <p className="mt-2 font-mono-num text-2xl font-bold text-emerald-700">
                {formatBnCurrency(data.accountBalances.netBalance)}
              </p>
              <p className="mt-1 text-[11px] text-slate-600 tabular-nums">
                ক্যাশ {formatBnCurrency(data.accountBalances.Cash)} · বিকাশ{' '}
                {formatBnCurrency(data.accountBalances.bKash)} · নগদ{' '}
                {formatBnCurrency(data.accountBalances.Nagad)} · ব্যাংক{' '}
                {formatBnCurrency(data.accountBalances.Bank)}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 font-mono-num text-2xl font-bold text-emerald-700">
                {formatBnCurrency(data.collectorSummaries[0]?.totalDeposited || 0)}
              </p>
              <p className="mt-1 text-xs text-slate-500">অফিসে মোট জমাকৃত ক্যাশ</p>
            </>
          )}
        </div>
      </section>

      {/* Chart + Top Dues */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* 6-Month Collection Bar Chart */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-7">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900">গত ৬ মাসের আদায়</h3>
              <p className="text-xs text-slate-500">মাসভিত্তিক বিল আদায়ের তুলনামূলক চিত্র</p>
            </div>
            {hoveredMonth && (
              <span className="font-mono-num text-xs font-semibold text-[#0f4c5c]">
                {hoveredMonth}
              </span>
            )}
          </div>

          <div className="mt-6 flex h-56 items-end justify-between gap-3 border-b border-slate-200 pb-3 pt-4">
            {sixMonthsChart.points.map((pt) => {
              const heightPct = Math.max(6, Math.round((pt.total / sixMonthsChart.maxVal) * 100));
              return (
                <div
                  key={pt.ym}
                  onMouseEnter={() => setHoveredMonth(`${pt.fullLabel}: ${formatBnCurrency(pt.total)}`)}
                  onMouseLeave={() => setHoveredMonth(null)}
                  className="group flex flex-1 flex-col items-center justify-end h-full"
                >
                  <span className="mb-1.5 font-mono-num text-[11px] font-semibold text-slate-700 tabular-nums">
                    {formatBnCurrency(pt.total)}
                  </span>
                  <div className="flex w-full max-w-[44px] flex-1 items-end">
                    <div
                      style={{ height: `${heightPct}%` }}
                      className="w-full rounded-t-md bg-[#0f4c5c] transition-opacity group-hover:bg-[#135d66]"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between gap-3 text-center">
            {sixMonthsChart.points.map((pt) => (
              <span key={pt.ym} className="flex-1 text-xs font-medium text-slate-600 truncate">
                {pt.label}
              </span>
            ))}
          </div>
        </section>

        {/* Top Dues */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5">
          <h3 className="text-base font-semibold text-slate-900">সর্বোচ্চ বকেয়া</h3>
          <p className="text-xs text-slate-500">অগ্রাধিকার ভিত্তিতে আদায়যোগ্য বকেয়া তালিকা</p>

          <div className="mt-4 divide-y divide-slate-100">
            {topDues.map(({ customer, due }) => (
              <div key={customer.CustomerID} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{customer.Name}</p>
                  <p className="truncate text-xs text-slate-500">
                    <span className="font-mono-num">{customer.CustomerID}</span> · {customer.Area}
                  </p>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="font-mono-num text-sm font-bold text-red-600">
                    {formatBnCurrency(due)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onQuickCollect(customer)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-[#0f4c5c] hover:border-[#0f4c5c] hover:bg-teal-50/40"
                  >
                    আদায়
                  </button>
                </div>
              </div>
            ))}
            {topDues.length === 0 && (
              <p className="py-8 text-center text-sm text-slate-500">কোনো বকেয়া নেই।</p>
            )}
          </div>
        </section>
      </div>

      {/* Area & Package Breakdown Tables */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-slate-900">এরিয়া ভিত্তিক হিসাব</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 text-left font-semibold">এরিয়া</th>
                  <th className="py-2 text-right font-semibold">গ্রাহক</th>
                  <th className="py-2 text-right font-semibold">এক্টিভ</th>
                  <th className="py-2 text-right font-semibold">বকেয়া</th>
                  <th className="py-2 text-right font-semibold">আদায়</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {areaBreakdown.map((row) => (
                  <tr key={row.areaName} className="hover:bg-slate-50">
                    <td className="py-2.5 font-medium text-slate-900">{row.areaName}</td>
                    <td className="py-2.5 text-right text-slate-700">{toBnDigits(row.totalCustomers)}</td>
                    <td className="py-2.5 text-right text-emerald-700">{toBnDigits(row.activeCount)}</td>
                    <td className="py-2.5 text-right font-medium text-red-600">
                      {formatBnCurrency(row.due)}
                    </td>
                    <td className="py-2.5 text-right font-semibold text-slate-900">
                      {formatBnCurrency(row.paid)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-slate-900">প্যাকেজ ভিত্তিক হিসাব</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 text-left font-semibold">প্যাকেজ</th>
                  <th className="py-2 text-right font-semibold">গ্রাহক সংখ্যা</th>
                  <th className="py-2 text-right font-semibold">মাসিক আয়</th>
                  <th className="py-2 text-right font-semibold">মোট বকেয়া</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {packageBreakdown.map((row) => (
                  <tr key={row.pkg} className="hover:bg-slate-50">
                    <td className="py-2.5 font-medium text-slate-900">{row.pkg}</td>
                    <td className="py-2.5 text-right text-slate-700">{toBnDigits(row.count)} জন</td>
                    <td className="py-2.5 text-right font-semibold text-slate-900">
                      {formatBnCurrency(row.monthlyRevenue)}
                    </td>
                    <td className="py-2.5 text-right font-medium text-red-600">
                      {formatBnCurrency(row.due)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Collector Breakdown & Recent Collections */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6">
          <h3 className="text-base font-semibold text-slate-900">কালেক্টর ভিত্তিক হিসাব</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 text-left font-semibold">কালেক্টর</th>
                  <th className="py-2 text-right font-semibold">নগদ আদায়</th>
                  <th className="py-2 text-right font-semibold">ডিজিটাল</th>
                  <th className="py-2 text-right font-semibold">অফিসে জমা</th>
                  <th className="py-2 text-right font-semibold">হাতে জমা</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {data.collectorSummaries.map((c) => (
                  <tr key={c.CollectorID} className="hover:bg-slate-50">
                    <td className="py-2.5 font-medium text-slate-900">{c.Name}</td>
                    <td className="py-2.5 text-right text-slate-700">
                      {formatBnCurrency(c.cashCollected)}
                    </td>
                    <td className="py-2.5 text-right text-[#0f4c5c]">
                      {formatBnCurrency(c.digitalCollected)}
                    </td>
                    <td className="py-2.5 text-right text-emerald-700">
                      {formatBnCurrency(c.totalDeposited)}
                    </td>
                    <td className="py-2.5 text-right font-bold text-amber-700">
                      {formatBnCurrency(c.handCash)}
                    </td>
                  </tr>
                ))}
                {data.collectorSummaries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-500">
                      কোনো কালেক্টর তথ্য নেই।
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">সাম্প্রতিক আদায়</h3>
            <button
              type="button"
              onClick={() => onNavigateBilling('collections')}
              className="text-xs font-semibold text-[#0f4c5c] hover:underline"
            >
              সব দেখুন
            </button>
          </div>

          <div className="mt-3 divide-y divide-slate-100">
            {recentCollections.map((col) => (
              <div key={col.ReceiptID} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-900">
                    {col.CustomerName}{' '}
                    <span className="font-mono-num font-normal text-slate-500">({col.CustomerID})</span>
                  </p>
                  <p className="text-slate-500">
                    {toBnDigits(col.Date)} · {getMonthLabelBn(col.BillingMonth)} · {col.CollectedBy}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${paymentMethodBadgeClass(
                      col.PaymentMethod
                    )}`}
                  >
                    {paymentMethodLabel(col.PaymentMethod)}
                  </span>
                  <span className="font-mono-num text-sm font-bold text-slate-900">
                    {formatBnCurrency(col.Amount)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

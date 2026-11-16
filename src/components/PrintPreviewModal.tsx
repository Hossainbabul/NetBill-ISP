import React, { useState } from 'react';
import { Printer, X } from 'lucide-react';
import { formatBnCurrency, getMonthLabelBn, paymentMethodLabel, toBnDigits } from '../utils/bengali';
import { PaymentMethod, SettingsData } from '../types';

export interface PosReceiptPayload {
  kind: 'pos-collection' | 'pos-deposit' | 'pos-registration';
  receiptId: string;
  date: string;
  customerOrCollectorName: string;
  customerId?: string;
  mobile?: string;
  area?: string;
  packageName?: string;
  billingMonth?: string;
  amount: number;
  paymentMethod?: PaymentMethod;
  trxId?: string;
  collectedBy?: string;
  note?: string;
}

export interface A4ReportPayload {
  kind: 'a4-report';
  title: string;
  subtitle?: string;
  summaryRows?: { label: string; value: string }[];
  columns: { key: string; label: string; align?: 'left' | 'right' }[];
  rows: Record<string, string | number>[];
}

export type PrintPayload = PosReceiptPayload | A4ReportPayload;

interface PrintPreviewModalProps {
  payload: PrintPayload | null;
  company: Omit<SettingsData, 'AdminPassword'>;
  onClose: () => void;
}

export const PrintPreviewModal: React.FC<PrintPreviewModalProps> = ({
  payload,
  company,
  onClose,
}) => {
  const [paperWidth, setPaperWidth] = useState<'58mm' | '80mm'>('80mm');

  if (!payload) return null;

  const isPos = payload.kind !== 'a4-report';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {isPos ? 'থার্মাল POS রিসিট প্রিভিউ' : 'A4 প্রিন্ট রিপোর্ট প্রিভিউ'}
            </h3>
            <p className="text-xs text-slate-500">
              {isPos ? '৫৮মিমি / ৮০মিমি থার্মাল প্রিন্টার ফরম্যাট' : 'স্ট্যান্ডার্ড A4 পেপার ফরম্যাট'}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            {isPos && (
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setPaperWidth('58mm')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    paperWidth === '58mm'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ৫৮মিমি
                </button>
                <button
                  type="button"
                  onClick={() => setPaperWidth('80mm')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    paperWidth === '80mm'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ৮০মিমি
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#0f4c5c] px-4 py-2 text-sm font-semibold text-white hover:bg-[#135d66] whitespace-nowrap shrink-0"
            >
              <Printer className="h-4 w-4" />
              প্রিন্ট করুন
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="বন্ধ করুন"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto bg-slate-100 p-6">
          <div
            id="print-sheet-area"
            className={`mx-auto bg-white text-slate-900 shadow-sm border border-slate-200 ${
              isPos
                ? paperWidth === '58mm'
                  ? 'w-[240px] p-3 text-[11px]'
                  : 'w-[310px] p-4 text-xs'
                : 'w-full max-w-[794px] p-8 text-sm'
            }`}
          >
            {isPos ? (
              <div className="space-y-2.5">
                <div className="border-b border-dashed border-slate-400 pb-2 text-center">
                  <p className="text-sm font-bold text-slate-900">{company.CompanyName}</p>
                  <p className="text-[11px] text-slate-600">{company.Address}</p>
                  <p className="text-[11px] font-mono-num text-slate-700">
                    হেল্পলাইন: {toBnDigits(company.Phone)}
                  </p>
                </div>

                <div className="border-b border-dashed border-slate-400 pb-2 text-center font-semibold">
                  {payload.kind === 'pos-collection' && 'বিল পরিশোধের রিসিট'}
                  {payload.kind === 'pos-deposit' && 'কালেক্টর জমা রিসিট'}
                  {payload.kind === 'pos-registration' && 'গ্রাহক নিবন্ধন স্লিপ'}
                </div>

                <div className="space-y-1 border-b border-dashed border-slate-400 pb-2">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-600">রিসিট নং:</span>
                    <span className="font-mono-num font-semibold">{payload.receiptId}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-600">তারিখ:</span>
                    <span className="font-mono-num">{toBnDigits(payload.date)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-600">
                      {payload.kind === 'pos-deposit' ? 'কালেক্টর:' : 'গ্রাহক:'}
                    </span>
                    <span className="font-semibold text-right">{payload.customerOrCollectorName}</span>
                  </div>
                  {payload.customerId && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">গ্রাহক আইডি:</span>
                      <span className="font-mono-num font-semibold">{payload.customerId}</span>
                    </div>
                  )}
                  {payload.mobile && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">মোবাইল:</span>
                      <span className="font-mono-num">{payload.mobile}</span>
                    </div>
                  )}
                  {payload.area && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">এরিয়া:</span>
                      <span className="text-right">{payload.area}</span>
                    </div>
                  )}
                  {payload.packageName && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">প্যাকেজ:</span>
                      <span className="text-right">{payload.packageName}</span>
                    </div>
                  )}
                  {payload.billingMonth && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">বিলের মাস:</span>
                      <span className="font-medium">{getMonthLabelBn(payload.billingMonth)}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-1 border-b border-dashed border-slate-400 pb-2">
                  <div className="flex justify-between text-sm font-bold">
                    <span>{payload.kind === 'pos-registration' ? 'মাসিক বিল:' : 'পরিশোধিত টাকা:'}</span>
                    <span className="font-mono-num">{formatBnCurrency(payload.amount)}</span>
                  </div>
                  {payload.paymentMethod && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">মাধ্যম:</span>
                      <span className="font-medium">{paymentMethodLabel(payload.paymentMethod)}</span>
                    </div>
                  )}
                  {payload.trxId && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">TrxID:</span>
                      <span className="font-mono-num font-semibold">{payload.trxId}</span>
                    </div>
                  )}
                  {payload.collectedBy && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">আদায়কারী:</span>
                      <span>{payload.collectedBy}</span>
                    </div>
                  )}
                  {payload.note && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-600">নোট:</span>
                      <span className="text-right">{payload.note}</span>
                    </div>
                  )}
                </div>

                <div className="pt-1 text-center text-[10px] text-slate-600">
                  <p>আমাদের সাথে থাকার জন্য ধন্যবাদ।</p>
                  <p className="mt-0.5">সিস্টেম জেনারেটেড রিসিট</p>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-start justify-between border-b border-slate-300 pb-4">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">{company.CompanyName}</h2>
                    <p className="text-xs text-slate-600">
                      {company.Address} · ফোন: {toBnDigits(company.Phone)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-[#0f4c5c]">{payload.title}</p>
                    {payload.subtitle && <p className="text-xs text-slate-600">{payload.subtitle}</p>}
                  </div>
                </div>

                {payload.summaryRows && payload.summaryRows.length > 0 && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {payload.summaryRows.map((sr, i) => (
                      <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[11px] text-slate-500">{sr.label}</p>
                        <p className="text-sm font-bold text-slate-900 tabular-nums">{sr.value}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-y border-slate-300 bg-slate-100 text-slate-700">
                        {payload.columns.map((col) => (
                          <th
                            key={col.key}
                            className={`px-2.5 py-2 font-semibold ${
                              col.align === 'right' ? 'text-right' : 'text-left'
                            }`}
                          >
                            {col.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {payload.rows.map((row, idx) => (
                        <tr key={idx}>
                          {payload.columns.map((col) => (
                            <td
                              key={col.key}
                              className={`px-2.5 py-2 tabular-nums ${
                                col.align === 'right' ? 'text-right font-medium' : 'text-left'
                              }`}
                            >
                              {row[col.key]}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {payload.rows.length === 0 && (
                        <tr>
                          <td
                            colSpan={payload.columns.length}
                            className="px-3 py-6 text-center text-slate-500"
                          >
                            এই রিপোর্টে কোনো তথ্য পাওয়া যায়নি।
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between border-t border-slate-300 pt-4 text-[11px] text-slate-500">
                  <span>প্রিন্ট তারিখ: {toBnDigits(new Date().toISOString().slice(0, 10))}</span>
                  <span>অনুমোদিত স্বাক্ষর: ______________________</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

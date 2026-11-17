import { PaymentMethod } from '../types';

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBnDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => BN_DIGITS[Number(d)] ?? d);
}

export function formatCurrency(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `৳${safe.toLocaleString('en-US')}`;
}

export function formatBnCurrency(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `৳${toBnDigits(safe.toLocaleString('en-US'))}`;
}

const BN_MONTHS: Record<string, string> = {
  '01': 'জানুয়ারি',
  '02': 'ফেব্রুয়ারি',
  '03': 'মার্চ',
  '04': 'এপ্রিল',
  '05': 'মে',
  '06': 'জুন',
  '07': 'জুলাই',
  '08': 'আগস্ট',
  '09': 'সেপ্টেম্বর',
  '10': 'অক্টোবর',
  '11': 'নভেম্বর',
  '12': 'ডিসেম্বর',
};

export function getMonthLabelBn(monthStr: string): string {
  if (!monthStr) return '';
  if (monthStr === 'Opening') return 'পূর্বের বকেয়া';
  const [year, month] = monthStr.split('-');
  if (!year || !month || !BN_MONTHS[month]) return monthStr;
  return `${BN_MONTHS[month]} ${toBnDigits(year)}`;
}

export function getCurrentMonthStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getLastNMonths(n: number, anchorMonth?: string): string[] {
  const base = anchorMonth && /^\d{4}-\d{2}$/.test(anchorMonth)
    ? new Date(Number(anchorMonth.split('-')[0]), Number(anchorMonth.split('-')[1]) - 1, 1)
    : new Date();
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    months.push(`${y}-${m}`);
  }
  return months;
}

export function getUpcomingMonths(count = 4, fromMonth?: string): string[] {
  const base = fromMonth && /^\d{4}-\d{2}$/.test(fromMonth)
    ? new Date(Number(fromMonth.split('-')[0]), Number(fromMonth.split('-')[1]) - 1, 1)
    : new Date();
  const months: string[] = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    months.push(`${y}-${m}`);
  }
  return months;
}

export function paymentMethodLabel(method: PaymentMethod): string {
  switch (method) {
    case 'Cash':
      return 'নগদ (Cash)';
    case 'bKash':
      return 'বিকাশ (bKash)';
    case 'Nagad':
      return 'নগদ (Nagad)';
    case 'Rocket':
      return 'রকেট (Rocket)';
    case 'Bank':
      return 'ব্যাংক (Bank)';
    default:
      return method;
  }
}

export function paymentMethodBadgeClass(method: PaymentMethod): string {
  switch (method) {
    case 'bKash':
      return 'text-[#E2136E] bg-[#E2136E]/10 border-[#E2136E]/25';
    case 'Nagad':
      return 'text-[#C26A00] bg-[#F7941D]/15 border-[#F7941D]/30';
    case 'Rocket':
      return 'text-[#8C3494] bg-[#8C3494]/10 border-[#8C3494]/25';
    case 'Bank':
      return 'text-indigo-700 bg-indigo-50 border-indigo-200';
    case 'Cash':
    default:
      return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  }
}

export function buildWhatsAppUrl(mobile: string, text: string): string {
  const digits = mobile.replace(/\D/g, '');
  let normalized = digits;
  if (digits.startsWith('01')) {
    normalized = `88${digits}`;
  } else if (!digits.startsWith('880') && digits.length === 10) {
    normalized = `880${digits}`;
  }
  return `https://api.whatsapp.com/send?phone=${normalized}&text=${encodeURIComponent(text)}`;
}

export function buildPayPortalUrl(customerId?: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return customerId
    ? `${origin}/exp?cid=${encodeURIComponent(customerId)}`
    : `${origin}/?page=pay`;
}

const EN_SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatShortDateEn(dateStr: string): string {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return dateStr || getTodayStr();
  const [y, m, d] = parts;
  const mon = EN_SHORT_MONTHS[m - 1] || String(m).padStart(2, '0');
  const yy = String(y).slice(-2);
  return `${String(d).padStart(2, '0')} ${mon} ${yy}`;
}

export function formatNumericTaka(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${safe.toFixed(2)}টাকা`;
}

export const DEFAULT_DUE_REMINDER_TEMPLATE =
  'Dear {Name}, আজ আপনার শেষ দিন {LastDate}, আপনার বকেয়া বিল: {DueAmount}। আপনার লাইনটি সচল রাখতে দ্রুত বিল পেমেন্ট করার জন্য নিচের লিংকে ক্লিক করুন {PayLink} Thanks {Company}';

export const DEFAULT_LINK_REMINDER_CONFIG = {
  Enabled: false,
  SendHour: 10,
  DeadlineDay: 10,
  AutoGenerateBills: true,
  Template:
    'Dear {Name}, আপনার ইন্টারনেট বিল দেখতে ও পেমেন্ট করতে নিচের লিংকে ক্লিক করুন {PayLink} প্রতি মাসের ১ থেকে {DeadlineDay} তারিখের মধ্যে বিল পরিশোধ করুন। লিংকটি সংরক্ষণ করে রাখুন, প্রতি মাসে এই লিংকেই আপনার বিল দেখতে পাবেন। Thanks {Company}',
};

export function formatDueReminderMessage(params: {
  template: string;
  name: string;
  customerId: string;
  lastDate: string;
  due: number;
  companyName: string;
  keepPayLinkPlaceholder?: boolean;
}): string {
  const link = params.keepPayLinkPlaceholder
    ? '{PayLink}'
    : buildPayPortalUrl(params.customerId);
  return params.template
    .replace(/\{Name\}/g, params.name)
    .replace(/\{ID\}/g, params.customerId)
    .replace(/\{LastDate\}/g, formatShortDateEn(params.lastDate))
    .replace(/\{Due\}/g, formatBnCurrency(params.due))
    .replace(/\{DueAmount\}/g, formatNumericTaka(params.due))
    .replace(/\{PayLink\}/g, link)
    .replace(/\{Company\}/g, params.companyName);
}

export const INTERNET_PACKAGES = [
  '20 Mbps',
  '30 Mbps',
  '40 Mbps',
  '50 Mbps',
  '75 Mbps',
  '100 Mbps',
  '150 Mbps',
  '220 Mbps',
];

export const CABLE_PACKAGES = ['Cable TV Basic', 'Cable TV HD'];

export const EXPENSE_CATEGORIES = [
  'বেতন',
  'অফিস ভাড়া',
  'কেবল ও যন্ত্রপাতি',
  'ব্যান্ডউইথ বিল',
  'বিদ্যুৎ বিল',
  'আপ্যায়ন/অন্যান্য',
] as const;

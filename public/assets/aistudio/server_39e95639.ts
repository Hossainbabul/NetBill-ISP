import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import type {
  AccountBalances,
  Area,
  Bill,
  Collection,
  Collector,
  CollectorDeposit,
  CollectorSummary,
  Customer,
  DueReminderConfig,
  EPaymentRequest,
  Expense,
  PaymentMethod,
  SessionUser,
  SettingsData,
  SmsLog,
  SmsProvider,
} from './src/types';
import {
  DEFAULT_SMS_CONFIG,
  dispatchSmsAndLog,
  formatBengaliCollectionSms,
  getSmsEnvStatus,
  onCollectionPaymentProcessed,
} from './server/collectionSmsService';

interface DatabaseSchema {
  settings: SettingsData;
  areas: Area[];
  collectors: Collector[];
  customers: Customer[];
  bills: Bill[];
  collections: Collection[];
  ePayments: EPaymentRequest[];
  deposits: CollectorDeposit[];
  expenses: Expense[];
  smsLogs: SmsLog[];
  dueReminder?: { lastRunDate: string; linkSent: Record<string, string>; billsMonth: string };
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'netbill-db.json');

// ─────────────────────────────────────────────────────────────
// SECURITY HELPERS (hashing, rate limiting, sessions, validation)
// ─────────────────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const SESSION_IDLE_MS = (Number(process.env.SESSION_IDLE_HOURS) || 12) * 60 * 60 * 1000;
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAYMENT_AMOUNT = 1_000_000;
const MIN_PASSWORD_LENGTH = 8;
const MASKED_PASSWORD = '••••••';
const DEMO_WEBHOOK_SECRET = 'nb_whsec_demo_2026';
const TRX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_.]{3,39}$/;
const ALLOWED_PAYMENT_METHODS: readonly string[] = ['Cash', 'bKash', 'Nagad', 'Rocket', 'Bank'];
const PUBLIC_PAYMENT_METHODS: readonly string[] = ['bKash', 'Nagad', 'Rocket', 'Bank'];
const DEFAULT_ADMIN_PASSWORDS = ['admin123', 'admin', 'password', '123456', '12345678'];
const DEFAULT_COLLECTOR_PASSWORDS = ['1234', '12345', '123456', 'password', '0000'];
const WEAK_PASSWORDS = [
  'admin123', 'admin1234', 'password', 'password1', '12345678', '123456789',
  '1234567890', 'qwerty123', '11111111', '00000000', 'abcd1234',
];

class DuplicateTrxError extends Error {
  constructor() {
    super('এই TrxID দিয়ে ইতিমধ্যেই পেমেন্ট রেকর্ড করা হয়েছে।');
    this.name = 'DuplicateTrxError';
  }
}
class WebhookAuthError extends Error {
  constructor() {
    super('Invalid webhook secret');
    this.name = 'WebhookAuthError';
  }
}

// ---- Password hashing (scrypt, built into Node – no extra dependency) ----
function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function isHashedPassword(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('scrypt$');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyPassword(plain: string | undefined, stored: string | undefined): boolean {
  if (!plain || !stored) return false;
  if (!isHashedPassword(stored)) {
    // Legacy plain-text value (migrated to a hash automatically at startup)
    return safeEqual(plain, stored);
  }
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function generatePassword(len = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function assertStrongPassword(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`পাসওয়ার্ড কমপক্ষে ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে।`);
  }
  if (pw.length > 128) {
    throw new Error('পাসওয়ার্ড অনেক দীর্ঘ (সর্বোচ্চ ১২৮ অক্ষর)।');
  }
  if (WEAK_PASSWORDS.includes(pw.toLowerCase())) {
    throw new Error('এই পাসওয়ার্ডটি খুব সহজ ও পরিচিত। অন্য একটি শক্ত পাসওয়ার্ড দিন।');
  }
}

// ---- Input validation helpers ----
function isValidBillingMonth(m: string): boolean {
  return m === 'Opening' || /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

function normalizeMobile(input: string): string {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = `0${d}`;
  return d;
}

function maskMobile(input: string): string {
  const d = String(input || '').replace(/\D/g, '');
  if (d.length < 7) return '***';
  return `${d.slice(0, 3)}${'*'.repeat(d.length - 5)}${d.slice(-2)}`;
}

function maskTrx(trx: string): string {
  const t = String(trx || '');
  if (t.length <= 5) return '***';
  return `${t.slice(0, 2)}***${t.slice(-3)}`;
}

/**
 * Public website address used inside SMS payment links.
 * Uses APP_URL from .env; otherwise the address the admin is browsing from —
 * but never localhost (a localhost link cannot open on a customer's phone).
 */
function getPublicBaseUrl(req: Request): string {
  const env = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+/i.test(env) && !/MY_APP_URL/i.test(env)) return env;
  const host = req.get('host') || '';
  if (!host || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host)) return '';
  return `${req.protocol}://${host}`;
}

// ---- In-memory rate limiter (no extra dependency) ----
interface RateBucket {
  count: number;
  resetAt: number;
}
const rateBuckets = new Map<string, RateBucket>();

/** Returns seconds to wait if the key is currently over its limit, otherwise 0. */
function rateCheck(key: string, max: number): number {
  const b = rateBuckets.get(key);
  const now = Date.now();
  if (!b || b.resetAt <= now) return 0;
  return b.count >= max ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

function rateHit(key: string, windowMs: number): void {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    b.count++;
  }
}

function rateClear(key: string): void {
  rateBuckets.delete(key);
}

function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const wait = rateCheck(key, max);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({
        error: 'অনেক বেশি অনুরোধ করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।',
      });
      return;
    }
    rateHit(key, windowMs);
    next();
  };
}

// ---- Sessions with idle + absolute expiry ----
interface SessionMeta {
  createdAt: number;
  lastSeen: number;
}
const sessions = new Map<string, SessionUser>();
const sessionMeta = new Map<string, SessionMeta>();

function createSession(user: SessionUser): void {
  const now = Date.now();
  sessions.set(user.token, user);
  sessionMeta.set(user.token, { createdAt: now, lastSeen: now });
}

function destroySession(token: string): void {
  sessions.delete(token);
  sessionMeta.delete(token);
}

function revokeSessionsFor(username: string, exceptToken?: string): void {
  for (const [token, u] of sessions) {
    if (u.username === username && token !== exceptToken) destroySession(token);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (b.resetAt <= now) rateBuckets.delete(k);
  }
  for (const [token, m] of sessionMeta) {
    if (now - m.lastSeen > SESSION_IDLE_MS || now - m.createdAt > SESSION_MAX_MS) {
      destroySession(token);
    }
  }
}, 5 * 60 * 1000).unref();

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
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

function toBnDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => BN_DIGITS[Number(d)] ?? d);
}

function getMonthLabelBn(monthStr: string): string {
  if (monthStr === 'Opening') return 'পূর্বের বকেয়া';
  const [y, m] = monthStr.split('-');
  if (!y || !m || !BN_MONTHS[m]) return monthStr;
  return `${BN_MONTHS[m]} ${toBnDigits(y)}`;
}

function addOneMonthStr(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    const dt = new Date();
    dt.setMonth(dt.getMonth() + 1);
    return dt.toISOString().slice(0, 10);
  }
  const [y, m, d] = parts;
  const target = new Date(y, m, Math.min(d, 28));
  const ny = target.getFullYear();
  const nm = String(target.getMonth() + 1).padStart(2, '0');
  const nd = String(target.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function nextMonthYYYYMM(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  const dt = new Date(y, m, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function randomId(prefix: string): string {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${num}`;
}

function createSeedDatabase(): DatabaseSchema {
  return {
    settings: {
      CompanyName: 'নেটবিল আইএসপি এন্ড ক্যাবল নেটওয়ার্ক',
      BusinessType: 'ISP & Cable TV',
      Address: 'বাড়ি #২৪, মেইন রোড, মিরপুর-১০, ঢাকা-১২১৬',
      Phone: '01711-223344',
      ScrollingNotice:
        'সম্মানিত গ্রাহকগণ, প্রতি মাসের ১০ তারিখের মধ্যে আপনার ইন্টারনেট ও ডিস বিল বিকাশ/নগদ/রকেট বা অনলাইন পেমেন্ট পোর্টালের মাধ্যমে পরিশোধ করুন। সহায়তার জন্য কল করুন: ০১৭১১-২২৩৩৪৪।',
      AdminUsername: 'admin',
      AdminPassword: '', // generated at first start (see hardenCredentials)
      BkashNumber: '01711-223344',
      BkashType: 'Merchant',
      NagadNumber: '01811-556677',
      NagadType: 'Merchant',
      RocketNumber: '01911-889900-4',
      BankDetails: {
        BankName: 'ডাচ-বাংলা ব্যাংক পিএলসি (DBBL)',
        AccountName: 'NetBill ISP Network',
        AccountNo: '115-110-0045892',
        Branch: 'মিরপুর শাখা, ঢাকা',
        Routing: '090262987',
      },
      PaymentGatewayWebhookSecret: '', // generated at first start
      SmsConfig: {
        Enabled: true,
        Provider: (process.env.SMS_PROVIDER as SmsProvider) || 'sandbox',
        SenderId: process.env.LOCAL_SMS_SENDER_ID || 'NetBillISP',
        PaymentSmsTemplate:
          'প্রিয় {Name} ({ID}), {Month} মাসের {Amount} বিল ({Method}) পরিশোধ হয়েছে। রিসিট: {ReceiptID}। ধন্যবাদ - {Company}',
      },
    },
    areas: [
      { AreaID: 'AR-101', AreaName: 'মিরপুর ১০ (সেক্টর এ)', ServiceType: 'Both', CreatedAt: '2026-01-10' },
      { AreaID: 'AR-102', AreaName: 'কাজীপাড়া উত্তর', ServiceType: 'Internet', CreatedAt: '2026-01-12' },
      { AreaID: 'AR-103', AreaName: 'শেওড়াপাড়া বাজার', ServiceType: 'Both', CreatedAt: '2026-02-01' },
      { AreaID: 'AR-104', AreaName: 'পল্লবী আবাসিক', ServiceType: 'Cable TV', CreatedAt: '2026-02-15' },
    ],
    collectors: [
      {
        CollectorID: 'CL-201',
        Name: 'মোঃ রফিকুল ইসলাম',
        Mobile: '01712-345678',
        Username: 'rafiq',
        Password: '', // generated at first start
        AssignedAreas: ['মিরপুর ১০ (সেক্টর এ)', 'কাজীপাড়া উত্তর'],
        Status: 'এক্টিভ',
        CreatedAt: '2026-01-15',
      },
      {
        CollectorID: 'CL-202',
        Name: 'সোহেল রানা',
        Mobile: '01819-876543',
        Username: 'sohel',
        Password: '', // generated at first start
        AssignedAreas: ['শেওড়াপাড়া বাজার', 'পল্লবী আবাসিক'],
        Status: 'এক্টিভ',
        CreatedAt: '2026-02-18',
      },
    ],
    customers: [
      {
        CustomerID: 'NB-1001',
        Name: 'মোঃ কামাল হোসেন',
        Mobile: '01715-112233',
        Area: 'মিরপুর ১০ (সেক্টর এ)',
        Address: 'বাসা ১২, রোড ৪, ব্লক সি',
        ServiceType: 'Internet',
        Package: '50 Mbps',
        MonthlyBill: 1000,
        ConnectionDate: '2026-05-01',
        NextBillDate: '2026-12-01',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: 'নিয়মিত গ্রাহক',
        CreatedAt: '2026-05-01',
      },
      {
        CustomerID: 'NB-1002',
        Name: 'তানজিনা আক্তার',
        Mobile: '01816-223344',
        Area: 'মিরপুর ১০ (সেক্টর এ)',
        Address: 'ফ্ল্যাট ৪বি, রোজ গার্ডেন',
        ServiceType: 'Internet',
        Package: '30 Mbps',
        MonthlyBill: 800,
        ConnectionDate: '2026-05-05',
        NextBillDate: '2026-12-05',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: '',
        CreatedAt: '2026-05-05',
      },
      {
        CustomerID: 'NB-1003',
        Name: 'আব্দুর রহমান মিয়া',
        Mobile: '01911-334455',
        Area: 'কাজীপাড়া উত্তর',
        Address: 'হোল্ডিং ৭৮, পূর্ব কাজীপাড়া',
        ServiceType: 'Internet',
        Package: '100 Mbps',
        MonthlyBill: 1500,
        ConnectionDate: '2026-06-01',
        NextBillDate: '2026-12-01',
        Status: 'এক্টিভ',
        OpeningBalance: 500,
        Note: 'অফিস সংযোগ',
        CreatedAt: '2026-06-01',
      },
      {
        CustomerID: 'NB-1004',
        Name: 'মোঃ সাইফুল ইসলাম',
        Mobile: '01612-445566',
        Area: 'কাজীপাড়া উত্তর',
        Address: 'বাইতুল আমান লেন, বাসা ৯',
        ServiceType: 'Internet',
        Package: '20 Mbps',
        MonthlyBill: 500,
        ConnectionDate: '2026-06-10',
        NextBillDate: '2026-11-10',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: '',
        CreatedAt: '2026-06-10',
      },
      {
        CustomerID: 'NB-1005',
        Name: 'নুসরাত জাহান মীম',
        Mobile: '01722-556677',
        Area: 'শেওড়াপাড়া বাজার',
        Address: 'শেওড়াপাড়া মেইন রোড, ৪র্থ তলা',
        ServiceType: 'Internet',
        Package: '40 Mbps',
        MonthlyBill: 900,
        ConnectionDate: '2026-05-15',
        NextBillDate: '2026-12-15',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: '',
        CreatedAt: '2026-05-15',
      },
      {
        CustomerID: 'NB-1006',
        Name: 'হাজী আব্দুল মালেক',
        Mobile: '01823-667788',
        Area: 'শেওড়াপাড়া বাজার',
        Address: 'আনন্দ বাজার সংলগ্ন',
        ServiceType: 'Cable TV',
        Package: 'Cable TV HD',
        MonthlyBill: 400,
        ConnectionDate: '2026-05-01',
        NextBillDate: '2026-12-01',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: '২টি টিভি পয়েন্ট',
        CreatedAt: '2026-05-01',
      },
      {
        CustomerID: 'NB-1007',
        Name: 'ফারুক আহমেদ',
        Mobile: '01924-778899',
        Area: 'পল্লবী আবাসিক',
        Address: 'ব্লক ডি, রোড ২, বাসা ১৮',
        ServiceType: 'Cable TV',
        Package: 'Cable TV Basic',
        MonthlyBill: 300,
        ConnectionDate: '2026-05-20',
        NextBillDate: '2026-12-20',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: '',
        CreatedAt: '2026-05-20',
      },
      {
        CustomerID: 'NB-1008',
        Name: 'তানভীর হাসান',
        Mobile: '01733-889900',
        Area: 'মিরপুর ১০ (সেক্টর এ)',
        Address: 'ব্লক বি, লেন ৫',
        ServiceType: 'Internet',
        Package: '220 Mbps',
        MonthlyBill: 2500,
        ConnectionDate: '2026-06-01',
        NextBillDate: '2026-12-01',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: 'কর্পোরেট ডেডিকেটেড লাইন',
        CreatedAt: '2026-06-01',
      },
      {
        CustomerID: 'NB-1009',
        Name: 'শামীমা নাসরিন',
        Mobile: '01552-990011',
        Area: 'পল্লবী আবাসিক',
        Address: 'পল্লবী এক্সটেনশন',
        ServiceType: 'Cable TV',
        Package: 'Cable TV Basic',
        MonthlyBill: 300,
        ConnectionDate: '2026-04-01',
        NextBillDate: '2026-10-01',
        Status: 'ডি-এক্টিভ',
        OpeningBalance: 0,
        Note: 'বাসা পরিবর্তন করেছেন',
        CreatedAt: '2026-04-01',
      },
      {
        CustomerID: 'NB-1010',
        Name: 'মেহেদী হাসান জয়',
        Mobile: '01744-102030',
        Area: 'শেওড়াপাড়া বাজার',
        Address: 'পশ্চিম শেওড়াপাড়া, বাসা ৫৫',
        ServiceType: 'Internet',
        Package: '75 Mbps',
        MonthlyBill: 1200,
        ConnectionDate: '2026-07-01',
        NextBillDate: '2026-11-12',
        Status: 'এক্টিভ',
        OpeningBalance: 0,
        Note: 'গেমিং প্যাকেজ',
        CreatedAt: '2026-07-01',
      },
    ],
    bills: [
      // October & November 2026 bills + Opening
      { BillID: 'BL-9001', CustomerID: 'NB-1001', BillingMonth: '2026-10', MonthLabel: 'অক্টোবর ২০২৬', BillType: 'Monthly', Amount: 1000, PaidAmount: 1000, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-10-01' },
      { BillID: 'BL-9002', CustomerID: 'NB-1001', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 1000, PaidAmount: 1000, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9003', CustomerID: 'NB-1002', BillingMonth: '2026-10', MonthLabel: 'অক্টোবর ২০২৬', BillType: 'Monthly', Amount: 800, PaidAmount: 800, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-10-01' },
      { BillID: 'BL-9004', CustomerID: 'NB-1002', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 800, PaidAmount: 0, DueAmount: 800, Status: 'বকেয়া', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9005', CustomerID: 'NB-1003', BillingMonth: 'Opening', MonthLabel: 'পূর্বের বকেয়া', BillType: 'Opening', Amount: 500, PaidAmount: 0, DueAmount: 500, Status: 'বকেয়া', GeneratedDate: '2026-06-01' },
      { BillID: 'BL-9006', CustomerID: 'NB-1003', BillingMonth: '2026-10', MonthLabel: 'অক্টোবর ২০২৬', BillType: 'Monthly', Amount: 1500, PaidAmount: 1500, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-10-01' },
      { BillID: 'BL-9007', CustomerID: 'NB-1003', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 1500, PaidAmount: 500, DueAmount: 1000, Status: 'আংশিক', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9008', CustomerID: 'NB-1004', BillingMonth: '2026-10', MonthLabel: 'অক্টোবর ২০২৬', BillType: 'Monthly', Amount: 500, PaidAmount: 0, DueAmount: 500, Status: 'বকেয়া', GeneratedDate: '2026-10-01' },

      { BillID: 'BL-9009', CustomerID: 'NB-1005', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 900, PaidAmount: 900, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9010', CustomerID: 'NB-1006', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 400, PaidAmount: 0, DueAmount: 400, Status: 'বকেয়া', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9011', CustomerID: 'NB-1007', BillingMonth: '2026-10', MonthLabel: 'অক্টোবর ২০২৬', BillType: 'Monthly', Amount: 300, PaidAmount: 300, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-10-01' },
      { BillID: 'BL-9012', CustomerID: 'NB-1007', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 300, PaidAmount: 0, DueAmount: 300, Status: 'বকেয়া', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9013', CustomerID: 'NB-1008', BillingMonth: '2026-11', MonthLabel: 'নভেম্বর ২০২৬', BillType: 'Monthly', Amount: 2500, PaidAmount: 2500, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-11-01' },

      { BillID: 'BL-9014', CustomerID: 'NB-1010', BillingMonth: '2026-10', MonthLabel: 'অক্টোবর ২০২৬', BillType: 'Monthly', Amount: 1200, PaidAmount: 1200, DueAmount: 0, Status: 'পরিশোধিত', GeneratedDate: '2026-10-01' },
    ],
    collections: [
      // Past 6 months collections (June 2026 - November 2026)
      { ReceiptID: 'P-601011', Date: '2026-06-12', CustomerID: 'NB-1001', CustomerName: 'মোঃ কামাল হোসেন', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-06', Amount: 1000, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'rafiq', CollectorRole: 'User', Note: 'জুন বিল', CreatedAt: '2026-06-12T11:00:00Z' },
      { ReceiptID: 'P-601012', Date: '2026-06-14', CustomerID: 'NB-1008', CustomerName: 'তানভীর হাসান', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-06', Amount: 2500, PaymentMethod: 'Bank', TrxID: 'DBBL-884210', SenderAccount: '110-220-334', CollectedBy: 'admin', CollectorRole: 'Admin', Note: '', CreatedAt: '2026-06-14T14:20:00Z' },
      { ReceiptID: 'P-601013', Date: '2026-07-09', CustomerID: 'NB-1001', CustomerName: 'মোঃ কামাল হোসেন', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-07', Amount: 1000, PaymentMethod: 'bKash', TrxID: 'BK7X29M1P', SenderAccount: '01715-112233', CollectedBy: 'Self-EBill', CollectorRole: 'Self-EBill', Note: '', CreatedAt: '2026-07-09T10:15:00Z' },
      { ReceiptID: 'P-601014', Date: '2026-07-11', CustomerID: 'NB-1008', CustomerName: 'তানভীর হাসান', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-07', Amount: 2500, PaymentMethod: 'Bank', TrxID: 'DBBL-991230', SenderAccount: '110-220-334', CollectedBy: 'admin', CollectorRole: 'Admin', Note: '', CreatedAt: '2026-07-11T12:00:00Z' },
      { ReceiptID: 'P-601015', Date: '2026-08-08', CustomerID: 'NB-1003', CustomerName: 'আব্দুর রহমান মিয়া', Area: 'কাজীপাড়া উত্তর', BillingMonth: '2026-08', Amount: 1500, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'rafiq', CollectorRole: 'User', Note: '', CreatedAt: '2026-08-08T15:30:00Z' },
      { ReceiptID: 'P-601016', Date: '2026-08-10', CustomerID: 'NB-1010', CustomerName: 'মেহেদী হাসান জয়', Area: 'শেওড়াপাড়া বাজার', BillingMonth: '2026-08', Amount: 1200, PaymentMethod: 'Nagad', TrxID: 'NG88210K', SenderAccount: '01744-102030', CollectedBy: 'Self-EBill', CollectorRole: 'Self-EBill', Note: '', CreatedAt: '2026-08-10T16:40:00Z' },
      { ReceiptID: 'P-601017', Date: '2026-09-07', CustomerID: 'NB-1008', CustomerName: 'তানভীর হাসান', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-09', Amount: 2500, PaymentMethod: 'Bank', TrxID: 'DBBL-773129', SenderAccount: '110-220-334', CollectedBy: 'admin', CollectorRole: 'Admin', Note: '', CreatedAt: '2026-09-07T11:20:00Z' },
      { ReceiptID: 'P-601018', Date: '2026-09-10', CustomerID: 'NB-1005', CustomerName: 'নুসরাত জাহান মীম', Area: 'শেওড়াপাড়া বাজার', BillingMonth: '2026-09', Amount: 900, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'sohel', CollectorRole: 'User', Note: '', CreatedAt: '2026-09-10T13:10:00Z' },
      { ReceiptID: 'P-601019', Date: '2026-10-05', CustomerID: 'NB-1001', CustomerName: 'মোঃ কামাল হোসেন', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-10', Amount: 1000, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'rafiq', CollectorRole: 'User', Note: '', CreatedAt: '2026-10-05T11:30:00Z' },
      { ReceiptID: 'P-601020', Date: '2026-10-07', CustomerID: 'NB-1002', CustomerName: 'তানজিনা আক্তার', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-10', Amount: 800, PaymentMethod: 'bKash', TrxID: 'BKA9012L', SenderAccount: '01816-223344', CollectedBy: 'Self-EBill', CollectorRole: 'Self-EBill', Note: '', CreatedAt: '2026-10-07T09:10:00Z' },
      { ReceiptID: 'P-601021', Date: '2026-10-09', CustomerID: 'NB-1003', CustomerName: 'আব্দুর রহমান মিয়া', Area: 'কাজীপাড়া উত্তর', BillingMonth: '2026-10', Amount: 1500, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'rafiq', CollectorRole: 'User', Note: '', CreatedAt: '2026-10-09T17:00:00Z' },
      { ReceiptID: 'P-601022', Date: '2026-10-12', CustomerID: 'NB-1010', CustomerName: 'মেহেদী হাসান জয়', Area: 'শেওড়াপাড়া বাজার', BillingMonth: '2026-10', Amount: 1200, PaymentMethod: 'Nagad', TrxID: 'NG77391M', SenderAccount: '01744-102030', CollectedBy: 'sohel', CollectorRole: 'User', Note: 'নগদ অ্যাপে পরিশোধ', CreatedAt: '2026-10-12T12:45:00Z' },
      { ReceiptID: 'P-601023', Date: '2026-10-15', CustomerID: 'NB-1007', CustomerName: 'ফারুক আহমেদ', Area: 'পল্লবী আবাসিক', BillingMonth: '2026-10', Amount: 300, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'sohel', CollectorRole: 'User', Note: '', CreatedAt: '2026-10-15T18:10:00Z' },
      { ReceiptID: 'P-601024', Date: '2026-11-04', CustomerID: 'NB-1001', CustomerName: 'মোঃ কামাল হোসেন', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-11', Amount: 1000, PaymentMethod: 'bKash', TrxID: 'BKB81920P', SenderAccount: '01715-112233', CollectedBy: 'Self-EBill', CollectorRole: 'Self-EBill', Note: 'ই-বিল পেমেন্ট', CreatedAt: '2026-11-04T10:15:00Z' },
      { ReceiptID: 'P-601025', Date: '2026-11-06', CustomerID: 'NB-1003', CustomerName: 'আব্দুর রহমান মিয়া', Area: 'কাজীপাড়া উত্তর', BillingMonth: '2026-11', Amount: 500, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'rafiq', CollectorRole: 'User', Note: 'আংশিক জমা', CreatedAt: '2026-11-06T14:00:00Z' },
      { ReceiptID: 'P-601026', Date: '2026-11-08', CustomerID: 'NB-1005', CustomerName: 'নুসরাত জাহান মীম', Area: 'শেওড়াপাড়া বাজার', BillingMonth: '2026-11', Amount: 900, PaymentMethod: 'Cash', TrxID: '', SenderAccount: '', CollectedBy: 'sohel', CollectorRole: 'User', Note: '', CreatedAt: '2026-11-08T16:20:00Z' },
      { ReceiptID: 'P-601027', Date: '2026-11-10', CustomerID: 'NB-1008', CustomerName: 'তানভীর হাসান', Area: 'মিরপুর ১০ (সেক্টর এ)', BillingMonth: '2026-11', Amount: 2500, PaymentMethod: 'Bank', TrxID: 'DBBL-998124', SenderAccount: '110-220-334', CollectedBy: 'admin', CollectorRole: 'Admin', Note: 'ব্যাংক ট্রান্সফার', CreatedAt: '2026-11-10T11:30:00Z' },
    ],
    ePayments: [
      {
        RequestID: 'EP-501101',
        SubmittedAt: '2026-11-14T15:20:00Z',
        CustomerID: 'NB-1002',
        CustomerName: 'তানজিনা আক্তার',
        Mobile: '01816-223344',
        BillingMonth: '2026-11',
        Amount: 800,
        PaymentMethod: 'bKash',
        SenderNumberOrAccount: '01816-223344',
        TrxID: 'BK9N44K81Q',
        Status: 'Pending',
        ReviewedBy: '',
        ReviewedAt: '',
        Note: 'নভেম্বর ইন্টারনেট বিল',
      },
      {
        RequestID: 'EP-501102',
        SubmittedAt: '2026-11-15T09:40:00Z',
        CustomerID: 'NB-1006',
        CustomerName: 'হাজী আব্দুল মালেক',
        Mobile: '01823-667788',
        BillingMonth: '2026-11',
        Amount: 400,
        PaymentMethod: 'Nagad',
        SenderNumberOrAccount: '01823-667788',
        TrxID: 'NG661029AA',
        Status: 'Pending',
        ReviewedBy: '',
        ReviewedAt: '',
        Note: 'ডিস লাইন বিল',
      },
      {
        RequestID: 'EP-501099',
        SubmittedAt: '2026-11-04T10:05:00Z',
        CustomerID: 'NB-1001',
        CustomerName: 'মোঃ কামাল হোসেন',
        Mobile: '01715-112233',
        BillingMonth: '2026-11',
        Amount: 1000,
        PaymentMethod: 'bKash',
        SenderNumberOrAccount: '01715-112233',
        TrxID: 'BKB81920P',
        Status: 'Approved',
        ReviewedBy: 'admin',
        ReviewedAt: '2026-11-04T10:15:00Z',
        Note: 'যাচাইকৃত',
      },
    ],
    deposits: [
      {
        DepositID: 'DP-301101',
        Date: '2026-10-20',
        CollectorUsername: 'rafiq',
        CollectorName: 'মোঃ রফিকুল ইসলাম',
        Amount: 4000,
        DepositMethod: 'Cash',
        TrxID: '',
        Note: 'অক্টোবর কালেকশন অফিস জমা',
        CreatedAt: '2026-10-20T18:00:00Z',
      },
      {
        DepositID: 'DP-301102',
        Date: '2026-10-25',
        CollectorUsername: 'sohel',
        CollectorName: 'সোহেল রানা',
        Amount: 1200,
        DepositMethod: 'bKash',
        TrxID: 'BK550192X',
        Note: 'বিকাশে অফিসে প্রেরণ',
        CreatedAt: '2026-10-25T19:00:00Z',
      },
    ],
    expenses: [
      {
        ExpenseID: 'EX-401101',
        Date: '2026-11-02',
        Category: 'ব্যান্ডউইথ বিল',
        PaymentAccount: 'Bank',
        Amount: 4500,
        Note: 'আপস্ট্রিম আইআইজি ব্যান্ডউইথ পেমেন্ট',
        CreatedAt: '2026-11-02T12:00:00Z',
      },
      {
        ExpenseID: 'EX-401102',
        Date: '2026-11-05',
        Category: 'অফিস ভাড়া',
        PaymentAccount: 'Cash',
        Amount: 2500,
        Note: 'নভেম্বর মাসের অফিস ভাড়া আংশিক',
        CreatedAt: '2026-11-05T11:00:00Z',
      },
      {
        ExpenseID: 'EX-401103',
        Date: '2026-11-09',
        Category: 'কেবল ও যন্ত্রপাতি',
        PaymentAccount: 'bKash',
        Amount: 1100,
        Note: 'অপটিক্যাল ফাইবার প্যাচ কর্ড ও স্প্লিটার',
        CreatedAt: '2026-11-09T15:30:00Z',
      },
    ],
    smsLogs: [
      {
        SmsID: 'SMS-801101',
        Timestamp: '2026-11-10T11:30:05Z',
        CustomerID: 'NB-1008',
        CustomerName: 'তানভীর হাসান',
        Mobile: '01733-889900',
        ReceiptID: 'P-601027',
        Provider: 'sandbox',
        Message:
          'প্রিয় তানভীর হাসান (NB-1008), নভেম্বর ২০২৬ মাসের ৳2,500 বিল (ব্যাংক (Bank)) পরিশোধ হয়েছে। রিসিট: P-601027। ধন্যবাদ - নেটবিল আইএসপি এন্ড ক্যাবল নেটওয়ার্ক',
        Status: 'Simulated',
        GatewayResponse: 'স্যান্ডবক্স মোডে নমুনা SMS রেকর্ড হয়েছে',
      },
    ],
  };
}

function ensureDb(): DatabaseSchema {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const seed = createSeedDatabase();
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), 'utf8');
    return seed;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw) as DatabaseSchema;
  if (!parsed.settings.SmsConfig) {
    parsed.settings.SmsConfig = { ...DEFAULT_SMS_CONFIG };
  }
  if (!Array.isArray(parsed.smsLogs)) {
    parsed.smsLogs = [];
  }
  if (!parsed.settings.DueReminder) {
    parsed.settings.DueReminder = { ...DEFAULT_DUE_REMINDER };
  }
  return parsed;
}

function writeDbAtomic(db: DatabaseSchema): void {
  const tmp = `${DB_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

// Mutex lock queue equivalent to LockService.getScriptLock()
let lockPromise: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = lockPromise.then(() => fn(), () => fn());
  lockPromise = next.catch(() => {});
  return next;
}

function computeCollectorSummaries(db: DatabaseSchema): CollectorSummary[] {
  return db.collectors.map((col) => {
    const cashCollected = db.collections
      .filter((c) => c.CollectedBy === col.Username && c.PaymentMethod === 'Cash')
      .reduce((sum, c) => sum + c.Amount, 0);

    const digitalCollected = db.collections
      .filter((c) => c.CollectedBy === col.Username && c.PaymentMethod !== 'Cash')
      .reduce((sum, c) => sum + c.Amount, 0);

    const totalDeposited = db.deposits
      .filter((d) => d.CollectorUsername === col.Username)
      .reduce((sum, d) => sum + d.Amount, 0);

    return {
      CollectorID: col.CollectorID,
      Name: col.Name,
      Mobile: col.Mobile,
      Username: col.Username,
      AssignedAreas: col.AssignedAreas,
      Status: col.Status,
      cashCollected,
      digitalCollected,
      totalDeposited,
      handCash: Math.max(0, cashCollected - totalDeposited),
    };
  });
}

function computeAccountBalances(db: DatabaseSchema): AccountBalances {
  const accounts: Record<PaymentMethod, number> = {
    Cash: 0,
    bKash: 0,
    Nagad: 0,
    Rocket: 0,
    Bank: 0,
  };

  let totalIncome = 0;

  for (const col of db.collections) {
    if (col.PaymentMethod === 'Cash') {
      // Only Admin direct Cash collections go immediately into Admin Office Cash.
      // Collector Cash stays in Collector Hand Cash until deposited!
      if (col.CollectorRole === 'Admin') {
        accounts.Cash += col.Amount;
        totalIncome += col.Amount;
      }
    } else {
      // Digital payments (bKash, Nagad, Rocket, Bank) go directly to Company Digital Accounts
      accounts[col.PaymentMethod] += col.Amount;
      totalIncome += col.Amount;
    }
  }

  for (const dep of db.deposits) {
    accounts[dep.DepositMethod] += dep.Amount;
    totalIncome += dep.Amount;
  }

  let totalExpense = 0;
  for (const exp of db.expenses) {
    accounts[exp.PaymentAccount] -= exp.Amount;
    totalExpense += exp.Amount;
  }

  return {
    Cash: accounts.Cash,
    bKash: accounts.bKash,
    Nagad: accounts.Nagad,
    Rocket: accounts.Rocket,
    Bank: accounts.Bank,
    totalIncome,
    totalExpense,
    netBalance: totalIncome - totalExpense,
  };
}

interface CollectBillParams {
  customerId: string;
  billingMonth: string;
  amount: number;
  paymentMethod: PaymentMethod;
  trxId: string;
  senderAccount: string;
  collectedBy: string;
  collectorRole: 'Admin' | 'User' | 'Self-EBill';
  note: string;
  date?: string;
}

function collectBillInternal(db: DatabaseSchema, rawParams: CollectBillParams): Collection {
  const params: CollectBillParams = {
    ...rawParams,
    trxId: String(rawParams.trxId ?? '').trim(),
    senderAccount: String(rawParams.senderAccount ?? '').trim().slice(0, 40),
    note: String(rawParams.note ?? '').trim().slice(0, 300),
  };
  const customer = db.customers.find((c) => c.CustomerID === params.customerId);
  if (!customer) {
    throw new Error('গ্রাহক পাওয়া যায়নি।');
  }
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('টাকার পরিমাণ অবশ্যই ০ এর বেশি হতে হবে।');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw new Error('টাকার পরিমাণ অস্বাভাবিক বেশি। সঠিক পরিমাণ লিখুন।');
  }
  if (!ALLOWED_PAYMENT_METHODS.includes(params.paymentMethod)) {
    throw new Error('পেমেন্টের মাধ্যম সঠিক নয়।');
  }

  if (params.paymentMethod !== 'Cash') {
    if (!params.trxId) {
      throw new Error('ডিজিটাল পেমেন্টের জন্য TrxID / রেফারেন্স নম্বর আবশ্যক।');
    }
    if (!TRX_ID_PATTERN.test(params.trxId)) {
      throw new Error('TrxID সঠিক নয় (৪–৪০ অক্ষর; শুধু ইংরেজি অক্ষর, সংখ্যা, - _ .)।');
    }
    const lower = params.trxId.toLowerCase();
    if (db.collections.some((c) => c.PaymentMethod !== 'Cash' && String(c.TrxID).toLowerCase() === lower)) {
      throw new DuplicateTrxError();
    }
  }
  if (params.date && !/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    throw new Error('তারিখের ফরম্যাট সঠিক নয়।');
  }

  const targetMonth = params.billingMonth || todayStr().slice(0, 7);
  if (!isValidBillingMonth(targetMonth)) {
    throw new Error('বিলিং মাস সঠিক নয়।');
  }

  if (targetMonth === 'Opening') {
    const openingBill = db.bills.find(
      (b) => b.CustomerID === customer.CustomerID && b.BillType === 'Opening'
    );
    if (!openingBill) {
      throw new Error('এই গ্রাহকের কোনো পূর্বের বকেয়া (Opening Balance) নেই।');
    }
    if (openingBill.Status === 'পরিশোধিত' || openingBill.DueAmount <= 0) {
      throw new Error('পূর্বের বকেয়া ইতিমধ্যেই সম্পূর্ণ পরিশোধিত হয়েছে।');
    }
    const applied = Math.min(amount, openingBill.DueAmount);
    openingBill.PaidAmount += applied;
    openingBill.DueAmount = Math.max(0, openingBill.Amount - openingBill.PaidAmount);
    openingBill.Status = openingBill.DueAmount === 0 ? 'পরিশোধিত' : 'আংশিক';

    let remaining = amount - applied;
    let rollMonth = todayStr().slice(0, 7);
    let guard = 0;
    while (remaining > 0 && guard < 12) {
      guard++;
      let bill = db.bills.find(
        (b) => b.CustomerID === customer.CustomerID && b.BillingMonth === rollMonth
      );
      if (!bill) {
        bill = {
          BillID: randomId('BL'),
          CustomerID: customer.CustomerID,
          BillingMonth: rollMonth,
          MonthLabel: getMonthLabelBn(rollMonth),
          BillType: 'Monthly',
          Amount: customer.MonthlyBill,
          PaidAmount: 0,
          DueAmount: customer.MonthlyBill,
          Status: 'বকেয়া',
          GeneratedDate: todayStr(),
        };
        db.bills.push(bill);
      }
      if (bill.DueAmount > 0) {
        const pay = Math.min(remaining, bill.DueAmount);
        bill.PaidAmount += pay;
        bill.DueAmount = Math.max(0, bill.Amount - bill.PaidAmount);
        bill.Status = bill.DueAmount === 0 ? 'পরিশোধিত' : 'আংশিক';
        remaining -= pay;
      }
      rollMonth = nextMonthYYYYMM(rollMonth);
    }
  } else {
    const existing = db.bills.find(
      (b) => b.CustomerID === customer.CustomerID && b.BillingMonth === targetMonth
    );
    if (existing && (existing.Status === 'পরিশোধিত' || existing.DueAmount <= 0)) {
      throw new Error(`${getMonthLabelBn(targetMonth)} মাসের বিল ইতিমধ্যেই সম্পূর্ণ পরিশোধিত হয়েছে।`);
    }

    let remaining = amount;
    let curMonth = targetMonth;
    let guard = 0;
    while (remaining > 0 && guard < 12) {
      guard++;
      let bill = db.bills.find(
        (b) => b.CustomerID === customer.CustomerID && b.BillingMonth === curMonth
      );
      if (!bill) {
        bill = {
          BillID: randomId('BL'),
          CustomerID: customer.CustomerID,
          BillingMonth: curMonth,
          MonthLabel: getMonthLabelBn(curMonth),
          BillType: 'Monthly',
          Amount: customer.MonthlyBill,
          PaidAmount: 0,
          DueAmount: customer.MonthlyBill,
          Status: 'বকেয়া',
          GeneratedDate: todayStr(),
        };
        db.bills.push(bill);
      }
      if (bill.DueAmount > 0) {
        const pay = Math.min(remaining, bill.DueAmount);
        bill.PaidAmount += pay;
        bill.DueAmount = Math.max(0, bill.Amount - bill.PaidAmount);
        bill.Status = bill.DueAmount === 0 ? 'পরিশোধিত' : 'আংশিক';
        remaining -= pay;
      }
      curMonth = nextMonthYYYYMM(curMonth);
    }
  }

  const receipt: Collection = {
    ReceiptID: randomId('P'),
    Date: params.date || todayStr(),
    CustomerID: customer.CustomerID,
    CustomerName: customer.Name,
    Area: customer.Area,
    BillingMonth: targetMonth,
    Amount: amount,
    PaymentMethod: params.paymentMethod,
    TrxID: params.trxId.trim(),
    SenderAccount: params.senderAccount.trim(),
    CollectedBy: params.collectedBy,
    CollectorRole: params.collectorRole,
    Note: params.note.trim(),
    CreatedAt: new Date().toISOString(),
  };

  db.collections.unshift(receipt);
  return receipt;
}

interface AuthedRequest extends Request {
  user?: SessionUser;
}

function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const base = token ? sessions.get(token) : undefined;
  const meta = token ? sessionMeta.get(token) : undefined;
  const now = Date.now();
  const expired =
    !base ||
    !meta ||
    now - meta.lastSeen > SESSION_IDLE_MS ||
    now - meta.createdAt > SESSION_MAX_MS;
  if (!token || expired || !base || !meta) {
    if (token) destroySession(token);
    res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ হয়েছে, অনুগ্রহ করে পুনরায় লগইন করুন।' });
    return;
  }

  // Re-check the account on every request so deactivation / area changes apply immediately
  const db = ensureDb();
  let user: SessionUser = base;
  if (base.role === 'Admin') {
    if (base.username !== db.settings.AdminUsername) {
      destroySession(token);
      res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ হয়েছে, অনুগ্রহ করে পুনরায় লগইন করুন।' });
      return;
    }
  } else {
    const col = db.collectors.find((c) => c.Username === base.username);
    if (!col || col.Status !== 'এক্টিভ') {
      destroySession(token);
      res.status(401).json({ error: 'আপনার অ্যাকাউন্ট নিষ্ক্রিয় বা মুছে ফেলা হয়েছে।' });
      return;
    }
    user = { ...base, name: col.Name, assignedAreas: col.AssignedAreas };
  }
  meta.lastSeen = now;
  req.user = user;
  next();
}

// ─────────────────────────────────────────────────────────────
// ONE-TIME PAYMENT-LINK SMS + AUTOMATIC MONTHLY BILLS
// Every customer gets ONE SMS with a permanent personal link. Whenever the customer opens that link it shows
// the CURRENT dues (this month's bill, or "no due" once paid). New months' bills are created automatically,
// so nothing has to be sent again.
// ─────────────────────────────────────────────────────────────
const DEFAULT_DUE_REMINDER: DueReminderConfig = {
  Enabled: false,
  SendHour: 10,
  DeadlineDay: 10,
  AutoGenerateBills: true,
  Template:
    'Dear {Name}, আপনার ইন্টারনেট বিল দেখতে ও পেমেন্ট করতে নিচের লিংকে ক্লিক করুন {PayLink} প্রতি মাসের ১ থেকে {DeadlineDay} তারিখের মধ্যে বিল পরিশোধ করুন। লিংকটি সংরক্ষণ করে রাখুন, প্রতি মাসে এই লিংকেই আপনার বিল দেখতে পাবেন। Thanks {Company}',
};

function getDueReminderConfig(settings: SettingsData): DueReminderConfig {
  const raw: Partial<DueReminderConfig> = settings.DueReminder || {};
  return {
    Enabled: raw.Enabled ?? DEFAULT_DUE_REMINDER.Enabled,
    SendHour: raw.SendHour ?? DEFAULT_DUE_REMINDER.SendHour,
    DeadlineDay: raw.DeadlineDay ?? DEFAULT_DUE_REMINDER.DeadlineDay,
    AutoGenerateBills: raw.AutoGenerateBills ?? DEFAULT_DUE_REMINDER.AutoGenerateBills,
    Template: raw.Template || DEFAULT_DUE_REMINDER.Template,
  };
}

interface ReminderState {
  lastRunDate: string;
  /** customerId → date the link SMS was sent (each customer gets it only once) */
  linkSent: Record<string, string>;
  /** month (YYYY-MM) for which bills were last generated automatically */
  billsMonth: string;
}

function getReminderState(db: DatabaseSchema): ReminderState {
  const s = (db.dueReminder || {}) as Partial<ReminderState>;
  return { lastRunDate: s.lastRunDate || '', linkSent: s.linkSent || {}, billsMonth: s.billsMonth || '' };
}

/** Current date / hour in Bangladesh time, regardless of the server's own timezone. */
function dhakaNow(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '0';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function getEnvBaseUrl(): string {
  const env = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(env) && !/MY_APP_URL/i.test(env) ? env : '';
}

/** Creates this month's bill for one customer if it doesn't exist yet. Returns true if created. */
function ensureBillForCustomer(db: DatabaseSchema, cust: Customer, month: string, today: string): boolean {
  if (cust.Status !== 'এক্টিভ' || !(cust.MonthlyBill > 0)) return false;
  if (db.bills.some((b) => b.CustomerID === cust.CustomerID && b.BillingMonth === month)) return false;
  db.bills.push({
    BillID: randomId('BL'),
    CustomerID: cust.CustomerID,
    BillingMonth: month,
    MonthLabel: getMonthLabelBn(month),
    BillType: 'Monthly',
    Amount: cust.MonthlyBill,
    PaidAmount: 0,
    DueAmount: cust.MonthlyBill,
    Status: 'বকেয়া',
    GeneratedDate: today,
  });
  cust.NextBillDate = addOneMonthStr(cust.NextBillDate || `${month}-01`);
  return true;
}

function autoGenerateBillsForMonth(db: DatabaseSchema, month: string, today: string): number {
  let created = 0;
  for (const cust of db.customers) {
    if (ensureBillForCustomer(db, cust, month, today)) created++;
  }
  return created;
}

/**
 * Creates the new month's bills for all active customers (once per month; catches up if the server was down).
 * Runs when the link feature is switched on, or when `force` is set (manual "send now").
 */
async function ensureMonthlyBills(force: boolean): Promise<number> {
  const now = dhakaNow();
  const month = now.date.slice(0, 7);
  const db0 = ensureDb();
  const cfg = getDueReminderConfig(db0.settings);
  if (!cfg.AutoGenerateBills || !(force || cfg.Enabled)) return 0;
  if (getReminderState(db0).billsMonth === month) return 0;
  return withLock(() => {
    const db = ensureDb();
    const created = autoGenerateBillsForMonth(db, month, now.date);
    const st = getReminderState(db);
    st.billsMonth = month;
    db.dueReminder = st;
    writeDbAtomic(db);
    return created;
  });
}

/** When a customer opens the link and this month's bill is missing, create it, so the link is never out of date. */
async function ensureCurrentBillFor(customerId: string): Promise<void> {
  const now = dhakaNow();
  const month = now.date.slice(0, 7);
  const db0 = ensureDb();
  const cfg = getDueReminderConfig(db0.settings);
  if (!cfg.Enabled || !cfg.AutoGenerateBills) return;
  const c0 = db0.customers.find((c) => c.CustomerID === customerId);
  if (!c0 || db0.bills.some((b) => b.CustomerID === customerId && b.BillingMonth === month)) return;
  await withLock(() => {
    const db = ensureDb();
    const c = db.customers.find((x) => x.CustomerID === customerId);
    if (c && ensureBillForCustomer(db, c, month, now.date)) writeDbAtomic(db);
  });
}

/** Active customers with a mobile number who have NOT received the link yet. */
function computeLinkTargets(db: DatabaseSchema): Customer[] {
  const sent = getReminderState(db).linkSent;
  return db.customers.filter((c) => c.Status === 'এক্টিভ' && c.Mobile && !sent[c.CustomerID]);
}

function renderLinkMessage(
  tpl: string,
  c: Customer,
  link: string,
  company: string,
  deadlineDay: number
): string {
  return tpl
    .replace(/\{Name\}/g, () => c.Name)
    .replace(/\{ID\}/g, () => c.CustomerID)
    .replace(/\{DeadlineDay\}/g, () => toBnDigits(deadlineDay))
    .replace(/\{PayLink\}/g, () => link)
    .replace(/\{Company\}/g, () => company)
    .slice(0, 480);
}

interface ReminderResult {
  ok: boolean;
  reason?: string;
  date: string;
  month: string;
  eligible: number;
  alreadySent: number;
  generatedBills: number;
  sent: number;
  failed: number;
  sample: string;
  hasLink: boolean;
}

let reminderRunning = false;
const reminderAttempts = new Map<string, number>();
let warnedNoBaseUrlOn = '';

async function markLinksSent(date: string, customers: Customer[]): Promise<void> {
  await withLock(() => {
    const db = ensureDb();
    const st = getReminderState(db);
    for (const c of customers) st.linkSent[c.CustomerID] = date;
    st.lastRunDate = date;
    db.dueReminder = st;
    writeDbAtomic(db);
  });
}

async function runDueReminders(opts: {
  auto: boolean;
  dryRun: boolean;
  baseUrl: string;
}): Promise<ReminderResult> {
  const now = dhakaNow();
  const month = now.date.slice(0, 7);
  const db0 = ensureDb();
  const cfg = getDueReminderConfig(db0.settings);
  const state0 = getReminderState(db0);
  const base: ReminderResult = {
    ok: true,
    date: now.date,
    month,
    eligible: 0,
    alreadySent: db0.customers.filter((c) => state0.linkSent[c.CustomerID]).length,
    generatedBills: 0,
    sent: 0,
    failed: 0,
    sample: '',
    hasLink: Boolean(opts.baseUrl),
  };

  if (opts.auto) {
    if (!cfg.Enabled) return { ...base, ok: false, reason: 'disabled' };
    if (now.hour < cfg.SendHour) return { ...base, ok: false, reason: 'too-early' };
    if ((reminderAttempts.get(now.date) || 0) >= 3) return { ...base, ok: false, reason: 'max-attempts' };
  }

  const targets0 = computeLinkTargets(db0);
  base.eligible = targets0.length;
  if (cfg.AutoGenerateBills) {
    const sim = JSON.parse(JSON.stringify(db0)) as DatabaseSchema;
    base.generatedBills = getReminderState(db0).billsMonth === month ? 0 : autoGenerateBillsForMonth(sim, month, now.date);
  }
  const linkFor = (id: string) =>
    opts.baseUrl ? `${opts.baseUrl}/?page=pay&cid=${encodeURIComponent(id)}` : '(APP_URL সেট করুন)';
  const render = (c: Customer, link: string) =>
    renderLinkMessage(cfg.Template, c, link, db0.settings.CompanyName, cfg.DeadlineDay);
  if (targets0.length > 0) base.sample = render(targets0[0], linkFor(targets0[0].CustomerID));
  if (opts.dryRun || targets0.length === 0) return base;

  if (cfg.Template.includes('{PayLink}') && !opts.baseUrl) return { ...base, ok: false, reason: 'no-base-url' };
  if (!db0.settings.SmsConfig?.Enabled) return { ...base, ok: false, reason: 'sms-disabled' };
  if (reminderRunning) return { ...base, ok: false, reason: 'busy' };

  reminderRunning = true;
  try {
    if (opts.auto) reminderAttempts.set(now.date, (reminderAttempts.get(now.date) || 0) + 1);

    // Make sure this month's bills exist first, so the link shows what to pay
    base.generatedBills = await ensureMonthlyBills(true);

    const db1 = ensureDb();
    const targets = computeLinkTargets(db1);
    base.eligible = targets.length;
    const succeeded: Customer[] = [];
    for (const c of targets.slice(0, 500)) {
      try {
        const log = await dispatchSmsAndLog({
          customerId: c.CustomerID,
          customerName: c.Name,
          mobile: c.Mobile,
          receiptId: 'DUE-REMINDER',
          message: render(c, linkFor(c.CustomerID)),
          settings: db1.settings,
          createId: randomId,
          persistSmsLog,
        });
        if (log.Status === 'Failed') base.failed++;
        else {
          base.sent++;
          succeeded.push(c);
        }
      } catch {
        base.failed++;
      }
    }
    if (succeeded.length > 0) await markLinksSent(now.date, succeeded);
    return base;
  } finally {
    reminderRunning = false;
  }
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'Admin') {
    res.status(403).json({ error: 'এই কাজটি শুধুমাত্র অ্যাডমিন করতে পারবেন।' });
    return;
  }
  next();
}

function verifyAdminPassword(db: DatabaseSchema, password: string | undefined): boolean {
  return verifyPassword(password, db.settings.AdminPassword);
}

async function persistSmsLog(logEntry: SmsLog): Promise<void> {
  await withLock(() => {
    const db = ensureDb();
    db.smsLogs.unshift(logEntry);
    if (db.smsLogs.length > 500) {
      db.smsLogs = db.smsLogs.slice(0, 500);
    }
    writeDbAtomic(db);
  });
}

/**
 * Unified backend payment processor for the 'Collections' store.
 * Atomically records the receipt + reconciles bills, then automatically triggers
 * `onCollectionPaymentProcessed` to format and dispatch the Bengali confirmation SMS.
 */
async function processCollectionPayment(options: {
  prepareAndValidate?: (db: DatabaseSchema) => {
    params: CollectBillParams;
    fallbackMobile?: string;
    afterInsert?: (db: DatabaseSchema, receipt: Collection) => void;
  };
  params?: CollectBillParams;
  fallbackMobile?: string;
  afterInsert?: (db: DatabaseSchema, receipt: Collection) => void;
}): Promise<{ receipt: Collection; smsLog: SmsLog | null }> {
  const committed = await withLock(() => {
    const db = ensureDb();
    const prepared = options.prepareAndValidate
      ? options.prepareAndValidate(db)
      : {
          params: options.params!,
          fallbackMobile: options.fallbackMobile,
          afterInsert: options.afterInsert,
        };

    const receipt = collectBillInternal(db, prepared.params);
    if (prepared.afterInsert) {
      prepared.afterInsert(db, receipt);
    }
    const customer = db.customers.find((c) => c.CustomerID === receipt.CustomerID);
    const mobile = prepared.fallbackMobile || customer?.Mobile || '';
    writeDbAtomic(db);
    return { receipt, mobile, settings: db.settings };
  });

  const smsLog = await onCollectionPaymentProcessed({
    receipt: committed.receipt,
    customerMobile: committed.mobile,
    settings: committed.settings,
    monthLabel: getMonthLabelBn(committed.receipt.BillingMonth),
    createId: randomId,
    persistSmsLog,
  });

  return { receipt: committed.receipt, smsLog };
}

/**
 * Runs once at startup:
 *  - replaces default / empty passwords with strong ones (printed ONCE in the server console)
 *  - hashes any plain-text password left over from older versions
 *  - replaces the demo / missing webhook secret with a random one (visible to the admin in Settings)
 */
function hardenCredentials(): void {
  const db = ensureDb();
  let changed = false;
  const notices: string[] = [];

  const envPw = (process.env.ADMIN_PASSWORD || '').trim();
  const envPwOk = envPw.length >= MIN_PASSWORD_LENGTH && !WEAK_PASSWORDS.includes(envPw.toLowerCase());
  const forceReset = ['1', 'true'].includes(String(process.env.RESET_ADMIN_PASSWORD || '').toLowerCase());

  // ---- Admin ----
  const adminStored = db.settings.AdminPassword;
  const adminIsDefault =
    !adminStored || DEFAULT_ADMIN_PASSWORDS.some((p) => verifyPassword(p, adminStored));
  if (forceReset && envPwOk) {
    db.settings.AdminPassword = hashPassword(envPw);
    changed = true;
    notices.push(`অ্যাডমিন (${db.settings.AdminUsername}) পাসওয়ার্ড .env-এর ADMIN_PASSWORD দিয়ে রিসেট করা হয়েছে।`);
  } else if (adminIsDefault) {
    const pw = envPwOk ? envPw : generatePassword();
    db.settings.AdminPassword = hashPassword(pw);
    changed = true;
    notices.push(
      envPwOk
        ? `অ্যাডমিন (${db.settings.AdminUsername}) পাসওয়ার্ড .env-এর ADMIN_PASSWORD থেকে সেট হয়েছে।`
        : `অ্যাডমিন লগইন → ইউজারনেম: ${db.settings.AdminUsername}   পাসওয়ার্ড: ${pw}`
    );
  } else if (!isHashedPassword(adminStored)) {
    db.settings.AdminPassword = hashPassword(adminStored);
    changed = true;
  }

  // ---- Collectors ----
  for (const col of db.collectors) {
    const stored = col.Password;
    const isDefault =
      !stored || DEFAULT_COLLECTOR_PASSWORDS.some((p) => verifyPassword(p, stored));
    if (isDefault) {
      const pw = generatePassword();
      col.Password = hashPassword(pw);
      changed = true;
      notices.push(`কালেক্টর লগইন → ইউজারনেম: ${col.Username}   পাসওয়ার্ড: ${pw}`);
    } else if (!isHashedPassword(stored)) {
      col.Password = hashPassword(stored);
      changed = true;
    }
  }

  // ---- Webhook secret ----
  const secret = db.settings.PaymentGatewayWebhookSecret || '';
  if (secret.length < 16 || secret === DEMO_WEBHOOK_SECRET) {
    db.settings.PaymentGatewayWebhookSecret = crypto.randomBytes(24).toString('hex');
    changed = true;
    notices.push('ওয়েবহুক সিক্রেট নতুন করে তৈরি হয়েছে (অ্যাডমিন → সেটিংস থেকে দেখা যাবে)।');
  }

  if (changed) {
    writeDbAtomic(db);
  }
  if (notices.length > 0) {
    console.log('\n================ NetBill ISP · নিরাপত্তা সেটআপ ================');
    for (const n of notices) console.log(`  • ${n}`);
    console.log('  এই পাসওয়ার্ডগুলো শুধু এই একবারই দেখানো হচ্ছে — লগইন করে নিজের পাসওয়ার্ড দিন।');
    console.log('==============================================================\n');
  }
}

async function startServer() {
  hardenCredentials();
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    // Needed so req.ip / req.secure are correct behind Nginx, Caddy, Cloud Run, etc.
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  }

  // Optional HTTPS redirect (only when running behind a TLS-terminating proxy)
  if (IS_PROD && process.env.FORCE_HTTPS === '1' && process.env.TRUST_PROXY) {
    app.use((req, res, next) => {
      if (req.secure) {
        next();
        return;
      }
      res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    });
  }

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Off by default because AI Studio shows the app inside an iframe. Set BLOCK_FRAMING=1 for production.
    if (process.env.BLOCK_FRAMING === '1') {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    if (IS_PROD && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  // Never serve server-side files. In dev mode Vite serves the whole project folder,
  // which would otherwise expose data/netbill-db.json (all customers!) and the server source.
  const BLOCKED_PATHS =
    /^\/(data|server|\.git|\.env[^/]*|\.vite)(\/|$)|^\/(server\.ts|package(-lock)?\.json|tsconfig\.json|vite\.config\.ts|metadata\.json|readme\.md|security-changes\.md|\.gitignore)$/i;
  app.use((req, res, next) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      res.status(400).send('Bad request');
      return;
    }
    if (decoded.includes('\0')) {
      res.status(400).send('Bad request');
      return;
    }
    const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
    if (normalized.startsWith('/@fs/') || BLOCKED_PATHS.test(normalized) || /\/\.env/i.test(normalized)) {
      res.status(404).send('Not found');
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  // Public Auth (rate limited, hashed passwords, uniform timing)
  app.post('/api/auth/login', async (req, res) => {
    const body = (req.body || {}) as { username?: unknown; password?: unknown };
    const u = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const p = typeof body.password === 'string' ? body.password.slice(0, 200) : '';

    const ipKey = `login-fail-ip:${req.ip}`;
    const pairKey = `login-fail-pair:${req.ip}|${u.toLowerCase()}`;
    const wait = Math.max(rateCheck(ipKey, 20), rateCheck(pairKey, 5));
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({
        error: `অনেকবার ভুল চেষ্টা করা হয়েছে। ${Math.ceil(wait / 60)} মিনিট পর আবার চেষ্টা করুন।`,
      });
      return;
    }

    const db = ensureDb();
    let sessionUser: SessionUser | null = null;

    if (u && u === db.settings.AdminUsername) {
      if (verifyPassword(p, db.settings.AdminPassword)) {
        sessionUser = {
          token: crypto.randomUUID(),
          role: 'Admin',
          username: u,
          name: 'অ্যাডমিনিস্ট্রেটর',
          assignedAreas: [],
        };
      }
    } else {
      const col = db.collectors.find((c) => c.Username === u);
      // Always run one hash verification so response time doesn't reveal valid usernames
      const ok = verifyPassword(p, col ? col.Password : DUMMY_HASH);
      if (col && ok && col.Status === 'এক্টিভ') {
        sessionUser = {
          token: crypto.randomUUID(),
          role: 'User',
          username: col.Username,
          name: col.Name,
          assignedAreas: col.AssignedAreas,
        };
      }
    }

    if (!sessionUser) {
      rateHit(ipKey, 15 * 60_000);
      rateHit(pairKey, 15 * 60_000);
      res.status(401).json({ error: 'ভুল ইউজারনেম অথবা পাসওয়ার্ড। অনুগ্রহ করে আবার চেষ্টা করুন।' });
      return;
    }

    rateClear(pairKey);
    createSession(sessionUser);
    res.json({ user: sessionUser });
  });

  app.get('/api/auth/session', authMiddleware, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  app.post('/api/auth/logout', authMiddleware, (req: AuthedRequest, res) => {
    if (req.user?.token) {
      destroySession(req.user.token);
    }
    res.json({ ok: true });
  });

  // Public E-Billing Portal Endpoints (No Login Required)
  // → rate limited, exact-match lookup, minimal data returned
  app.get('/api/public/lookup', rateLimit('lookup', 40, 60_000), async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
    const db = ensureDb();
    const {
      CompanyName,
      BusinessType,
      Address,
      Phone,
      BkashNumber,
      BkashType,
      NagadNumber,
      NagadType,
      RocketNumber,
      BankDetails,
    } = db.settings;

    const company = {
      CompanyName,
      BusinessType,
      Address,
      Phone,
      BkashNumber,
      BkashType,
      NagadNumber,
      NagadType,
      RocketNumber,
      BankDetails,
    };
    const empty = {
      company,
      customer: null,
      dueBills: [],
      totalDue: 0,
      lastPayment: null,
      recentRequests: [],
    };

    if (!q) {
      res.json(empty);
      return;
    }

    // Extra-strict limit on lookups that find nothing (blocks ID / number guessing)
    const missKey = `lookup-miss:${req.ip}`;
    const wait = rateCheck(missKey, 10);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'অনেকবার ভুল তথ্য দেওয়া হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      return;
    }

    // Exact match only: full customer ID, or the FULL mobile number (not just last digits)
    const qMobile = normalizeMobile(q);
    const customer =
      db.customers.find(
        (c) =>
          c.CustomerID.toLowerCase() === q ||
          (qMobile.length >= 10 && normalizeMobile(c.Mobile) === qMobile)
      ) || null;

    if (!customer) {
      rateHit(missKey, 10 * 60_000);
      res.json(empty);
      return;
    }

    // The link always shows the CURRENT situation: make sure this month's bill exists, then list what is unpaid
    await ensureCurrentBillFor(customer.CustomerID);
    const fresh = ensureDb();
    const monthKey = (b: { BillingMonth: string }) => (b.BillingMonth === 'Opening' ? '0000-00' : b.BillingMonth);
    const dueBills = fresh.bills
      .filter((b) => b.CustomerID === customer.CustomerID && b.DueAmount > 0)
      .sort((a, b) => monthKey(a).localeCompare(monthKey(b)));
    const totalDue = dueBills.reduce((s, b) => s + b.DueAmount, 0);
    const last = fresh.collections.find((c) => c.CustomerID === customer.CustomerID) || null;
    const recent = fresh.ePayments.filter((e) => e.CustomerID === customer.CustomerID).slice(0, 5);

    res.json({
      company,
      customer: {
        CustomerID: customer.CustomerID,
        Name: customer.Name,
        Area: customer.Area,
        Package: customer.Package,
        ServiceType: customer.ServiceType,
        MonthlyBill: customer.MonthlyBill,
        Status: customer.Status,
        Mobile: maskMobile(customer.Mobile),
      },
      dueBills,
      totalDue,
      lastPayment: last
        ? {
            ReceiptID: last.ReceiptID,
            Date: last.Date,
            BillingMonth: last.BillingMonth,
            Amount: last.Amount,
            PaymentMethod: last.PaymentMethod,
          }
        : null,
      recentRequests: recent.map((e) => ({
        RequestID: e.RequestID,
        SubmittedAt: e.SubmittedAt,
        BillingMonth: e.BillingMonth,
        Amount: e.Amount,
        PaymentMethod: e.PaymentMethod,
        TrxID: maskTrx(e.TrxID),
        Status: e.Status,
      })),
    });
  });

  app.post('/api/public/epayment', rateLimit('epay', 8, 10 * 60_000), async (req, res) => {
    try {
      const result = await withLock(() => {
        const db = ensureDb();
        const b = (req.body || {}) as Record<string, unknown>;
        const customerId = String(b.customerId ?? '').trim();
        const billingMonth = String(b.billingMonth ?? '').trim();
        const amount = Number(b.amount);
        const paymentMethod = String(b.paymentMethod ?? '');
        const sender = String(b.senderNumberOrAccount ?? '').trim();
        const trxId = String(b.trxId ?? '').trim();
        const note = String(b.note ?? '').trim().slice(0, 200);

        const customer = db.customers.find((c) => c.CustomerID === customerId);
        if (!customer) throw new Error('সঠিক গ্রাহক আইডি পাওয়া যায়নি।');
        if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PAYMENT_AMOUNT) {
          throw new Error('সঠিক টাকার পরিমাণ লিখুন।');
        }
        if (!PUBLIC_PAYMENT_METHODS.includes(paymentMethod)) {
          throw new Error('পেমেন্টের মাধ্যম সঠিক নয়।');
        }
        if (billingMonth && !isValidBillingMonth(billingMonth)) {
          throw new Error('বিলিং মাস সঠিক নয়।');
        }
        if (!sender || sender.length > 40) {
          throw new Error('প্রেরকের নম্বর বা অ্যাকাউন্ট নম্বর লিখুন।');
        }
        if (!TRX_ID_PATTERN.test(trxId)) {
          throw new Error('TrxID সঠিক নয় (৪–৪০ অক্ষর; শুধু ইংরেজি অক্ষর, সংখ্যা, - _ .)।');
        }

        const lower = trxId.toLowerCase();
        const dupReq = db.ePayments.find(
          (e) => e.TrxID.toLowerCase() === lower && e.Status !== 'Rejected'
        );
        const dupRec = db.collections.find(
          (c) => c.PaymentMethod !== 'Cash' && c.TrxID.toLowerCase() === lower
        );
        if (dupReq || dupRec) {
          throw new Error('এই TrxID দিয়ে ইতিমধ্যেই একটি অনুরোধ জমা দেওয়া হয়েছে।');
        }

        const pendingAll = db.ePayments.filter((e) => e.Status === 'Pending');
        if (pendingAll.filter((e) => e.CustomerID === customer.CustomerID).length >= 5) {
          throw new Error('এই গ্রাহকের ৫টি অনুরোধ যাচাইয়ের অপেক্ষায় আছে। যাচাই শেষ হওয়া পর্যন্ত অপেক্ষা করুন।');
        }
        if (pendingAll.length >= 1000) {
          throw new Error('সিস্টেম এখন ব্যস্ত। কিছুক্ষণ পর আবার চেষ্টা করুন।');
        }

        const reqRow: EPaymentRequest = {
          RequestID: randomId('EP'),
          SubmittedAt: new Date().toISOString(),
          CustomerID: customer.CustomerID,
          CustomerName: customer.Name,
          Mobile: customer.Mobile,
          BillingMonth: billingMonth || todayStr().slice(0, 7),
          Amount: amount,
          PaymentMethod: paymentMethod as Exclude<PaymentMethod, 'Cash'>,
          SenderNumberOrAccount: sender,
          TrxID: trxId,
          Status: 'Pending',
          ReviewedBy: '',
          ReviewedAt: '',
          Note: note,
        };

        db.ePayments.unshift(reqRow);
        writeDbAtomic(db);
        return reqRow;
      });
      // Don't echo internal fields (e.g. the customer's full mobile) back to the public caller
      res.json({ request: { ...result, Mobile: maskMobile(result.Mobile) } });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Automated Payment Gateway IPN / Webhook Hook
  // → timing-safe secret check, failure lockout, strict validation, replay-safe (duplicate TrxID)
  app.post('/api/webhook/epayment', rateLimit('webhook', 120, 60_000), async (req, res) => {
    const failKey = `webhook-fail:${req.ip}`;
    const wait = rateCheck(failKey, 10);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: 'Too many failed attempts' });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const provided = String(req.headers['x-webhook-secret'] || body.secret || '');
      const { receipt, smsLog } = await processCollectionPayment({
        prepareAndValidate: (db) => {
          const configured = db.settings.PaymentGatewayWebhookSecret || '';
          if (configured.length < 16) {
            throw new Error('Webhook is disabled until a strong secret (16+ chars) is set in Settings');
          }
          if (!provided || !safeEqual(provided, configured)) {
            throw new WebhookAuthError();
          }

          const customerId = String(body.customerId ?? '').trim();
          const trxId = String(body.trxId ?? '').trim();
          if (!customerId) throw new Error('customerId is required');
          if (!TRX_ID_PATTERN.test(trxId)) throw new Error('trxId is invalid');

          const pending = db.ePayments.find(
            (e) =>
              e.CustomerID === customerId &&
              e.TrxID.toLowerCase() === trxId.toLowerCase() &&
              e.Status === 'Pending'
          );
          const method = String(body.paymentMethod || pending?.PaymentMethod || 'bKash');
          if (!PUBLIC_PAYMENT_METHODS.includes(method)) throw new Error('paymentMethod is invalid');
          const billingMonth = String(body.billingMonth || pending?.BillingMonth || todayStr().slice(0, 7));
          if (!isValidBillingMonth(billingMonth)) throw new Error('billingMonth is invalid');

          return {
            params: {
              customerId,
              billingMonth,
              amount: Number(body.amount || pending?.Amount || 0),
              paymentMethod: method as PaymentMethod,
              trxId,
              senderAccount: String(body.senderAccount || pending?.SenderNumberOrAccount || '').slice(0, 40),
              collectedBy: 'AutoWebhook',
              collectorRole: 'Self-EBill',
              note: 'স্বয়ংক্রিয় গেটওয়ে ভেরিফিকেশন',
            },
            afterInsert: () => {
              if (pending) {
                pending.Status = 'Approved';
                pending.ReviewedBy = 'Webhook';
                pending.ReviewedAt = new Date().toISOString();
              }
            },
          };
        },
      });

      res.json({ ok: true, receipt, smsLog });
    } catch (err) {
      if (err instanceof WebhookAuthError) {
        rateHit(failKey, 10 * 60_000);
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }
      if (err instanceof DuplicateTrxError) {
        // Idempotent: a gateway retry of an already-recorded payment is acknowledged, not re-credited
        res.json({ ok: true, duplicate: true });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Bootstrap Dashboard Data (RBAC Scoped)
  app.get('/api/bootstrap', authMiddleware, (req: AuthedRequest, res) => {
    const db = ensureDb();
    const user = req.user!;
    const { AdminPassword: _hiddenPwd, ...safeSettings } = db.settings;
    // Collectors must never receive the webhook secret or the admin username
    const collectorSettings = { ...safeSettings, PaymentGatewayWebhookSecret: '', AdminUsername: '' };
    const smsEnvStatus = getSmsEnvStatus();

    if (user.role === 'Admin') {
      res.json({
        settings: safeSettings,
        areas: db.areas,
        collectors: db.collectors.map((c) => ({ ...c, Password: '••••••' })),
        customers: db.customers,
        bills: db.bills,
        collections: db.collections,
        ePayments: db.ePayments,
        deposits: db.deposits,
        expenses: db.expenses,
        smsLogs: db.smsLogs,
        smsEnvStatus,
        accountBalances: computeAccountBalances(db),
        collectorSummaries: computeCollectorSummaries(db),
      });
      return;
    }

    // Collector (User) strictly scoped to AssignedAreas
    const allowedSet = new Set(user.assignedAreas);
    const scopedCustomers = db.customers.filter((c) => allowedSet.has(c.Area));
    const scopedCustIds = new Set(scopedCustomers.map((c) => c.CustomerID));
    const scopedBills = db.bills.filter((b) => scopedCustIds.has(b.CustomerID));
    const scopedCollections = db.collections.filter(
      (c) => allowedSet.has(c.Area) || c.CollectedBy === user.username
    );
    const scopedDeposits = db.deposits.filter((d) => d.CollectorUsername === user.username);
    const scopedSmsLogs = db.smsLogs.filter((s) => scopedCustIds.has(s.CustomerID));
    const mySummary = computeCollectorSummaries(db).filter(
      (s) => s.Username === user.username
    );

    res.json({
      settings: collectorSettings,
      areas: db.areas.filter((a) => allowedSet.has(a.AreaName)),
      collectors: [],
      customers: scopedCustomers,
      bills: scopedBills,
      collections: scopedCollections,
      ePayments: [],
      deposits: scopedDeposits,
      expenses: [],
      smsLogs: scopedSmsLogs,
      smsEnvStatus,
      accountBalances: {
        Cash: 0,
        bKash: 0,
        Nagad: 0,
        Rocket: 0,
        Bank: 0,
        totalIncome: 0,
        totalExpense: 0,
        netBalance: 0,
      },
      collectorSummaries: mySummary,
    });
  });

  // Areas CRUD (Admin only)
  app.post('/api/areas', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const area = await withLock(() => {
        const db = ensureDb();
        const { AreaName, ServiceType } = req.body;
        if (!AreaName?.trim()) throw new Error('এরিয়ার নাম লিখুন।');
        if (db.areas.some((a) => a.AreaName === AreaName.trim())) {
          throw new Error('এই নামে এরিয়া ইতিমধ্যেই আছে।');
        }
        const row: Area = {
          AreaID: randomId('AR'),
          AreaName: AreaName.trim(),
          ServiceType: ServiceType || 'Both',
          CreatedAt: todayStr(),
        };
        db.areas.push(row);
        writeDbAtomic(db);
        return row;
      });
      res.json({ area });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/areas/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const updated = await withLock(() => {
        const db = ensureDb();
        const area = db.areas.find((a) => a.AreaID === req.params.id);
        if (!area) throw new Error('এরিয়া পাওয়া যায়নি।');
        const oldName = area.AreaName;
        const newName = String(req.body.AreaName || '').trim();
        if (!newName) throw new Error('এরিয়ার নাম খালি রাখা যাবে না।');
        area.AreaName = newName;
        area.ServiceType = req.body.ServiceType || area.ServiceType;
        if (oldName !== newName) {
          db.customers.forEach((c) => {
            if (c.Area === oldName) c.Area = newName;
          });
          db.collectors.forEach((col) => {
            col.AssignedAreas = col.AssignedAreas.map((a) => (a === oldName ? newName : a));
          });
        }
        writeDbAtomic(db);
        return area;
      });
      res.json({ area: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/areas/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        if (!verifyAdminPassword(db, req.body?.adminPassword)) {
          throw new Error('অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
        }
        const idx = db.areas.findIndex((a) => a.AreaID === req.params.id);
        if (idx === -1) throw new Error('এরিয়া পাওয়া যায়নি।');
        db.areas.splice(idx, 1);
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Collectors CRUD & Deposits (Admin only)
  app.post('/api/collectors', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const col = await withLock(() => {
        const db = ensureDb();
        const b = (req.body || {}) as Record<string, unknown>;
        const name = String(b.Name ?? '').trim();
        const username = String(b.Username ?? '').trim();
        const password = String(b.Password ?? '').trim();
        if (!name || !username || !password) {
          throw new Error('নাম, ইউজারনেম এবং পাসওয়ার্ড আবশ্যক।');
        }
        if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
          throw new Error('ইউজারনেম ৩–৩২ অক্ষরের হতে হবে (ইংরেজি অক্ষর, সংখ্যা, . _ -)।');
        }
        assertStrongPassword(password);
        if (
          username === db.settings.AdminUsername ||
          db.collectors.some((c) => c.Username === username)
        ) {
          throw new Error('এই ইউজারনেমটি ইতিমধ্যেই ব্যবহৃত হয়েছে।');
        }
        const row: Collector = {
          CollectorID: randomId('CL'),
          Name: name.slice(0, 120),
          Mobile: String(b.Mobile ?? '').trim().slice(0, 40),
          Username: username,
          Password: hashPassword(password),
          AssignedAreas: Array.isArray(b.AssignedAreas) ? b.AssignedAreas.map(String) : [],
          Status: (b.Status === 'ডি-এক্টিভ' ? 'ডি-এক্টিভ' : 'এক্টিভ') as Collector['Status'],
          CreatedAt: todayStr(),
        };
        db.collectors.push(row);
        writeDbAtomic(db);
        return { ...row, Password: MASKED_PASSWORD };
      });
      res.json({ collector: col });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/collectors/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const updated = await withLock(() => {
        const db = ensureDb();
        const b = (req.body || {}) as Record<string, unknown>;
        const col = db.collectors.find((c) => c.CollectorID === req.params.id);
        if (!col) throw new Error('কালেক্টর পাওয়া যায়নি।');
        col.Name = String(b.Name || col.Name).trim().slice(0, 120);
        col.Mobile = String(b.Mobile ?? col.Mobile).trim().slice(0, 40);
        let passwordChanged = false;
        if (b.Password && b.Password !== MASKED_PASSWORD) {
          const pw = String(b.Password).trim();
          assertStrongPassword(pw);
          col.Password = hashPassword(pw);
          passwordChanged = true;
        }
        if (Array.isArray(b.AssignedAreas)) {
          col.AssignedAreas = b.AssignedAreas.map(String);
        }
        if (b.Status === 'এক্টিভ' || b.Status === 'ডি-এক্টিভ') {
          col.Status = b.Status as Collector['Status'];
        }
        writeDbAtomic(db);
        if (passwordChanged || col.Status !== 'এক্টিভ') {
          revokeSessionsFor(col.Username);
        }
        return { ...col, Password: MASKED_PASSWORD };
      });
      res.json({ collector: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/collectors/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        if (!verifyAdminPassword(db, req.body?.adminPassword)) {
          throw new Error('অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
        }
        const idx = db.collectors.findIndex((c) => c.CollectorID === req.params.id);
        if (idx === -1) throw new Error('কালেক্টর পাওয়া যায়নি।');
        db.collectors.splice(idx, 1);
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/deposits', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const dep = await withLock(() => {
        const db = ensureDb();
        const { collectorUsername, amount, depositMethod, trxId, note, date } = req.body;
        const col = db.collectors.find((c) => c.Username === collectorUsername);
        if (!col) throw new Error('কালেক্টর পাওয়া যায়নি।');
        const amt = Number(amount);
        if (!amt || amt <= 0) throw new Error('সঠিক জমার পরিমাণ লিখুন।');
        const row: CollectorDeposit = {
          DepositID: randomId('DP'),
          Date: date || todayStr(),
          CollectorUsername: col.Username,
          CollectorName: col.Name,
          Amount: amt,
          DepositMethod: depositMethod || 'Cash',
          TrxID: (trxId || '').trim(),
          Note: (note || '').trim(),
          CreatedAt: new Date().toISOString(),
        };
        db.deposits.unshift(row);
        writeDbAtomic(db);
        return row;
      });
      res.json({ deposit: dep });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Customers CRUD
  app.post('/api/customers', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const customer = await withLock(() => {
        const db = ensureDb();
        const user = req.user!;
        const data = req.body;
        const custId = String(data.CustomerID || '').trim();
        if (!custId) throw new Error('গ্রাহক আইডি আবশ্যক।');
        if (!/^[A-Za-z0-9._-]{1,32}$/.test(custId)) {
          throw new Error('গ্রাহক আইডিতে শুধু ইংরেজি অক্ষর, সংখ্যা এবং . _ - ব্যবহার করুন (সর্বোচ্চ ৩২)।');
        }
        if (db.customers.some((c) => c.CustomerID.toLowerCase() === custId.toLowerCase())) {
          throw new Error('এই গ্রাহক আইডি ইতিমধ্যেই বিদ্যমান। অনুগ্রহ করে ভিন্ন আইডি দিন।');
        }
        if (user.role === 'User' && !user.assignedAreas.includes(data.Area)) {
          throw new Error('আপনার নির্ধারিত এরিয়ার বাইরে গ্রাহক যোগ করার অনুমতি নেই।');
        }
        const connDate = data.ConnectionDate || todayStr();
        // Only admins may set an opening (previous-dues) balance
        const opening = user.role === 'Admin' ? Number(data.OpeningBalance || 0) : 0;
        const monthlyBill = Number(data.MonthlyBill || 0);
        if (!Number.isFinite(opening) || opening < 0 || opening > MAX_PAYMENT_AMOUNT) {
          throw new Error('পূর্বের বকেয়ার পরিমাণ সঠিক নয়।');
        }
        if (!Number.isFinite(monthlyBill) || monthlyBill < 0 || monthlyBill > MAX_PAYMENT_AMOUNT) {
          throw new Error('মাসিক বিলের পরিমাণ সঠিক নয়।');
        }
        const status = data.Status || 'এক্টিভ';

        const newCust: Customer = {
          CustomerID: custId,
          Name: String(data.Name || '').trim(),
          Mobile: String(data.Mobile || '').trim(),
          Area: String(data.Area || '').trim(),
          Address: String(data.Address || '').trim(),
          ServiceType: data.ServiceType || 'Internet',
          Package: String(data.Package || '20 Mbps').trim(),
          MonthlyBill: monthlyBill,
          ConnectionDate: connDate,
          NextBillDate: addOneMonthStr(connDate),
          Status: status,
          OpeningBalance: opening,
          Note: String(data.Note || '').trim(),
          CreatedAt: todayStr(),
        };

        db.customers.unshift(newCust);

        if (opening > 0) {
          db.bills.push({
            BillID: randomId('BL'),
            CustomerID: newCust.CustomerID,
            BillingMonth: 'Opening',
            MonthLabel: 'পূর্বের বকেয়া',
            BillType: 'Opening',
            Amount: opening,
            PaidAmount: 0,
            DueAmount: opening,
            Status: 'বকেয়া',
            GeneratedDate: todayStr(),
          });
        }

        if (status === 'এক্টিভ' && monthlyBill > 0) {
          const firstMonth = connDate.slice(0, 7);
          db.bills.push({
            BillID: randomId('BL'),
            CustomerID: newCust.CustomerID,
            BillingMonth: firstMonth,
            MonthLabel: getMonthLabelBn(firstMonth),
            BillType: 'Monthly',
            Amount: monthlyBill,
            PaidAmount: 0,
            DueAmount: monthlyBill,
            Status: 'বকেয়া',
            GeneratedDate: todayStr(),
          });
        }

        writeDbAtomic(db);
        return newCust;
      });
      res.json({ customer });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/customers/:id', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const updated = await withLock(() => {
        const db = ensureDb();
        const user = req.user!;
        const cust = db.customers.find((c) => c.CustomerID === req.params.id);
        if (!cust) throw new Error('গ্রাহক পাওয়া যায়নি।');
        if (user.role === 'User' && !user.assignedAreas.includes(cust.Area)) {
          throw new Error('অন্য এরিয়ার গ্রাহক এডিট করার অনুমতি নেই।');
        }
        const d = req.body || {};
        if (user.role === 'User') {
          const differs = (a: unknown, b: unknown) => a !== undefined && String(a) !== String(b);
          if (
            differs(d.MonthlyBill, cust.MonthlyBill) ||
            differs(d.Package, cust.Package) ||
            differs(d.ServiceType, cust.ServiceType)
          ) {
            throw new Error('মাসিক বিল, প্যাকেজ বা সার্ভিস টাইপ শুধু অ্যাডমিন পরিবর্তন করতে পারবেন।');
          }
          if (d.Area !== undefined && !user.assignedAreas.includes(String(d.Area).trim())) {
            throw new Error('গ্রাহককে আপনার নির্ধারিত এরিয়ার বাইরে সরানো যাবে না।');
          }
        }
        const newMonthly = Number(d.MonthlyBill ?? cust.MonthlyBill);
        if (!Number.isFinite(newMonthly) || newMonthly < 0 || newMonthly > MAX_PAYMENT_AMOUNT) {
          throw new Error('মাসিক বিলের পরিমাণ সঠিক নয়।');
        }
        cust.Name = String(d.Name ?? cust.Name).trim();
        cust.Mobile = String(d.Mobile ?? cust.Mobile).trim();
        cust.Area = String(d.Area ?? cust.Area).trim();
        cust.Address = String(d.Address ?? cust.Address).trim();
        cust.ServiceType = d.ServiceType ?? cust.ServiceType;
        cust.Package = String(d.Package ?? cust.Package).trim();
        cust.MonthlyBill = Number(d.MonthlyBill ?? cust.MonthlyBill);
        cust.Status = d.Status ?? cust.Status;
        cust.Note = String(d.Note ?? cust.Note).trim();
        writeDbAtomic(db);
        return cust;
      });
      res.json({ customer: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/customers/:id/status', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const updated = await withLock(() => {
        const db = ensureDb();
        const user = req.user!;
        const cust = db.customers.find((c) => c.CustomerID === req.params.id);
        if (!cust) throw new Error('গ্রাহক পাওয়া যায়নি।');
        if (user.role === 'User' && !user.assignedAreas.includes(cust.Area)) {
          throw new Error('অন্য এরিয়ার গ্রাহকের স্ট্যাটাস পরিবর্তনের অনুমতি নেই।');
        }
        cust.Status = cust.Status === 'এক্টিভ' ? 'ডি-এক্টিভ' : 'এক্টিভ';
        writeDbAtomic(db);
        return cust;
      });
      res.json({ customer: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/customers/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        if (!verifyAdminPassword(db, req.body?.adminPassword)) {
          throw new Error('অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
        }
        const idx = db.customers.findIndex((c) => c.CustomerID === req.params.id);
        if (idx === -1) throw new Error('গ্রাহক পাওয়া যায়নি।');
        db.customers.splice(idx, 1);
        db.bills = db.bills.filter((b) => b.CustomerID !== req.params.id);
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Automatic Monthly Billing Generator
  app.post('/api/bills/generate', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const summary = await withLock(() => {
        const db = ensureDb();
        const user = req.user!;
        const targetMonth: string = String(req.body?.billingMonth || todayStr().slice(0, 7));
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
          throw new Error('বিলিং মাস সঠিক নয়।');
        }
        const mode: 'dueOnly' | 'allActive' = req.body?.mode || 'allActive';
        const refToday = todayStr();

        let createdCount = 0;
        let skippedCount = 0;

        for (const cust of db.customers) {
          if (user.role === 'User' && !user.assignedAreas.includes(cust.Area)) {
            continue;
          }
          if (cust.Status !== 'এক্টিভ') {
            skippedCount++;
            continue;
          }
          if (mode === 'dueOnly' && cust.NextBillDate > refToday) {
            continue;
          }

          const exists = db.bills.some(
            (b) => b.CustomerID === cust.CustomerID && b.BillingMonth === targetMonth
          );
          if (exists) {
            skippedCount++;
            continue;
          }

          db.bills.push({
            BillID: randomId('BL'),
            CustomerID: cust.CustomerID,
            BillingMonth: targetMonth,
            MonthLabel: getMonthLabelBn(targetMonth),
            BillType: 'Monthly',
            Amount: cust.MonthlyBill,
            PaidAmount: 0,
            DueAmount: cust.MonthlyBill,
            Status: 'বকেয়া',
            GeneratedDate: refToday,
          });
          cust.NextBillDate = addOneMonthStr(cust.NextBillDate || `${targetMonth}-01`);
          createdCount++;
        }

        writeDbAtomic(db);
        return { createdCount, skippedCount, billingMonth: targetMonth };
      });
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Collect Bill (Admin or Collector) + Automatic Bengali SMS Confirmation
  app.post('/api/collections', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const { receipt, smsLog } = await processCollectionPayment({
        prepareAndValidate: (db) => {
          const user = req.user!;
          const {
            customerId,
            billingMonth,
            amount,
            paymentMethod,
            trxId,
            senderAccount,
            note,
            date,
          } = req.body;

          const customer = db.customers.find((c) => c.CustomerID === customerId);
          if (!customer) throw new Error('গ্রাহক পাওয়া যায়নি।');
          if (user.role === 'User' && !user.assignedAreas.includes(customer.Area)) {
            throw new Error('আপনার নির্ধারিত এরিয়ার বাইরে বিল আদায়ের অনুমতি নেই।');
          }
          if (date !== undefined && date !== null && date !== '') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
              throw new Error('তারিখের ফরম্যাট সঠিক নয়।');
            }
            if (user.role === 'User') {
              const diffDays = Math.abs((Date.parse(String(date)) - Date.parse(todayStr())) / 86400000);
              if (!(diffDays <= 1)) {
                throw new Error('কালেক্টর শুধু আজকের তারিখে (±১ দিন) আদায়ের এন্ট্রি দিতে পারবেন।');
              }
            }
          }

          return {
            params: {
              customerId,
              billingMonth,
              amount: Number(amount),
              paymentMethod: paymentMethod || 'Cash',
              trxId: trxId || '',
              senderAccount: senderAccount || '',
              collectedBy: user.username,
              collectorRole: user.role,
              note: note || '',
              date,
            },
            fallbackMobile: customer.Mobile,
          };
        },
      });

      res.json({ receipt, smsLog });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Reverse & Delete Receipt (Admin + Password Required)
  app.delete('/api/collections/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        if (!verifyAdminPassword(db, req.body?.adminPassword)) {
          throw new Error('অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
        }
        const idx = db.collections.findIndex((c) => c.ReceiptID === req.params.id);
        if (idx === -1) throw new Error('রিসিট পাওয়া যায়নি।');
        const rec = db.collections[idx];

        // Reverse PaidAmount back to matching Bills starting from BillingMonth
        let toReverse = rec.Amount;
        const custBills = db.bills.filter((b) => b.CustomerID === rec.CustomerID);
        const startIdx = custBills.findIndex((b) => b.BillingMonth === rec.BillingMonth);
        const ordered =
          startIdx >= 0
            ? [...custBills.slice(startIdx), ...custBills.slice(0, startIdx)]
            : custBills;

        for (const bill of ordered) {
          if (toReverse <= 0) break;
          if (bill.PaidAmount > 0) {
            const rev = Math.min(toReverse, bill.PaidAmount);
            bill.PaidAmount -= rev;
            bill.DueAmount = Math.max(0, bill.Amount - bill.PaidAmount);
            bill.Status =
              bill.PaidAmount === 0
                ? 'বকেয়া'
                : bill.DueAmount === 0
                  ? 'পরিশোধিত'
                  : 'আংশিক';
            toReverse -= rev;
          }
        }

        db.collections.splice(idx, 1);
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // E-Payment Verification Queue (Admin only) + Automatic Bengali SMS Confirmation
  app.post('/api/epayments/:id/approve', authMiddleware, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const { receipt, smsLog } = await processCollectionPayment({
        prepareAndValidate: (db) => {
          const ep = db.ePayments.find((e) => e.RequestID === req.params.id);
          if (!ep) throw new Error('ই-পেমেন্ট অনুরোধ পাওয়া যায়নি।');
          if (ep.Status !== 'Pending') throw new Error('এই অনুরোধটি ইতিমধ্যেই যাচাই করা হয়েছে।');

          return {
            params: {
              customerId: ep.CustomerID,
              billingMonth: ep.BillingMonth,
              amount: ep.Amount,
              paymentMethod: ep.PaymentMethod,
              trxId: ep.TrxID,
              senderAccount: ep.SenderNumberOrAccount,
              collectedBy: 'Self-EBill',
              collectorRole: 'Self-EBill',
              note: `ই-পেমেন্ট অনুমোদিত (${ep.RequestID})`,
            },
            fallbackMobile: ep.Mobile,
            afterInsert: () => {
              ep.Status = 'Approved';
              ep.ReviewedBy = req.user!.username;
              ep.ReviewedAt = new Date().toISOString();
            },
          };
        },
      });

      res.json({ receipt, smsLog });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/epayments/:id/reject', authMiddleware, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        const ep = db.ePayments.find((e) => e.RequestID === req.params.id);
        if (!ep) throw new Error('ই-পেমেন্ট অনুরোধ পাওয়া যায়নি।');
        if (ep.Status !== 'Pending') throw new Error('এই অনুরোধটি ইতিমধ্যেই প্রসেস করা হয়েছে।');
        ep.Status = 'Rejected';
        ep.ReviewedBy = req.user!.username;
        ep.ReviewedAt = new Date().toISOString();
        if (req.body?.note) {
          ep.Note = String(req.body.note).trim();
        }
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/epayments/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        if (!verifyAdminPassword(db, req.body?.adminPassword)) {
          throw new Error('অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
        }
        const idx = db.ePayments.findIndex((e) => e.RequestID === req.params.id);
        if (idx === -1) throw new Error('অনুরোধ পাওয়া যায়নি।');
        db.ePayments.splice(idx, 1);
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Expenses (Admin only)
  app.post('/api/expenses', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const exp = await withLock(() => {
        const db = ensureDb();
        const { Date: dt, Category, PaymentAccount, Amount, Note } = req.body;
        const amt = Number(Amount);
        if (!amt || amt <= 0) throw new Error('সঠিক খরচের পরিমাণ লিখুন।');
        const row: Expense = {
          ExpenseID: randomId('EX'),
          Date: dt || todayStr(),
          Category: Category || 'আপ্যায়ন/অন্যান্য',
          PaymentAccount: PaymentAccount || 'Cash',
          Amount: amt,
          Note: String(Note || '').trim(),
          CreatedAt: new Date().toISOString(),
        };
        db.expenses.unshift(row);
        writeDbAtomic(db);
        return row;
      });
      res.json({ expense: exp });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/expenses/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      await withLock(() => {
        const db = ensureDb();
        if (!verifyAdminPassword(db, req.body?.adminPassword)) {
          throw new Error('অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
        }
        const idx = db.expenses.findIndex((e) => e.ExpenseID === req.params.id);
        if (idx === -1) throw new Error('খরচের ভাউচার পাওয়া যায়নি।');
        db.expenses.splice(idx, 1);
        writeDbAtomic(db);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Manual / Resend Receipt SMS (Admin or Collector for assigned areas)
  app.post('/api/sms/send', authMiddleware, rateLimit('sms-send', 30, 60_000), async (req: AuthedRequest, res) => {
    try {
      const { receiptId, customerId, message } = req.body as {
        receiptId?: string;
        customerId?: string;
        message?: string;
      };
      const db = ensureDb();
      const user = req.user!;

      if (typeof message === 'string' && message.length > 480) {
        throw new Error('বার্তা অনেক দীর্ঘ (সর্বোচ্চ ৪৮০ অক্ষর)।');
      }
      let targetCustomer: Customer | undefined;
      let receipt: Collection | undefined;

      if (receiptId) {
        receipt = db.collections.find((c) => c.ReceiptID === receiptId);
        if (!receipt) throw new Error('রিসিট পাওয়া যায়নি।');
        targetCustomer = db.customers.find((c) => c.CustomerID === receipt!.CustomerID);
      } else if (customerId) {
        targetCustomer = db.customers.find((c) => c.CustomerID === customerId);
      }

      if (!targetCustomer) throw new Error('গ্রাহক পাওয়া যায়নি।');
      if (user.role === 'User' && !user.assignedAreas.includes(targetCustomer.Area)) {
        throw new Error('আপনার নির্ধারিত এরিয়ার বাইরে SMS পাঠানোর অনুমতি নেই।');
      }
      if (!targetCustomer.Mobile) throw new Error('গ্রাহকের মোবাইল নম্বর পাওয়া যায়নি।');

      const smsText =
        message && message.trim()
          ? message.trim()
          : receipt
            ? formatBengaliCollectionSms({
                settings: db.settings,
                receipt,
                monthLabel: getMonthLabelBn(receipt.BillingMonth),
              })
            : `সম্মানিত ${targetCustomer.Name} (${targetCustomer.CustomerID}), ${db.settings.CompanyName}-এর পক্ষ থেকে শুভেচ্ছা।`;

      const smsLog = await dispatchSmsAndLog({
        customerId: targetCustomer.CustomerID,
        customerName: targetCustomer.Name,
        mobile: targetCustomer.Mobile,
        receiptId: receipt?.ReceiptID || 'MANUAL',
        message: smsText,
        settings: db.settings,
        createId: randomId,
        persistSmsLog,
      });

      res.json({ smsLog });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Bulk SMS Broadcast (Admin only)
  app.post('/api/sms/broadcast', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const { items } = req.body as {
        items?: { customerId: string; message: string }[];
      };
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('অন্তত একজন গ্রাহক নির্বাচন করুন।');
      }
      const db = ensureDb();
      const logs: SmsLog[] = [];
      const baseUrl = getPublicBaseUrl(req);
      const needsLink = items.slice(0, 100).some((i) => String(i?.message || '').includes('{PayLink}'));
      if (needsLink && !baseUrl) {
        throw new Error(
          'পেমেন্ট লিংক বানাতে .env ফাইলে APP_URL="https://আপনার-ওয়েবসাইট" দিন (localhost লিংক গ্রাহকের ফোনে খুলবে না)।'
        );
      }
      for (const item of items.slice(0, 100)) {
        const cust = db.customers.find((c) => c.CustomerID === item.customerId);
        if (!cust || !cust.Mobile) continue;
        const payLink = `${baseUrl}/?page=pay&cid=${encodeURIComponent(cust.CustomerID)}`;
        const log = await dispatchSmsAndLog({
          customerId: cust.CustomerID,
          customerName: cust.Name,
          mobile: cust.Mobile,
          receiptId: 'BROADCAST',
          message: String(item.message || '').replace(/\{PayLink\}/g, payLink).slice(0, 480),
          settings: db.settings,
          createId: randomId,
          persistSmsLog,
        });
        logs.push(log);
      }
      res.json({ sentCount: logs.length, logs });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Due-bill reminders: preview who would get an SMS today / send now (admin only)
  const reminderReasonText: Record<string, string> = {
    'no-base-url':
      'পেমেন্ট লিংক বানাতে .env ফাইলে APP_URL="https://আপনার-ওয়েবসাইট" দিন (localhost লিংক কাজ করবে না)।',
    'sms-disabled': 'SMS বন্ধ আছে। সেটিংস থেকে "SMS সার্ভিস চালু" করুন।',
    busy: 'আরেকটি রিমাইন্ডার পাঠানো চলছে, একটু পরে আবার চেষ্টা করুন।',
  };
  const reminderResponse = (r: ReminderResult) => {
    const db = ensureDb();
    return {
      ...r,
      enabled: getDueReminderConfig(db.settings).Enabled,
      lastRunDate: db.dueReminder?.lastRunDate || '',
    };
  };

  app.get('/api/reminders/due-preview', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const r = await runDueReminders({ auto: false, dryRun: true, baseUrl: getPublicBaseUrl(req) });
      res.json(reminderResponse(r));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post(
    '/api/reminders/due-run',
    authMiddleware,
    requireAdmin,
    rateLimit('due-run', 5, 60_000),
    async (req, res) => {
      try {
        const r = await runDueReminders({ auto: false, dryRun: false, baseUrl: getPublicBaseUrl(req) });
        if (!r.ok && r.reason && reminderReasonText[r.reason]) {
          res.status(400).json({ error: reminderReasonText[r.reason] });
          return;
        }
        res.json(reminderResponse(r));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }
  );

  // Settings (Admin only) – whitelisted fields, hashed password,
  // and the CURRENT password is required to set a new one.
  app.put('/api/settings', authMiddleware, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const safe = await withLock(() => {
        const db = ensureDb();
        const b = (req.body || {}) as Record<string, unknown>;
        const text = (v: unknown, max: number, label: string): string => {
          const s = String(v ?? '').trim();
          if (s.length > max) throw new Error(`${label} অনেক দীর্ঘ (সর্বোচ্চ ${max} অক্ষর)।`);
          return s;
        };

        const next: SettingsData = {
          ...db.settings,
          BankDetails: { ...db.settings.BankDetails },
          SmsConfig: { ...(db.settings.SmsConfig || DEFAULT_SMS_CONFIG) },
        };

        if (b.CompanyName !== undefined) next.CompanyName = text(b.CompanyName, 120, 'কোম্পানির নাম');
        if (b.BusinessType !== undefined) next.BusinessType = text(b.BusinessType, 80, 'ব্যবসার ধরন');
        if (b.Address !== undefined) next.Address = text(b.Address, 300, 'ঠিকানা');
        if (b.Phone !== undefined) next.Phone = text(b.Phone, 40, 'ফোন নম্বর');
        if (b.ScrollingNotice !== undefined) next.ScrollingNotice = text(b.ScrollingNotice, 600, 'নোটিস');
        if (b.BkashNumber !== undefined) next.BkashNumber = text(b.BkashNumber, 40, 'বিকাশ নম্বর');
        if (b.NagadNumber !== undefined) next.NagadNumber = text(b.NagadNumber, 40, 'নগদ নম্বর');
        if (b.RocketNumber !== undefined) next.RocketNumber = text(b.RocketNumber, 40, 'রকেট নম্বর');

        const accountTypes = ['Merchant', 'Personal', 'Agent'];
        if (typeof b.BkashType === 'string' && accountTypes.includes(b.BkashType)) {
          next.BkashType = b.BkashType as SettingsData['BkashType'];
        }
        if (typeof b.NagadType === 'string' && accountTypes.includes(b.NagadType)) {
          next.NagadType = b.NagadType as SettingsData['NagadType'];
        }

        if (b.BankDetails && typeof b.BankDetails === 'object') {
          const bd = b.BankDetails as Record<string, unknown>;
          for (const k of ['BankName', 'AccountName', 'AccountNo', 'Branch', 'Routing'] as const) {
            if (bd[k] !== undefined) next.BankDetails[k] = text(bd[k], 120, 'ব্যাংকের তথ্য');
          }
        }

        if (b.SmsConfig && typeof b.SmsConfig === 'object') {
          const sc = b.SmsConfig as Record<string, unknown>;
          if (typeof sc.Enabled === 'boolean') next.SmsConfig.Enabled = sc.Enabled;
          if (typeof sc.Provider === 'string' && ['twilio', 'local_bd', 'sandbox'].includes(sc.Provider)) {
            next.SmsConfig.Provider = sc.Provider as SmsProvider;
          }
          if (sc.SenderId !== undefined) next.SmsConfig.SenderId = text(sc.SenderId, 20, 'Sender ID');
          if (sc.PaymentSmsTemplate !== undefined) {
            next.SmsConfig.PaymentSmsTemplate = text(sc.PaymentSmsTemplate, 600, 'SMS টেমপ্লেট');
          }
        }

        if (b.DueReminder && typeof b.DueReminder === 'object') {
          const dr = b.DueReminder as Record<string, unknown>;
          const cur = getDueReminderConfig(db.settings);
          const intIn = (v: unknown, lo: number, hi: number, label: string): number => {
            const n = Math.floor(Number(v));
            if (!Number.isFinite(n) || n < lo || n > hi) {
              throw new Error(`${label} ${lo}–${hi} এর মধ্যে হতে হবে।`);
            }
            return n;
          };
          if (typeof dr.Enabled === 'boolean') cur.Enabled = dr.Enabled;
          if (typeof dr.AutoGenerateBills === 'boolean') cur.AutoGenerateBills = dr.AutoGenerateBills;
          if (dr.SendHour !== undefined) cur.SendHour = intIn(dr.SendHour, 0, 23, 'SMS যাওয়ার সময় (ঘণ্টা)');
          if (dr.DeadlineDay !== undefined) cur.DeadlineDay = intIn(dr.DeadlineDay, 1, 31, 'পেমেন্টের শেষ তারিখ');
          if (dr.Template !== undefined) {
            const tpl = text(dr.Template, 600, 'বার্তা');
            if (!tpl) throw new Error('বার্তা খালি রাখা যাবে না।');
            cur.Template = tpl;
          }
          next.DueReminder = cur;
        }

        let usernameChanged = false;
        if (b.AdminUsername !== undefined) {
          const nu = String(b.AdminUsername).trim();
          if (nu !== db.settings.AdminUsername) {
            if (!/^[A-Za-z0-9._-]{3,32}$/.test(nu)) {
              throw new Error('অ্যাডমিন ইউজারনেম ৩–৩২ অক্ষরের হতে হবে (ইংরেজি অক্ষর, সংখ্যা, . _ -)।');
            }
            if (db.collectors.some((c) => c.Username === nu)) {
              throw new Error('এই ইউজারনেমটি কোনো কালেক্টর ব্যবহার করছেন।');
            }
            next.AdminUsername = nu;
            usernameChanged = true;
          }
        }

        if (b.PaymentGatewayWebhookSecret !== undefined) {
          const ns = String(b.PaymentGatewayWebhookSecret).trim();
          if (ns && ns !== db.settings.PaymentGatewayWebhookSecret) {
            if (ns.length < 16 || ns.length > 128 || ns === DEMO_WEBHOOK_SECRET) {
              throw new Error('ওয়েবহুক সিক্রেট কমপক্ষে ১৬ অক্ষরের এবং সহজে অনুমান করা যায় না এমন হতে হবে।');
            }
            next.PaymentGatewayWebhookSecret = ns;
          }
        }

        let passwordChanged = false;
        const newPw = typeof b.AdminPassword === 'string' ? b.AdminPassword.trim() : '';
        if (newPw) {
          const current = typeof b.CurrentAdminPassword === 'string' ? b.CurrentAdminPassword : '';
          if (!verifyPassword(current, db.settings.AdminPassword)) {
            throw new Error('বর্তমান অ্যাডমিন পাসওয়ার্ড সঠিক নয়।');
          }
          assertStrongPassword(newPw);
          next.AdminPassword = hashPassword(newPw);
          passwordChanged = true;
        }

        db.settings = next;
        writeDbAtomic(db);

        if (usernameChanged) {
          for (const [, u] of sessions) {
            if (u.role === 'Admin') u.username = next.AdminUsername;
          }
        }
        if (passwordChanged) {
          // Sign out every other admin session after a password change
          revokeSessionsFor(next.AdminUsername, req.user?.token);
        }

        const { AdminPassword: _hidden, ...rest } = db.settings;
        return rest;
      });
      res.json({ settings: safe });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Vite Dev Middleware or Static Production Build
  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Generic JSON error handler (no stack traces or internals leaked)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: 'অনুরোধটি সঠিক নয়।' });
      return;
    }
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'সার্ভারে ত্রুটি হয়েছে।' });
  });

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  // Automatic due reminders: checked every 5 minutes, sent once per day after the configured hour
  const reminderTick = () => {
    ensureMonthlyBills(false)
      .then(() => runDueReminders({ auto: true, dryRun: false, baseUrl: getEnvBaseUrl() }))
      .then((r) => {
        if (r.reason === 'no-base-url' && warnedNoBaseUrlOn !== r.date) {
          warnedNoBaseUrlOn = r.date;
          console.warn('⚠ বকেয়া রিমাইন্ডার পাঠানো যায়নি: .env ফাইলে APP_URL="https://আপনার-ওয়েবসাইট" দিন।');
        }
        if (r.ok && (r.sent > 0 || r.failed > 0)) {
          console.log(`পেমেন্ট লিংকের SMS: ${r.sent} জনকে পাঠানো হয়েছে, ${r.failed} ব্যর্থ।`);
        }
      })
      .catch((e) => console.error('Due reminder error:', e));
  };
  setTimeout(reminderTick, 30_000).unref();
  setInterval(reminderTick, 5 * 60_000).unref();
  app.listen(port, host, () => {
    console.log(`NetBill ISP server listening on http://${host}:${port}`);
    if (!IS_PROD) {
      console.log(
        'ℹ ডেভেলপমেন্ট মোড চলছে। লাইভ ব্যবহারের জন্য: npm run build  এবং তারপর  npm run serve'
      );
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

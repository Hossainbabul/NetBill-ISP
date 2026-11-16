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
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'netbill-db.json');

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const DEMO_WEBHOOK_SECRET = 'nb_whsec_demo_2026';
const WEAK_PASSWORDS = new Set([
  '1234',
  '12345',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'admin',
  'admin123',
  'admin1234',
  'administrator',
  'password',
  'password123',
  'qwerty',
  'qwerty123',
  '00000000',
  '11111111',
  'letmein1',
  'welcome1',
  'netbill123',
]);

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
  const num = crypto.randomInt(100000, 1000000);
  return `${prefix}-${num}`;
}

function safeEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function isHashedPassword(stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  return parts.length === 3 && parts[0] === 'scrypt' && parts[1].length >= 16 && parts[2].length === 128;
}

function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain: string | undefined, stored: string | undefined): boolean {
  if (!plain || !stored) return false;
  if (isHashedPassword(stored)) {
    const [, salt, hexHash] = stored.split('$');
    const derived = crypto.scryptSync(plain, salt, 64);
    const expected = Buffer.from(hexHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }
  return safeEqual(plain, stored);
}

function isWeakPasswordValue(pwd: string): boolean {
  const trimmed = pwd.trim();
  if (trimmed.length < MIN_PASSWORD_LENGTH) return true;
  if (WEAK_PASSWORDS.has(trimmed.toLowerCase())) return true;
  if (/^(.)\1+$/.test(trimmed)) return true;
  return false;
}

function assertStrongPassword(pwd: string, label = 'পাসওয়ার্ড'): string {
  const raw = String(pwd || '');
  if (raw.trim().length < MIN_PASSWORD_LENGTH || raw.length > 128) {
    throw new Error(`${label} কমপক্ষে ${toBnDigits(MIN_PASSWORD_LENGTH)} অক্ষরের হতে হবে।`);
  }
  if (isWeakPasswordValue(raw)) {
    throw new Error(`দয়া করে আরও শক্তিশালী ${label} ব্যবহার করুন (সহজ/সাধারণ পাসওয়ার্ড অনুমোদিত নয়)।`);
  }
  return raw;
}

function generateStrongPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

function generateWebhookSecret(): string {
  return `nb_whsec_${crypto.randomBytes(18).toString('hex')}`;
}

function maskMobile(mobile: string): string {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 3)}******${digits.slice(-2)}`;
}

function maskTrx(trx: string): string {
  const s = String(trx || '').trim();
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`;
}

function normalizeMobileDigits(mobile: string): string {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.startsWith('8801') && digits.length === 13) {
    return digits.slice(2);
  }
  return digits;
}

class DuplicateTrxError extends Error {
  public existingReceipt?: Collection;
  constructor(message: string, existingReceipt?: Collection) {
    super(message);
    this.name = 'DuplicateTrxError';
    this.existingReceipt = existingReceipt;
  }
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
      AdminPassword: '',
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
      PaymentGatewayWebhookSecret: '',
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
        Password: '',
        AssignedAreas: ['মিরপুর ১০ (সেক্টর এ)', 'কাজীপাড়া উত্তর'],
        Status: 'এক্টিভ',
        CreatedAt: '2026-01-15',
      },
      {
        CollectorID: 'CL-202',
        Name: 'সোহেল রানা',
        Mobile: '01819-876543',
        Username: 'sohel',
        Password: '',
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

function hardenCredentials(): void {
  const db = ensureDb();
  let changed = false;
  const notices: string[] = [];

  const envAdminPwd = (process.env.ADMIN_PASSWORD || '').trim();
  const forceReset = process.env.RESET_ADMIN_PASSWORD === '1';

  if (forceReset && envAdminPwd) {
    assertStrongPassword(envAdminPwd, 'ADMIN_PASSWORD');
    db.settings.AdminPassword = hashPassword(envAdminPwd);
    changed = true;
    notices.push(`[SECURITY] Admin password reset from ADMIN_PASSWORD for "${db.settings.AdminUsername}".`);
  } else if (!db.settings.AdminPassword || (!isHashedPassword(db.settings.AdminPassword) && isWeakPasswordValue(db.settings.AdminPassword))) {
    if (envAdminPwd && !isWeakPasswordValue(envAdminPwd)) {
      db.settings.AdminPassword = hashPassword(envAdminPwd);
      notices.push(`[SECURITY] Initialized Admin password from ADMIN_PASSWORD for "${db.settings.AdminUsername}".`);
    } else {
      const generated = generateStrongPassword();
      db.settings.AdminPassword = hashPassword(generated);
      notices.push(`[SECURITY] Generated Admin password for "${db.settings.AdminUsername}": ${generated}`);
    }
    changed = true;
  } else if (!isHashedPassword(db.settings.AdminPassword)) {
    db.settings.AdminPassword = hashPassword(db.settings.AdminPassword);
    changed = true;
  }

  for (const col of db.collectors) {
    if (!col.Password || (!isHashedPassword(col.Password) && isWeakPasswordValue(col.Password))) {
      const generated = generateStrongPassword();
      col.Password = hashPassword(generated);
      changed = true;
      notices.push(`[SECURITY] Generated password for collector "${col.Username}": ${generated}`);
    } else if (!isHashedPassword(col.Password)) {
      col.Password = hashPassword(col.Password);
      changed = true;
    }
  }

  if (
    !db.settings.PaymentGatewayWebhookSecret ||
    db.settings.PaymentGatewayWebhookSecret === DEMO_WEBHOOK_SECRET ||
    db.settings.PaymentGatewayWebhookSecret.length < 16
  ) {
    const newSecret = generateWebhookSecret();
    db.settings.PaymentGatewayWebhookSecret = newSecret;
    changed = true;
    notices.push(`[SECURITY] Generated PaymentGatewayWebhookSecret: ${newSecret}`);
  }

  if (changed) {
    writeDbAtomic(db);
  }
  for (const msg of notices) {
    console.log(msg);
  }
}

// Session store with idle & absolute timeout + revocation
interface SessionRecord {
  user: SessionUser;
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, SessionRecord>();
const IDLE_HOURS_RAW = Number(process.env.SESSION_IDLE_HOURS || 12);
const SESSION_IDLE_MS = (Number.isFinite(IDLE_HOURS_RAW) && IDLE_HOURS_RAW > 0 ? IDLE_HOURS_RAW : 12) * 3600 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 3600 * 1000;

function pruneExpiredSessions(now = Date.now()): void {
  for (const [token, rec] of sessions.entries()) {
    if (now - rec.lastActiveAt > SESSION_IDLE_MS || now - rec.createdAt > SESSION_ABSOLUTE_MS) {
      sessions.delete(token);
    }
  }
}

function createSession(user: SessionUser): SessionUser {
  const now = Date.now();
  pruneExpiredSessions(now);
  sessions.set(user.token, { user, createdAt: now, lastActiveAt: now });
  return user;
}

function destroySession(token: string): void {
  sessions.delete(token);
}

function revokeSessionsFor(role: 'Admin' | 'User', username?: string, exceptToken?: string): void {
  for (const [token, rec] of sessions.entries()) {
    if (exceptToken && token === exceptToken) continue;
    if (rec.user.role === role && (!username || rec.user.username === username)) {
      sessions.delete(token);
    }
  }
}

// In-memory Rate Limiter
interface RateBucket {
  count: number;
  resetAt: number;
}
const rateBuckets = new Map<string, RateBucket>();

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateCheck(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const existing = rateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    return { allowed: true, retryAfterSec: 0 };
  }
  if (existing.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function rateHit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets.entries()) {
      if (now >= b.resetAt) rateBuckets.delete(k);
    }
  }
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function rateReset(key: string): void {
  rateBuckets.delete(key);
}

function rateLimit(prefix: string, limit: number, windowMs: number, keyFn?: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = keyFn ? keyFn(req) : getClientIp(req);
    const result = rateHit(`${prefix}:${id}`, limit, windowMs);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      res.status(429).json({
        error: `অতিরিক্ত অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${toBnDigits(result.retryAfterSec)} সেকেন্ড পর আবার চেষ্টা করুন।`,
      });
      return;
    }
    next();
  };
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
      if (col.CollectorRole === 'Admin') {
        accounts.Cash += col.Amount;
        totalIncome += col.Amount;
      }
    } else {
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

function collectBillInternal(db: DatabaseSchema, params: CollectBillParams): Collection {
  const customer = db.customers.find((c) => c.CustomerID === params.customerId);
  if (!customer) {
    throw new Error('গ্রাহক পাওয়া যায়নি।');
  }
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('টাকার পরিমাণ অবশ্যই ০ এর বেশি হতে হবে।');
  }

  const trimmedTrx = (params.trxId || '').trim();
  if (params.paymentMethod !== 'Cash' && !trimmedTrx) {
    throw new Error('ডিজিটাল পেমেন্টের জন্য TrxID / রেফারেন্স নম্বর আবশ্যক।');
  }

  if (params.paymentMethod !== 'Cash' && trimmedTrx) {
    const existingReceipt = db.collections.find(
      (c) =>
        c.PaymentMethod === params.paymentMethod &&
        c.TrxID.trim().toLowerCase() === trimmedTrx.toLowerCase()
    );
    if (existingReceipt) {
      throw new DuplicateTrxError(
        `এই TrxID (${trimmedTrx}) দিয়ে ইতিমধ্যেই রিসিট ${existingReceipt.ReceiptID} সংরক্ষিত হয়েছে।`,
        existingReceipt
      );
    }
  }

  const targetMonth = params.billingMonth || todayStr().slice(0, 7);

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
    TrxID: trimmedTrx,
    SenderAccount: (params.senderAccount || '').trim(),
    CollectedBy: params.collectedBy,
    CollectorRole: params.collectorRole,
    Note: (params.note || '').trim(),
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
  const now = Date.now();
  const record = token ? sessions.get(token) : undefined;

  if (!token || !record) {
    res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ হয়েছে, অনুগ্রহ করে পুনরায় লগইন করুন।' });
    return;
  }

  if (now - record.lastActiveAt > SESSION_IDLE_MS || now - record.createdAt > SESSION_ABSOLUTE_MS) {
    destroySession(token);
    res.status(401).json({ error: 'সেশনের সময়সীমা শেষ হয়েছে, অনুগ্রহ করে পুনরায় লগইন করুন।' });
    return;
  }

  const db = ensureDb();
  if (record.user.role === 'User') {
    const col = db.collectors.find((c) => c.Username === record.user.username);
    if (!col || col.Status !== 'এক্টিভ') {
      destroySession(token);
      res.status(401).json({ error: 'আপনার অ্যাকাউন্ট নিষ্ক্রিয় করা হয়েছে।' });
      return;
    }
    record.user = {
      ...record.user,
      name: col.Name,
      assignedAreas: col.AssignedAreas,
    };
  } else if (record.user.username !== db.settings.AdminUsername) {
    destroySession(token);
    res.status(401).json({ error: 'সেশন বৈধ নয়, অনুগ্রহ করে পুনরায় লগইন করুন।' });
    return;
  }

  record.lastActiveAt = now;
  req.user = record.user;
  next();
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

function daysBetweenDates(dateA: string, dateB: string): number {
  const a = Date.parse(`${dateA}T00:00:00Z`);
  const b = Date.parse(`${dateB}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((a - b) / (24 * 3600 * 1000));
}

const BLOCKED_PATH_PATTERNS = [
  /^\/data(?:\/|$)/i,
  /^\/server(?:\/|$)/i,
  /^\/@fs(?:\/|$)/i,
  /^\/\.env/i,
  /^\/\.git/i,
  /^\/server\.ts$/i,
  /^\/package(?:-lock)?\.json$/i,
  /^\/bun\.lock$/i,
  /^\/tsconfig\.json$/i,
  /^\/vite\.config\.ts$/i,
  /^\/metadata\.json$/i,
];

async function startServer() {
  ensureDb();
  hardenCredentials();

  const app = express();
  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

  if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
  }

  // Optional HTTPS Enforcement
  if (process.env.FORCE_HTTPS === '1') {
    app.use((req, res, next) => {
      const proto = req.headers['x-forwarded-proto'];
      if (!req.secure && proto !== 'https') {
        res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
        return;
      }
      next();
    });
  }

  // Security Headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.BLOCK_FRAMING === '1') {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    }
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  // Block direct access to internal files, database directory, and source configs
  app.use((req, res, next) => {
    const cleanPath = req.path || '/';
    if (BLOCKED_PATH_PATTERNS.some((re) => re.test(cleanPath))) {
      res.status(404).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '512kb' }));

  // Public Auth with Rate Limiting
  app.post('/api/auth/login', async (req, res) => {
    const ip = getClientIp(req);
    const ipCheck = rateCheck(`login-ip:${ip}`, 20, 15 * 60 * 1000);
    if (!ipCheck.allowed) {
      res.setHeader('Retry-After', String(ipCheck.retryAfterSec));
      res.status(429).json({
        error: `অতিরিক্ত লগইন প্রচেষ্টা করা হয়েছে। ${toBnDigits(ipCheck.retryAfterSec)} সেকেন্ড পর চেষ্টা করুন।`,
      });
      return;
    }

    const { username, password } = req.body as { username?: string; password?: string };
    const u = (username || '').trim();
    const p = password || '';
    const userIpKey = `login-user-ip:${u.toLowerCase()}:${ip}`;

    const userIpCheck = rateCheck(userIpKey, 5, 15 * 60 * 1000);
    if (!userIpCheck.allowed) {
      res.setHeader('Retry-After', String(userIpCheck.retryAfterSec));
      res.status(429).json({
        error: `ভুল পাসওয়ার্ডের কারণে সাময়িকভাবে ব্লক করা হয়েছে। ${toBnDigits(userIpCheck.retryAfterSec)} সেকেন্ড পর চেষ্টা করুন।`,
      });
      return;
    }

    const db = ensureDb();
    let sessionUser: SessionUser | null = null;

    if (u === db.settings.AdminUsername && verifyPassword(p, db.settings.AdminPassword)) {
      sessionUser = {
        token: crypto.randomUUID(),
        role: 'Admin',
        username: u,
        name: 'অ্যাডমিনিস্ট্রেটর',
        assignedAreas: [],
      };
    } else {
      const col = db.collectors.find(
        (c) => c.Username === u && c.Status === 'এক্টিভ' && verifyPassword(p, c.Password)
      );
      if (col) {
        sessionUser = {
          token: crypto.randomUUID(),
          role: 'User',
          username: col.Username,
          name: col.Name,
          assignedAreas: col.AssignedAreas,
        };
      }
    }

    rateHit(`login-ip:${ip}`, 20, 15 * 60 * 1000);

    if (!sessionUser) {
      rateHit(userIpKey, 5, 15 * 60 * 1000);
      res.status(401).json({ error: 'ভুল ইউজারনেম অথবা পাসওয়ার্ড। অনুগ্রহ করে আবার চেষ্টা করুন।' });
      return;
    }

    rateReset(userIpKey);
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

  // Public E-Billing Portal Endpoints (Exact lookup + Data masking + Rate limited)
  app.get('/api/public/lookup', rateLimit('public-lookup', 40, 60 * 1000), (req, res) => {
    const ip = getClientIp(req);
    const missCheck = rateCheck(`lookup-miss:${ip}`, 10, 10 * 60 * 1000);
    if (!missCheck.allowed) {
      res.setHeader('Retry-After', String(missCheck.retryAfterSec));
      res.status(429).json({
        error: `অনেকবার ভুল তথ্য দিয়ে খোঁজা হয়েছে। ${toBnDigits(missCheck.retryAfterSec)} সেকেন্ড পর আবার চেষ্টা করুন।`,
      });
      return;
    }

    const q = String(req.query.q || '').trim();
    const qLower = q.toLowerCase();
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

    if (!q) {
      res.json({
        company,
        customer: null,
        dueBills: [],
        totalDue: 0,
        lastPayment: null,
        recentRequests: [],
      });
      return;
    }

    const qDigits = normalizeMobileDigits(q);
    const customer =
      db.customers.find(
        (c) =>
          c.CustomerID.toLowerCase() === qLower ||
          (qDigits.length >= 10 && normalizeMobileDigits(c.Mobile) === qDigits)
      ) || null;

    if (!customer) {
      rateHit(`lookup-miss:${ip}`, 10, 10 * 60 * 1000);
      res.json({
        company,
        customer: null,
        dueBills: [],
        totalDue: 0,
        lastPayment: null,
        recentRequests: [],
      });
      return;
    }

    rateReset(`lookup-miss:${ip}`);

    const maskedCustomer: Customer = {
      ...customer,
      Mobile: maskMobile(customer.Mobile),
      Address: '',
      Note: '',
      OpeningBalance: 0,
    };

    const dueBills = db.bills.filter(
      (b) => b.CustomerID === customer.CustomerID && b.DueAmount > 0
    );
    const totalDue = dueBills.reduce((s, b) => s + b.DueAmount, 0);

    const rawLastPayment =
      db.collections.find((c) => c.CustomerID === customer.CustomerID) || null;
    const lastPayment = rawLastPayment
      ? {
          ...rawLastPayment,
          TrxID: maskTrx(rawLastPayment.TrxID),
          SenderAccount: '',
          CollectedBy: '',
          Note: '',
        }
      : null;

    const recentRequests = db.ePayments
      .filter((e) => e.CustomerID === customer.CustomerID)
      .slice(0, 5)
      .map((r) => ({
        ...r,
        Mobile: maskMobile(r.Mobile),
        SenderNumberOrAccount: maskMobile(r.SenderNumberOrAccount),
        TrxID: maskTrx(r.TrxID),
      }));

    res.json({
      company,
      customer: maskedCustomer,
      dueBills,
      totalDue,
      lastPayment,
      recentRequests,
    });
  });

  app.post('/api/public/epayment', rateLimit('public-epay', 8, 10 * 60 * 1000), async (req, res) => {
    try {
      const result = await withLock(() => {
        const db = ensureDb();
        const {
          customerId,
          billingMonth,
          amount,
          paymentMethod,
          senderNumberOrAccount,
          trxId,
          note,
        } = req.body as {
          customerId: string;
          billingMonth: string;
          amount: number;
          paymentMethod: Exclude<PaymentMethod, 'Cash'>;
          senderNumberOrAccount: string;
          trxId: string;
          note?: string;
        };

        const customer = db.customers.find((c) => c.CustomerID === customerId);
        if (!customer) throw new Error('সঠিক গ্রাহক আইডি পাওয়া যায়নি।');

        const pendingForCust = db.ePayments.filter(
          (e) => e.CustomerID === customer.CustomerID && e.Status === 'Pending'
        ).length;
        if (pendingForCust >= 5) {
          throw new Error(
            'এই গ্রাহকের ইতিমধ্যেই ৫টি অপেক্ষমাণ ই-পেমেন্ট অনুরোধ রয়েছে। অনুগ্রহ করে অফিস যাচাইয়ের জন্য অপেক্ষা করুন।'
          );
        }

        const allowedDigital: Exclude<PaymentMethod, 'Cash'>[] = ['bKash', 'Nagad', 'Rocket', 'Bank'];
        if (!allowedDigital.includes(paymentMethod)) {
          throw new Error('সঠিক ডিজিটাল পেমেন্ট মাধ্যম নির্বাচন করুন।');
        }

        const numAmt = Number(amount);
        if (!Number.isFinite(numAmt) || numAmt <= 0 || numAmt > 500000) {
          throw new Error('সঠিক টাকার পরিমাণ লিখুন।');
        }
        if (!senderNumberOrAccount?.trim() || senderNumberOrAccount.includes('*')) {
          throw new Error('প্রেরকের সঠিক মোবাইল বা ব্যাংক অ্যাকাউন্ট নম্বর লিখুন।');
        }
        if (!trxId?.trim()) throw new Error('TrxID বা রেফারেন্স নম্বর আবশ্যক।');

        const dupTrx = db.ePayments.find(
          (e) => e.TrxID.toLowerCase() === trxId.trim().toLowerCase() && e.Status !== 'Rejected'
        );
        if (dupTrx) {
          throw new Error('এই TrxID দিয়ে ইতিমধ্যেই একটি অনুরোধ জমা দেওয়া হয়েছে।');
        }

        const reqRow: EPaymentRequest = {
          RequestID: randomId('EP'),
          SubmittedAt: new Date().toISOString(),
          CustomerID: customer.CustomerID,
          CustomerName: customer.Name,
          Mobile: customer.Mobile,
          BillingMonth: billingMonth || todayStr().slice(0, 7),
          Amount: numAmt,
          PaymentMethod: paymentMethod,
          SenderNumberOrAccount: senderNumberOrAccount.trim(),
          TrxID: trxId.trim(),
          Status: 'Pending',
          ReviewedBy: '',
          ReviewedAt: '',
          Note: (note || '').trim().slice(0, 200),
        };

        db.ePayments.unshift(reqRow);
        writeDbAtomic(db);

        return {
          ...reqRow,
          Mobile: maskMobile(reqRow.Mobile),
        };
      });
      res.json({ request: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Automated Payment Gateway IPN / Webhook Hook (Timing-safe + Rate-limited + Idempotent)
  app.post('/api/webhook/epayment', async (req, res) => {
    const ip = getClientIp(req);
    const failCheck = rateCheck(`webhook-fail:${ip}`, 10, 15 * 60 * 1000);
    if (!failCheck.allowed) {
      res.setHeader('Retry-After', String(failCheck.retryAfterSec));
      res.status(429).json({ error: 'Too many failed webhook attempts' });
      return;
    }

    const secret = String(req.headers['x-webhook-secret'] || req.body?.secret || '');
    const dbSnap = ensureDb();
    const storedSecret = dbSnap.settings.PaymentGatewayWebhookSecret || '';

    if (
      !storedSecret ||
      storedSecret.length < 16 ||
      storedSecret === DEMO_WEBHOOK_SECRET ||
      !secret ||
      !safeEqual(secret, storedSecret)
    ) {
      rateHit(`webhook-fail:${ip}`, 10, 15 * 60 * 1000);
      res.status(401).json({ error: 'Invalid webhook secret' });
      return;
    }

    rateReset(`webhook-fail:${ip}`);

    try {
      const { receipt, smsLog } = await processCollectionPayment({
        prepareAndValidate: (db) => {
          const { customerId, trxId, amount, paymentMethod, senderAccount, billingMonth } = req.body;
          const pending = db.ePayments.find(
            (e) =>
              e.CustomerID === customerId &&
              e.TrxID.toLowerCase() === String(trxId || '').toLowerCase() &&
              e.Status === 'Pending'
          );
          return {
            params: {
              customerId,
              billingMonth: billingMonth || pending?.BillingMonth || todayStr().slice(0, 7),
              amount: Number(amount || pending?.Amount || 0),
              paymentMethod: paymentMethod || pending?.PaymentMethod || 'bKash',
              trxId: String(trxId || ''),
              senderAccount: String(senderAccount || pending?.SenderNumberOrAccount || ''),
              collectedBy: 'AutoWebhook',
              collectorRole: 'Self-EBill',
              note: 'স্বয়ংক্রিয় গেটওয়ে ভেরিফিকেশন',
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
      if (err instanceof DuplicateTrxError) {
        res.json({ ok: true, duplicate: true, receipt: err.existingReceipt });
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

    // Collector (User): omit AdminUsername & PaymentGatewayWebhookSecret
    const collectorSafeSettings = {
      ...safeSettings,
      AdminUsername: '',
      PaymentGatewayWebhookSecret: '',
    };

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
      settings: collectorSafeSettings,
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
        const { Name, Mobile, Username, Password, AssignedAreas, Status } = req.body;
        const uname = String(Username || '').trim();
        if (!Name?.trim() || !uname || !Password) {
          throw new Error('নাম, ইউজারনেম এবং পাসওয়ার্ড আবশ্যক।');
        }
        if (!USERNAME_RE.test(uname)) {
          throw new Error('ইউজারনেম ৩ থেকে ৩২ অক্ষরের ইংরেজি অক্ষর, সংখ্যা বা . _ - হতে হবে।');
        }
        const strongPwd = assertStrongPassword(String(Password), 'কালেক্টর পাসওয়ার্ড');
        if (
          uname === db.settings.AdminUsername ||
          db.collectors.some((c) => c.Username.toLowerCase() === uname.toLowerCase())
        ) {
          throw new Error('এই ইউজারনেমটি ইতিমধ্যেই ব্যবহৃত হয়েছে।');
        }
        const row: Collector = {
          CollectorID: randomId('CL'),
          Name: Name.trim(),
          Mobile: (Mobile || '').trim(),
          Username: uname,
          Password: hashPassword(strongPwd),
          AssignedAreas: Array.isArray(AssignedAreas) ? AssignedAreas : [],
          Status: Status || 'এক্টিভ',
          CreatedAt: todayStr(),
        };
        db.collectors.push(row);
        writeDbAtomic(db);
        return { ...row, Password: '••••••' };
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
        const col = db.collectors.find((c) => c.CollectorID === req.params.id);
        if (!col) throw new Error('কালেক্টর পাওয়া যায়নি।');
        col.Name = String(req.body.Name || col.Name).trim();
        col.Mobile = String(req.body.Mobile ?? col.Mobile).trim();

        let shouldRevoke = false;
        if (req.body.Password && req.body.Password !== '••••••') {
          const strongPwd = assertStrongPassword(String(req.body.Password), 'কালেক্টর পাসওয়ার্ড');
          col.Password = hashPassword(strongPwd);
          shouldRevoke = true;
        }
        if (Array.isArray(req.body.AssignedAreas)) {
          col.AssignedAreas = req.body.AssignedAreas;
        }
        if (req.body.Status) {
          col.Status = req.body.Status;
          if (col.Status !== 'এক্টিভ') {
            shouldRevoke = true;
          }
        }
        writeDbAtomic(db);
        if (shouldRevoke) {
          revokeSessionsFor('User', col.Username);
        }
        return { ...col, Password: '••••••' };
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
        const removed = db.collectors[idx];
        db.collectors.splice(idx, 1);
        writeDbAtomic(db);
        revokeSessionsFor('User', removed.Username);
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
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('সঠিক জমার পরিমাণ লিখুন।');
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

  // Customers CRUD (RBAC Hardened)
  app.post('/api/customers', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const customer = await withLock(() => {
        const db = ensureDb();
        const user = req.user!;
        const data = req.body;
        const custId = String(data.CustomerID || '').trim();
        if (!custId) throw new Error('গ্রাহক আইডি আবশ্যক।');
        if (db.customers.some((c) => c.CustomerID.toLowerCase() === custId.toLowerCase())) {
          throw new Error('এই গ্রাহক আইডি ইতিমধ্যেই বিদ্যমান। অনুগ্রহ করে ভিন্ন আইডি দিন।');
        }
        if (user.role === 'User' && !user.assignedAreas.includes(data.Area)) {
          throw new Error('আপনার নির্ধারিত এরিয়ার বাইরে গ্রাহক যোগ করার অনুমতি নেই।');
        }
        const connDate = data.ConnectionDate || todayStr();
        // Only Admin may set an OpeningBalance on customer creation
        const opening = user.role === 'Admin' ? Math.max(0, Number(data.OpeningBalance || 0)) : 0;
        const monthlyBill = Math.max(0, Number(data.MonthlyBill || 0));
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

        const d = req.body;
        if (user.role === 'User') {
          if (!user.assignedAreas.includes(cust.Area)) {
            throw new Error('অন্য এরিয়ার গ্রাহক এডিট করার অনুমতি নেই।');
          }
          if (d.Area !== undefined && !user.assignedAreas.includes(String(d.Area).trim())) {
            throw new Error('আপনার নির্ধারিত এরিয়ার বাইরে গ্রাহক স্থানান্তরের অনুমতি নেই।');
          }
          if (
            (d.MonthlyBill !== undefined && Number(d.MonthlyBill) !== cust.MonthlyBill) ||
            (d.Package !== undefined && String(d.Package).trim() !== cust.Package) ||
            (d.ServiceType !== undefined && d.ServiceType !== cust.ServiceType)
          ) {
            throw new Error('প্যাকেজ, সার্ভিসের ধরন বা মাসিক বিল শুধুমাত্র অ্যাডমিন পরিবর্তন করতে পারবেন।');
          }
        }

        cust.Name = String(d.Name ?? cust.Name).trim();
        cust.Mobile = String(d.Mobile ?? cust.Mobile).trim();
        cust.Area = String(d.Area ?? cust.Area).trim();
        cust.Address = String(d.Address ?? cust.Address).trim();
        if (user.role === 'Admin') {
          cust.ServiceType = d.ServiceType ?? cust.ServiceType;
          cust.Package = String(d.Package ?? cust.Package).trim();
          cust.MonthlyBill = Number(d.MonthlyBill ?? cust.MonthlyBill);
        }
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

  // Automatic Monthly Billing Generator (Admin only or scoped)
  app.post('/api/bills/generate', authMiddleware, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const summary = await withLock(() => {
        const db = ensureDb();
        const targetMonth: string = String(req.body?.billingMonth || todayStr().slice(0, 7));
        const mode: 'dueOnly' | 'allActive' = req.body?.mode || 'allActive';
        const refToday = todayStr();

        let createdCount = 0;
        let skippedCount = 0;

        for (const cust of db.customers) {
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

          if (user.role === 'User' && date) {
            const diff = daysBetweenDates(String(date).trim(), todayStr());
            if (Number.isNaN(diff) || Math.abs(diff) > 1) {
              throw new Error('কালেক্টর শুধুমাত্র আজ বা ±১ দিনের তারিখে বিল আদায় এন্ট্রি করতে পারবেন।');
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
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('সঠিক খরচের পরিমাণ লিখুন।');
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

  // Manual / Resend Receipt SMS (Rate limited)
  app.post(
    '/api/sms/send',
    authMiddleware,
    rateLimit('sms-send', 30, 60 * 1000, (req) => (req as AuthedRequest).user?.username || getClientIp(req)),
    async (req: AuthedRequest, res) => {
      try {
        const { receiptId, customerId, message } = req.body as {
          receiptId?: string;
          customerId?: string;
          message?: string;
        };
        const db = ensureDb();
        const user = req.user!;

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
    }
  );

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
      for (const item of items.slice(0, 100)) {
        const cust = db.customers.find((c) => c.CustomerID === item.customerId);
        if (!cust || !cust.Mobile) continue;
        const log = await dispatchSmsAndLog({
          customerId: cust.CustomerID,
          customerName: cust.Name,
          mobile: cust.Mobile,
          receiptId: 'BROADCAST',
          message: item.message,
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

  // Settings (Admin only, whitelisted fields, CurrentAdminPassword required on password change)
  app.put('/api/settings', authMiddleware, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const updated = await withLock(() => {
        const db = ensureDb();
        const body = req.body as Partial<SettingsData> & { CurrentAdminPassword?: string };

        const nextSettings: SettingsData = {
          ...db.settings,
          CompanyName: body.CompanyName !== undefined ? String(body.CompanyName).trim() : db.settings.CompanyName,
          BusinessType: body.BusinessType !== undefined ? String(body.BusinessType).trim() : db.settings.BusinessType,
          Address: body.Address !== undefined ? String(body.Address).trim() : db.settings.Address,
          Phone: body.Phone !== undefined ? String(body.Phone).trim() : db.settings.Phone,
          ScrollingNotice:
            body.ScrollingNotice !== undefined ? String(body.ScrollingNotice).trim() : db.settings.ScrollingNotice,
          BkashNumber: body.BkashNumber !== undefined ? String(body.BkashNumber).trim() : db.settings.BkashNumber,
          BkashType: body.BkashType ?? db.settings.BkashType,
          NagadNumber: body.NagadNumber !== undefined ? String(body.NagadNumber).trim() : db.settings.NagadNumber,
          NagadType: body.NagadType ?? db.settings.NagadType,
          RocketNumber: body.RocketNumber !== undefined ? String(body.RocketNumber).trim() : db.settings.RocketNumber,
          BankDetails: {
            ...db.settings.BankDetails,
            ...(body.BankDetails || {}),
          },
          SmsConfig: {
            ...(db.settings.SmsConfig || DEFAULT_SMS_CONFIG),
            ...(body.SmsConfig || {}),
          },
        };

        if (body.AdminUsername !== undefined) {
          const nextUname = String(body.AdminUsername).trim();
          if (!USERNAME_RE.test(nextUname)) {
            throw new Error('অ্যাডমিন ইউজারনেম ৩ থেকে ৩২ অক্ষরের ইংরেজি অক্ষর, সংখ্যা বা . _ - হতে হবে।');
          }
          if (db.collectors.some((c) => c.Username.toLowerCase() === nextUname.toLowerCase())) {
            throw new Error('এই ইউজারনেমটি একজন কালেক্টরের জন্য ব্যবহৃত হচ্ছে।');
          }
          nextSettings.AdminUsername = nextUname;
        }

        if (body.PaymentGatewayWebhookSecret !== undefined) {
          const sec = String(body.PaymentGatewayWebhookSecret).trim();
          if (sec.length < 16 || sec.length > 128 || sec === DEMO_WEBHOOK_SECRET) {
            throw new Error('ওয়েবহুক সিক্রেট ১৬ থেকে ১২৮ অক্ষরের মধ্যে হতে হবে (ডেমো সিক্রেট অনুমোদিত নয়)।');
          }
          nextSettings.PaymentGatewayWebhookSecret = sec;
        }

        let passwordChanged = false;
        if (body.AdminPassword && String(body.AdminPassword).trim()) {
          if (!verifyPassword(body.CurrentAdminPassword, db.settings.AdminPassword)) {
            throw new Error('নতুন পাসওয়ার্ড সেট করতে বর্তমান অ্যাডমিন পাসওয়ার্ড সঠিকভাবে দিন।');
          }
          const strongPwd = assertStrongPassword(String(body.AdminPassword), 'অ্যাডমিন পাসওয়ার্ড');
          nextSettings.AdminPassword = hashPassword(strongPwd);
          passwordChanged = true;
        }

        const usernameChanged = nextSettings.AdminUsername !== db.settings.AdminUsername;
        db.settings = nextSettings;
        writeDbAtomic(db);

        if (passwordChanged || usernameChanged) {
          revokeSessionsFor('Admin', undefined, req.user?.token);
          if (req.user) {
            req.user.username = nextSettings.AdminUsername;
          }
        }

        const { AdminPassword: _hidden, ...safe } = db.settings;
        return safe;
      });
      res.json({ settings: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Vite Dev Middleware or Static Production Build
  if (!isProd) {
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

  // Generic Error Handler (no stack traces leaked to client)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled server error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'সার্ভারে অপ্রত্যাশিত ত্রুটি হয়েছে।' });
    }
  });

  app.listen(3000, '0.0.0.0', () => {
    console.log('NetBill ISP server listening on http://0.0.0.0:3000');
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

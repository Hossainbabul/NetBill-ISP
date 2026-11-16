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
      AdminPassword: 'admin123',
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
      PaymentGatewayWebhookSecret: 'nb_whsec_demo_2026',
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
        Password: '1234',
        AssignedAreas: ['মিরপুর ১০ (সেক্টর এ)', 'কাজীপাড়া উত্তর'],
        Status: 'এক্টিভ',
        CreatedAt: '2026-01-15',
      },
      {
        CollectorID: 'CL-202',
        Name: 'সোহেল রানা',
        Mobile: '01819-876543',
        Username: 'sohel',
        Password: '1234',
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

const sessions = new Map<string, SessionUser>();

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

function collectBillInternal(db: DatabaseSchema, params: CollectBillParams): Collection {
  const customer = db.customers.find((c) => c.CustomerID === params.customerId);
  if (!customer) {
    throw new Error('গ্রাহক পাওয়া যায়নি।');
  }
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('টাকার পরিমাণ অবশ্যই ০ এর বেশি হতে হবে।');
  }

  if (params.paymentMethod !== 'Cash' && !params.trxId.trim()) {
    throw new Error('ডিজিটাল পেমেন্টের জন্য TrxID / রেফারেন্স নম্বর আবশ্যক।');
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
  if (!token || !sessions.has(token)) {
    res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ হয়েছে, অনুগ্রহ করে পুনরায় লগইন করুন।' });
    return;
  }
  req.user = sessions.get(token);
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
  return Boolean(password && password === db.settings.AdminPassword);
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

async function startServer() {
  ensureDb();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Public Auth
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    const u = (username || '').trim();
    const p = password || '';
    const db = ensureDb();

    let sessionUser: SessionUser | null = null;
    if (u === db.settings.AdminUsername && p === db.settings.AdminPassword) {
      sessionUser = {
        token: crypto.randomUUID(),
        role: 'Admin',
        username: u,
        name: 'অ্যাডমিনিস্ট্রেটর',
        assignedAreas: [],
      };
    } else {
      const col = db.collectors.find(
        (c) => c.Username === u && c.Password === p && c.Status === 'এক্টিভ'
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

    if (!sessionUser) {
      res.status(401).json({ error: 'ভুল ইউজারনেম অথবা পাসওয়ার্ড। অনুগ্রহ করে আবার চেষ্টা করুন।' });
      return;
    }

    sessions.set(sessionUser.token, sessionUser);
    res.json({ user: sessionUser });
  });

  app.get('/api/auth/session', authMiddleware, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  app.post('/api/auth/logout', authMiddleware, (req: AuthedRequest, res) => {
    if (req.user?.token) {
      sessions.delete(req.user.token);
    }
    res.json({ ok: true });
  });

  // Public E-Billing Portal Endpoints (No Login Required)
  app.get('/api/public/lookup', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
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

    const normalizedDigits = q.replace(/\D/g, '');
    const customer =
      db.customers.find(
        (c) =>
          c.CustomerID.toLowerCase() === q ||
          c.Mobile.toLowerCase() === q ||
          (normalizedDigits.length >= 6 && c.Mobile.replace(/\D/g, '').endsWith(normalizedDigits))
      ) || null;

    if (!customer) {
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

    const dueBills = db.bills.filter(
      (b) => b.CustomerID === customer.CustomerID && b.DueAmount > 0
    );
    const totalDue = dueBills.reduce((s, b) => s + b.DueAmount, 0);
    const lastPayment =
      db.collections.find((c) => c.CustomerID === customer.CustomerID) || null;
    const recentRequests = db.ePayments
      .filter((e) => e.CustomerID === customer.CustomerID)
      .slice(0, 5);

    res.json({
      company,
      customer,
      dueBills,
      totalDue,
      lastPayment,
      recentRequests,
    });
  });

  app.post('/api/public/epayment', async (req, res) => {
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
        if (!amount || Number(amount) <= 0) throw new Error('সঠিক টাকার পরিমাণ লিখুন।');
        if (!senderNumberOrAccount?.trim()) throw new Error('প্রেরকের নম্বর বা অ্যাকাউন্ট নম্বর লিখুন।');
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
          Amount: Number(amount),
          PaymentMethod: paymentMethod,
          SenderNumberOrAccount: senderNumberOrAccount.trim(),
          TrxID: trxId.trim(),
          Status: 'Pending',
          ReviewedBy: '',
          ReviewedAt: '',
          Note: (note || '').trim(),
        };

        db.ePayments.unshift(reqRow);
        writeDbAtomic(db);
        return reqRow;
      });
      res.json({ request: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Automated Payment Gateway IPN / Webhook Hook
  app.post('/api/webhook/epayment', async (req, res) => {
    try {
      const secret = String(req.headers['x-webhook-secret'] || req.body?.secret || '');
      const { receipt, smsLog } = await processCollectionPayment({
        prepareAndValidate: (db) => {
          if (secret !== db.settings.PaymentGatewayWebhookSecret) {
            throw new Error('Invalid webhook secret');
          }
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
      settings: safeSettings,
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
        if (!Name?.trim() || !Username?.trim() || !Password?.trim()) {
          throw new Error('নাম, ইউজারনেম এবং পাসওয়ার্ড আবশ্যক।');
        }
        if (
          Username.trim() === db.settings.AdminUsername ||
          db.collectors.some((c) => c.Username === Username.trim())
        ) {
          throw new Error('এই ইউজারনেমটি ইতিমধ্যেই ব্যবহৃত হয়েছে।');
        }
        const row: Collector = {
          CollectorID: randomId('CL'),
          Name: Name.trim(),
          Mobile: (Mobile || '').trim(),
          Username: Username.trim(),
          Password: Password.trim(),
          AssignedAreas: Array.isArray(AssignedAreas) ? AssignedAreas : [],
          Status: Status || 'এক্টিভ',
          CreatedAt: todayStr(),
        };
        db.collectors.push(row);
        writeDbAtomic(db);
        return row;
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
        if (req.body.Password && req.body.Password !== '••••••') {
          col.Password = String(req.body.Password).trim();
        }
        if (Array.isArray(req.body.AssignedAreas)) {
          col.AssignedAreas = req.body.AssignedAreas;
        }
        if (req.body.Status) {
          col.Status = req.body.Status;
        }
        writeDbAtomic(db);
        return col;
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
        if (db.customers.some((c) => c.CustomerID.toLowerCase() === custId.toLowerCase())) {
          throw new Error('এই গ্রাহক আইডি ইতিমধ্যেই বিদ্যমান। অনুগ্রহ করে ভিন্ন আইডি দিন।');
        }
        if (user.role === 'User' && !user.assignedAreas.includes(data.Area)) {
          throw new Error('আপনার নির্ধারিত এরিয়ার বাইরে গ্রাহক যোগ করার অনুমতি নেই।');
        }
        const connDate = data.ConnectionDate || todayStr();
        const opening = Number(data.OpeningBalance || 0);
        const monthlyBill = Number(data.MonthlyBill || 0);
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
        const d = req.body;
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
  app.post('/api/sms/send', authMiddleware, async (req: AuthedRequest, res) => {
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

  // Settings (Admin only)
  app.put('/api/settings', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const updated = await withLock(() => {
        const db = ensureDb();
        const body = req.body as Partial<SettingsData>;
        db.settings = {
          ...db.settings,
          ...body,
          BankDetails: {
            ...db.settings.BankDetails,
            ...(body.BankDetails || {}),
          },
          SmsConfig: {
            ...(db.settings.SmsConfig || DEFAULT_SMS_CONFIG),
            ...(body.SmsConfig || {}),
          },
          AdminPassword:
            body.AdminPassword && body.AdminPassword.trim()
              ? body.AdminPassword.trim()
              : db.settings.AdminPassword,
        };
        writeDbAtomic(db);
        const { AdminPassword: _hidden, ...safe } = db.settings;
        return safe;
      });
      res.json({ settings: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Vite Dev Middleware or Static Production Build
  const isProd = process.env.NODE_ENV === 'production';
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

  app.listen(3000, '0.0.0.0', () => {
    console.log('NetBill ISP server listening on http://0.0.0.0:3000');
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

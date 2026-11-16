export type ServiceType = 'Internet' | 'Cable TV';
export type AreaServiceType = 'Internet' | 'Cable TV' | 'Both';
export type PaymentMethod = 'Cash' | 'bKash' | 'Nagad' | 'Rocket' | 'Bank';
export type CustomerStatus = 'এক্টিভ' | 'ডি-এক্টিভ';
export type BillStatus = 'বকেয়া' | 'আংশিক' | 'পরিশোধিত';
export type UserRole = 'Admin' | 'User';
export type EPaymentStatus = 'Pending' | 'Approved' | 'Rejected';

export interface BankDetails {
  BankName: string;
  AccountName: string;
  AccountNo: string;
  Branch: string;
  Routing: string;
}

export type SmsProvider = 'twilio' | 'local_bd' | 'sandbox';

export interface SmsConfig {
  Enabled: boolean;
  Provider: SmsProvider;
  SenderId: string;
  PaymentSmsTemplate: string;
}

export interface SmsLog {
  SmsID: string;
  Timestamp: string;
  CustomerID: string;
  CustomerName: string;
  Mobile: string;
  ReceiptID: string;
  Provider: SmsProvider;
  Message: string;
  Status: 'Sent' | 'Simulated' | 'Failed';
  GatewayResponse: string;
}

export interface SettingsData {
  CompanyName: string;
  BusinessType: string;
  Address: string;
  Phone: string;
  ScrollingNotice: string;
  AdminUsername: string;
  AdminPassword: string;
  BkashNumber: string;
  BkashType: 'Merchant' | 'Personal' | 'Agent';
  NagadNumber: string;
  NagadType: 'Merchant' | 'Personal' | 'Agent';
  RocketNumber: string;
  BankDetails: BankDetails;
  PaymentGatewayWebhookSecret: string;
  SmsConfig: SmsConfig;
}

export interface Area {
  AreaID: string;
  AreaName: string;
  ServiceType: AreaServiceType;
  CreatedAt: string;
}

export interface Collector {
  CollectorID: string;
  Name: string;
  Mobile: string;
  Username: string;
  Password: string;
  AssignedAreas: string[];
  Status: CustomerStatus;
  CreatedAt: string;
}

export interface Customer {
  CustomerID: string;
  Name: string;
  Mobile: string;
  Area: string;
  Address: string;
  ServiceType: ServiceType;
  Package: string;
  MonthlyBill: number;
  ConnectionDate: string;
  NextBillDate: string;
  Status: CustomerStatus;
  OpeningBalance: number;
  Note: string;
  CreatedAt: string;
}

export interface Bill {
  BillID: string;
  CustomerID: string;
  BillingMonth: string; // YYYY-MM or 'Opening'
  MonthLabel: string;
  BillType: 'Opening' | 'Monthly';
  Amount: number;
  PaidAmount: number;
  DueAmount: number;
  Status: BillStatus;
  GeneratedDate: string;
}

export interface Collection {
  ReceiptID: string;
  Date: string;
  CustomerID: string;
  CustomerName: string;
  Area: string;
  BillingMonth: string;
  Amount: number;
  PaymentMethod: PaymentMethod;
  TrxID: string;
  SenderAccount: string;
  CollectedBy: string;
  CollectorRole: 'Admin' | 'User' | 'Self-EBill';
  Note: string;
  CreatedAt: string;
}

export interface EPaymentRequest {
  RequestID: string;
  SubmittedAt: string;
  CustomerID: string;
  CustomerName: string;
  Mobile: string;
  BillingMonth: string;
  Amount: number;
  PaymentMethod: Exclude<PaymentMethod, 'Cash'>;
  SenderNumberOrAccount: string;
  TrxID: string;
  Status: EPaymentStatus;
  ReviewedBy: string;
  ReviewedAt: string;
  Note: string;
}

export interface CollectorDeposit {
  DepositID: string;
  Date: string;
  CollectorUsername: string;
  CollectorName: string;
  Amount: number;
  DepositMethod: Exclude<PaymentMethod, 'Rocket'>;
  TrxID: string;
  Note: string;
  CreatedAt: string;
}

export type ExpenseCategory =
  | 'বেতন'
  | 'অফিস ভাড়া'
  | 'কেবল ও যন্ত্রপাতি'
  | 'ব্যান্ডউইথ বিল'
  | 'বিদ্যুৎ বিল'
  | 'আপ্যায়ন/অন্যান্য';

export interface Expense {
  ExpenseID: string;
  Date: string;
  Category: ExpenseCategory;
  PaymentAccount: PaymentMethod;
  Amount: number;
  Note: string;
  CreatedAt: string;
}

export interface SessionUser {
  token: string;
  role: UserRole;
  username: string;
  name: string;
  assignedAreas: string[];
}

export interface AccountBalances {
  Cash: number;
  bKash: number;
  Nagad: number;
  Rocket: number;
  Bank: number;
  totalIncome: number;
  totalExpense: number;
  netBalance: number;
}

export interface CollectorSummary {
  CollectorID: string;
  Name: string;
  Mobile: string;
  Username: string;
  AssignedAreas: string[];
  Status: CustomerStatus;
  cashCollected: number;
  digitalCollected: number;
  totalDeposited: number;
  handCash: number;
}

export interface SmsEnvStatus {
  twilioConfigured: boolean;
  localConfigured: boolean;
}

export interface DashboardPayload {
  settings: Omit<SettingsData, 'AdminPassword'>;
  areas: Area[];
  collectors: Collector[];
  customers: Customer[];
  bills: Bill[];
  collections: Collection[];
  ePayments: EPaymentRequest[];
  deposits: CollectorDeposit[];
  expenses: Expense[];
  smsLogs: SmsLog[];
  smsEnvStatus: SmsEnvStatus;
  accountBalances: AccountBalances;
  collectorSummaries: CollectorSummary[];
}

export interface PublicPayLookupResponse {
  company: {
    CompanyName: string;
    BusinessType: string;
    Address: string;
    Phone: string;
    BkashNumber: string;
    BkashType: string;
    NagadNumber: string;
    NagadType: string;
    RocketNumber: string;
    BankDetails: BankDetails;
  };
  customer: Customer | null;
  dueBills: Bill[];
  totalDue: number;
  lastPayment: Collection | null;
  recentRequests: EPaymentRequest[];
}

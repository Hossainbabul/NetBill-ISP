import {
  Area,
  Collection,
  Collector,
  CollectorDeposit,
  Customer,
  DashboardPayload,
  DueReminderResult,
  EPaymentRequest,
  Expense,
  PaymentMethod,
  PublicPayLookupResponse,
  SessionUser,
  SettingsData,
  SmsLog,
} from './types';

const TOKEN_KEY = 'netbill_session_token';

export function getSavedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveSessionToken(token: string, remember: boolean): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (token) {
      if (remember) {
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        sessionStorage.setItem(TOKEN_KEY, token);
      }
    }
  } catch {
    // ignore storage restriction
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getSavedToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/auth/login' && typeof window !== 'undefined') {
    saveSessionToken('', false);
    window.dispatchEvent(new CustomEvent('netbill:unauthorized'));
  }
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || 'সার্ভারে ত্রুটি হয়েছে।');
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getSession: () => request<{ user: SessionUser }>('/api/auth/session'),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  bootstrap: () => request<DashboardPayload>('/api/bootstrap'),

  // Public E-Pay Portal
  publicLookup: (query: string) =>
    request<PublicPayLookupResponse>(`/api/public/lookup?q=${encodeURIComponent(query)}`),

  publicSubmitEPayment: (payload: {
    customerId: string;
    billingMonth: string;
    amount: number;
    paymentMethod: Exclude<PaymentMethod, 'Cash'>;
    senderNumberOrAccount: string;
    trxId: string;
    note?: string;
  }) =>
    request<{ request: EPaymentRequest }>('/api/public/epayment', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Areas
  createArea: (payload: { AreaName: string; ServiceType: Area['ServiceType'] }) =>
    request<{ area: Area }>('/api/areas', { method: 'POST', body: JSON.stringify(payload) }),

  updateArea: (id: string, payload: { AreaName: string; ServiceType: Area['ServiceType'] }) =>
    request<{ area: Area }>(`/api/areas/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),

  deleteArea: (id: string, adminPassword: string) =>
    request<{ ok: boolean }>(`/api/areas/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ adminPassword }),
    }),

  // Collectors & Deposits
  createCollector: (payload: Partial<Collector>) =>
    request<{ collector: Collector }>('/api/collectors', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateCollector: (id: string, payload: Partial<Collector>) =>
    request<{ collector: Collector }>(`/api/collectors/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteCollector: (id: string, adminPassword: string) =>
    request<{ ok: boolean }>(`/api/collectors/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ adminPassword }),
    }),

  createDeposit: (payload: {
    collectorUsername: string;
    amount: number;
    depositMethod: Exclude<PaymentMethod, 'Rocket'>;
    trxId: string;
    note: string;
    date?: string;
  }) =>
    request<{ deposit: CollectorDeposit }>('/api/deposits', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Customers
  createCustomer: (payload: Partial<Customer>) =>
    request<{ customer: Customer }>('/api/customers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateCustomer: (id: string, payload: Partial<Customer>) =>
    request<{ customer: Customer }>(`/api/customers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  toggleCustomerStatus: (id: string) =>
    request<{ customer: Customer }>(`/api/customers/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
    }),

  deleteCustomer: (id: string, adminPassword: string) =>
    request<{ ok: boolean }>(`/api/customers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ adminPassword }),
    }),

  // Billing & Collections
  generateBills: (billingMonth: string, mode: 'dueOnly' | 'allActive') =>
    request<{ createdCount: number; skippedCount: number; billingMonth: string }>(
      '/api/bills/generate',
      {
        method: 'POST',
        body: JSON.stringify({ billingMonth, mode }),
      }
    ),

  collectBill: (payload: {
    customerId: string;
    billingMonth: string;
    amount: number;
    paymentMethod: PaymentMethod;
    trxId: string;
    senderAccount: string;
    note: string;
    date?: string;
  }) =>
    request<{ receipt: Collection; smsLog?: SmsLog | null }>('/api/collections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteCollection: (id: string, adminPassword: string) =>
    request<{ ok: boolean }>(`/api/collections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ adminPassword }),
    }),

  // E-Payments
  approveEPayment: (id: string) =>
    request<{ receipt: Collection; smsLog?: SmsLog | null }>(
      `/api/epayments/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
      }
    ),

  rejectEPayment: (id: string, note: string) =>
    request<{ ok: boolean }>(`/api/epayments/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  deleteEPayment: (id: string, adminPassword: string) =>
    request<{ ok: boolean }>(`/api/epayments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ adminPassword }),
    }),

  // Expenses
  createExpense: (payload: Partial<Expense>) =>
    request<{ expense: Expense }>('/api/expenses', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteExpense: (id: string, adminPassword: string) =>
    request<{ ok: boolean }>(`/api/expenses/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ adminPassword }),
    }),

  // SMS Notifications
  sendSms: (payload: { receiptId?: string; customerId?: string; message?: string }) =>
    request<{ smsLog: SmsLog }>('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  broadcastSms: (items: { customerId: string; message: string }[]) =>
    request<{ sentCount: number; logs: SmsLog[] }>('/api/sms/broadcast', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  // Due-bill permanent link reminders
  dueReminderPreview: () => request<DueReminderResult>('/api/reminders/due-preview'),

  dueReminderRun: () =>
    request<DueReminderResult>('/api/reminders/due-run', { method: 'POST' }),

  // Settings
  updateSettings: (payload: Partial<SettingsData> & { CurrentAdminPassword?: string }) =>
    request<{ settings: Omit<SettingsData, 'AdminPassword'> }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
};

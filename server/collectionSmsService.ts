import type {
  Collection,
  PaymentMethod,
  SettingsData,
  SmsEnvStatus,
  SmsLog,
  SmsProvider,
} from '../src/types';

export const DEFAULT_SMS_CONFIG = {
  Enabled: true,
  Provider: 'sandbox' as SmsProvider,
  SenderId: process.env.LOCAL_SMS_SENDER_ID || 'NetBillISP',
  PaymentSmsTemplate:
    'প্রিয় {Name} ({ID}), {Month} মাসের {Amount} বিল ({Method}) পরিশোধ হয়েছে। রিসিট: {ReceiptID}। ধন্যবাদ - {Company}',
};

export function getSmsEnvStatus(): SmsEnvStatus {
  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
  );
  const localConfigured = Boolean(
    process.env.LOCAL_SMS_API_URL && process.env.LOCAL_SMS_API_KEY
  );
  return { twilioConfigured, localConfigured };
}

export function normalizePhoneForSms(mobile: string, format: 'e164' | 'bd88'): string {
  const digits = mobile.replace(/\D/g, '');
  let bd = digits;
  if (digits.startsWith('01')) {
    bd = `88${digits}`;
  } else if (!digits.startsWith('880') && digits.length === 10) {
    bd = `880${digits}`;
  }
  return format === 'e164' ? `+${bd}` : bd;
}

export function paymentMethodBn(method: PaymentMethod): string {
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

/**
 * Formats a Bengali confirmation SMS for a processed Collections entry,
 * guaranteeing inclusion of customer name, amount, and receipt ID.
 */
export function formatBengaliCollectionSms(params: {
  settings: SettingsData;
  receipt: Collection;
  monthLabel: string;
}): string {
  const { settings, receipt, monthLabel } = params;
  const tpl = settings.SmsConfig?.PaymentSmsTemplate || DEFAULT_SMS_CONFIG.PaymentSmsTemplate;
  const amountFormatted = `৳${Math.round(receipt.Amount).toLocaleString('en-US')}`;

  let message = tpl
    .replace(/\{Name\}/g, receipt.CustomerName)
    .replace(/\{ID\}/g, receipt.CustomerID)
    .replace(/\{Month\}/g, monthLabel)
    .replace(/\{Amount\}/g, amountFormatted)
    .replace(/\{Method\}/g, paymentMethodBn(receipt.PaymentMethod))
    .replace(/\{TrxID\}/g, receipt.TrxID || '-')
    .replace(/\{ReceiptID\}/g, receipt.ReceiptID)
    .replace(/\{Company\}/g, settings.CompanyName);

  // Ensure customer name, amount, and receipt ID are always present even if template was customized
  const requiredParts: string[] = [];
  if (receipt.CustomerName && !message.includes(receipt.CustomerName)) {
    requiredParts.push(`গ্রাহক: ${receipt.CustomerName}`);
  }
  if (!message.includes(String(Math.round(receipt.Amount))) && !message.includes(amountFormatted)) {
    requiredParts.push(`পরিমাণ: ${amountFormatted}`);
  }
  if (receipt.ReceiptID && !message.includes(receipt.ReceiptID)) {
    requiredParts.push(`রিসিট: ${receipt.ReceiptID}`);
  }
  if (requiredParts.length > 0) {
    message = `${message.trim()} (${requiredParts.join(', ')})`;
  }

  return message;
}

export interface SendSmsGatewayResult {
  provider: SmsProvider;
  status: SmsLog['Status'];
  gatewayResponse: string;
}

export async function sendViaConfiguredSmsApi(params: {
  mobile: string;
  message: string;
  settings: SettingsData;
}): Promise<SendSmsGatewayResult> {
  const envStatus = getSmsEnvStatus();
  const provider: SmsProvider =
    (process.env.SMS_PROVIDER as SmsProvider) || params.settings.SmsConfig?.Provider || 'sandbox';

  let status: SmsLog['Status'] = 'Simulated';
  let gatewayResponse = '';

  if (provider === 'twilio' && envStatus.twilioConfigured) {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID!;
      const token = process.env.TWILIO_AUTH_TOKEN!;
      const from = process.env.TWILIO_FROM_NUMBER!;
      const to = normalizePhoneForSms(params.mobile, 'e164');
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const body = new URLSearchParams({ To: to, From: from, Body: params.message });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        }
      );
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (res.ok) {
        status = 'Sent';
        gatewayResponse = `Twilio SID: ${data.sid || 'OK'}`;
      } else {
        status = 'Failed';
        gatewayResponse = data.message || `Twilio HTTP ${res.status}`;
      }
    } catch (err) {
      status = 'Failed';
      gatewayResponse = (err as Error).message;
    }
  } else if (provider === 'local_bd' && envStatus.localConfigured) {
    try {
      const apiUrl = process.env.LOCAL_SMS_API_URL!;
      const apiKey = process.env.LOCAL_SMS_API_KEY!;
      const senderId =
        params.settings.SmsConfig?.SenderId || process.env.LOCAL_SMS_SENDER_ID || 'NetBillISP';
      const number = normalizePhoneForSms(params.mobile, 'bd88');

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          senderid: senderId,
          number,
          message: params.message,
        }),
      });
      const text = await res.text();
      if (res.ok) {
        status = 'Sent';
        gatewayResponse = text.slice(0, 140) || 'Local SMS API OK';
      } else {
        status = 'Failed';
        gatewayResponse = `HTTP ${res.status}: ${text.slice(0, 120)}`;
      }
    } catch (err) {
      status = 'Failed';
      gatewayResponse = (err as Error).message;
    }
  } else {
    status = 'Simulated';
    gatewayResponse =
      provider === 'sandbox'
        ? 'স্যান্ডবক্স মোড: নমুনা SMS সংরক্ষিত হয়েছে'
        : 'সার্ভার .env-এ SMS API ক্রেডেনশিয়াল না থাকায় স্যান্ডবক্স লগে সংরক্ষিত হয়েছে';
  }

  return { provider, status, gatewayResponse };
}

export async function dispatchSmsAndLog(params: {
  customerId: string;
  customerName: string;
  mobile: string;
  receiptId: string;
  message: string;
  settings: SettingsData;
  createId: (prefix: string) => string;
  persistSmsLog: (log: SmsLog) => Promise<void>;
}): Promise<SmsLog> {
  const gateway = await sendViaConfiguredSmsApi({
    mobile: params.mobile,
    message: params.message,
    settings: params.settings,
  });

  const logEntry: SmsLog = {
    SmsID: params.createId('SMS'),
    Timestamp: new Date().toISOString(),
    CustomerID: params.customerId,
    CustomerName: params.customerName,
    Mobile: params.mobile,
    ReceiptID: params.receiptId,
    Provider: gateway.provider,
    Message: params.message,
    Status: gateway.status,
    GatewayResponse: gateway.gatewayResponse,
  };

  await params.persistSmsLog(logEntry);
  return logEntry;
}

/**
 * Server-side service function triggered whenever a payment is successfully
 * processed into the 'Collections' store. Formats a Bengali confirmation SMS
 * (including customer name, amount, and receipt ID) and sends it via the
 * configured SMS API.
 */
export async function onCollectionPaymentProcessed(params: {
  receipt: Collection;
  customerMobile: string;
  settings: SettingsData;
  monthLabel: string;
  createId: (prefix: string) => string;
  persistSmsLog: (log: SmsLog) => Promise<void>;
}): Promise<SmsLog | null> {
  if (!params.settings.SmsConfig?.Enabled) {
    return null;
  }
  const mobile = params.customerMobile.trim();
  if (!mobile) {
    return null;
  }

  const message = formatBengaliCollectionSms({
    settings: params.settings,
    receipt: params.receipt,
    monthLabel: params.monthLabel,
  });

  return dispatchSmsAndLog({
    customerId: params.receipt.CustomerID,
    customerName: params.receipt.CustomerName,
    mobile,
    receiptId: params.receipt.ReceiptID,
    message,
    settings: params.settings,
    createId: params.createId,
    persistSmsLog: params.persistSmsLog,
  });
}

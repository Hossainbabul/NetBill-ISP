import React, { useCallback, useEffect, useState } from 'react';
import {
  Briefcase,
  CreditCard,
  FileText,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Receipt,
  Settings,
  UserCheck,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { api, getSavedToken, saveSessionToken } from './api';
import { Customer, DashboardPayload, SessionUser } from './types';
import { LoginView } from './components/LoginView';
import { PayPortal } from './components/PayPortal';
import { DashboardView } from './components/DashboardView';
import { CustomersView } from './components/CustomersView';
import { BillingEPayView } from './components/BillingEPayView';
import { AreasView, CollectorsView } from './components/AreasCollectorsView';
import { ManagerView, SettingsView } from './components/ManagerSettingsView';
import { CollectBillModal } from './components/CollectBillModal';
import { PrintPayload, PrintPreviewModal } from './components/PrintPreviewModal';
import { toBnDigits } from './utils/bengali';

type NavTab =
  | 'dashboard'
  | 'areas'
  | 'collectors'
  | 'my-ledger'
  | 'customers'
  | 'billing'
  | 'manager'
  | 'settings';

export default function App() {
  const urlParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const initialPagePay = urlParams?.get('page') === 'pay';
  const initialCid = urlParams?.get('cid') || '';

  const [publicPayMode, setPublicPayMode] = useState(initialPagePay);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [billingSubTab, setBillingSubTab] = useState<'collections' | 'generate' | 'epay'>(
    'collections'
  );
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const [collectCustomer, setCollectCustomer] = useState<Customer | null>(null);
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null);

  const loadBootstrap = useCallback(async () => {
    setLoadingData(true);
    try {
      const payload = await api.bootstrap();
      setData(payload);
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      saveSessionToken('', false);
      setUser(null);
      setData(null);
    };
    window.addEventListener('netbill:unauthorized', handleUnauthorized);

    const token = getSavedToken();
    if (!token) {
      setAuthChecking(false);
    } else {
      api
        .getSession()
        .then((res) => {
          setUser(res.user);
          return loadBootstrap();
        })
        .catch(() => {
          saveSessionToken('', false);
          setUser(null);
        })
        .finally(() => setAuthChecking(false));
    }

    return () => {
      window.removeEventListener('netbill:unauthorized', handleUnauthorized);
    };
  }, [loadBootstrap]);

  const handleLoginSuccess = async (loggedUser: SessionUser) => {
    setUser(loggedUser);
    setActiveTab('dashboard');
    await loadBootstrap();
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    saveSessionToken('', false);
    setUser(null);
    setData(null);
  };

  if (publicPayMode) {
    return (
      <PayPortal
        initialCid={initialCid}
        onExitPortal={() => {
          setPublicPayMode(false);
          if (typeof window !== 'undefined' && window.location.search.includes('page=pay')) {
            window.history.replaceState({}, '', '/');
          }
        }}
      />
    );
  }

  if (authChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-600">
        লোড হচ্ছে...
      </div>
    );
  }

  if (!user) {
    return (
      <LoginView
        onLoginSuccess={handleLoginSuccess}
        onOpenPayPortal={() => setPublicPayMode(true)}
      />
    );
  }

  const isAdmin = user.role === 'Admin';
  const pendingEPayCount = data?.ePayments.filter((e) => e.Status === 'Pending').length || 0;

  const navItems: { id: NavTab; label: string; icon: React.ReactNode; badge?: number }[] = isAdmin
    ? [
        { id: 'dashboard', label: 'ড্যাশবোর্ড', icon: <LayoutDashboard className="h-4 w-4" /> },
        { id: 'areas', label: 'এরিয়া', icon: <MapPin className="h-4 w-4" /> },
        { id: 'collectors', label: 'কালেক্টর', icon: <UserCheck className="h-4 w-4" /> },
        { id: 'customers', label: 'গ্রাহক', icon: <Users className="h-4 w-4" /> },
        {
          id: 'billing',
          label: 'বিলিং ও ই-পেমেন্ট',
          icon: <Receipt className="h-4 w-4" />,
          badge: pendingEPayCount,
        },
        { id: 'manager', label: 'ম্যানেজার', icon: <Briefcase className="h-4 w-4" /> },
        { id: 'settings', label: 'সেটিংস', icon: <Settings className="h-4 w-4" /> },
      ]
    : [
        { id: 'dashboard', label: 'ড্যাশবোর্ড', icon: <LayoutDashboard className="h-4 w-4" /> },
        { id: 'my-ledger', label: 'আমার লেজার', icon: <FileText className="h-4 w-4" /> },
        { id: 'customers', label: 'গ্রাহক', icon: <Users className="h-4 w-4" /> },
        { id: 'billing', label: 'বিল', icon: <Receipt className="h-4 w-4" /> },
      ];

  const mobileBottomItems = navItems.slice(0, 4);

  const navigateTo = (tab: NavTab, subTab?: 'collections' | 'generate' | 'epay') => {
    setActiveTab(tab);
    if (subTab) {
      setBillingSubTab(subTab);
    }
    setMobileDrawerOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Desktop Fixed Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col bg-[#0f4c5c] text-white lg:flex">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
            <Wifi className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight">NetBill ISP</h1>
            <p className="truncate text-[11px] text-teal-100">
              {data?.settings.CompanyName || 'ইন্টারনেট ও ডিস বিলিং'}
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-white text-[#0f4c5c] font-semibold'
                    : 'text-teal-50 hover:bg-white/10'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  {item.icon}
                  {item.label}
                </span>
                {item.badge && item.badge > 0 ? (
                  <span
                    className={`font-mono-num text-xs font-bold ${
                      active ? 'text-[#E2136E]' : 'text-amber-300'
                    }`}
                  >
                    {toBnDigits(item.badge)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-3 space-y-2">
          <button
            type="button"
            onClick={() => setPublicPayMode(true)}
            className="flex w-full items-center gap-2.5 rounded-lg bg-white/10 px-3.5 py-2 text-xs font-medium text-teal-50 hover:bg-white/20"
          >
            <CreditCard className="h-4 w-4" />
            গ্রাহক ই-বিল পোর্টাল
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 rounded-lg px-3.5 py-2 text-xs font-medium text-red-200 hover:bg-red-500/20"
          >
            <LogOut className="h-4 w-4" />
            লগআউট ({user.username})
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <aside className="relative z-10 flex w-64 flex-col bg-[#0f4c5c] text-white">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3.5">
              <span className="text-base font-bold">NetBill ISP</span>
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                className="rounded-lg p-1.5 text-teal-100 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 p-3">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3.5 py-2.5 text-sm font-medium ${
                    activeTab === item.id
                      ? 'bg-white text-[#0f4c5c] font-semibold'
                      : 'text-teal-50 hover:bg-white/10'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {item.icon}
                    {item.label}
                  </span>
                </button>
              ))}
            </nav>
            <div className="border-t border-white/10 p-3 space-y-2">
              <button
                type="button"
                onClick={() => setPublicPayMode(true)}
                className="flex w-full items-center gap-2 rounded-lg bg-white/10 px-3.5 py-2 text-xs font-medium text-white"
              >
                <CreditCard className="h-4 w-4" />
                গ্রাহক ই-বিল পোর্টাল
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium text-red-200"
              >
                <LogOut className="h-4 w-4" />
                লগআউট
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="lg:pl-[260px]">
        {/* Top Header + Notice Marquee */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(true)}
                className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-100 lg:hidden"
                aria-label="মেনু খুলুন"
              >
                <Menu className="h-4 w-4" />
              </button>
              <span className="truncate text-sm font-bold text-slate-900">
                {data?.settings.CompanyName || 'NetBill ISP'}
              </span>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <span className="hidden text-xs text-slate-600 sm:inline">
                {user.name} ({isAdmin ? 'Admin' : 'Collector'})
              </span>
              <button
                type="button"
                onClick={() => setPublicPayMode(true)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#0f4c5c] hover:bg-slate-50 whitespace-nowrap"
              >
                ই-বিল পোর্টাল
              </button>
            </div>
          </div>

          {data?.settings.ScrollingNotice && (
            <div className="overflow-hidden border-t border-slate-100 bg-teal-50/70 py-1 text-xs font-medium text-[#0f4c5c]">
              <div className="notice-marquee-track px-4">
                নোটিশ: {data.settings.ScrollingNotice}
              </div>
            </div>
          )}
        </header>

        <main className="mx-auto max-w-7xl p-4 pb-20 sm:p-6 lg:pb-8">
          {!data || loadingData ? (
            <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              তথ্য লোড হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন...
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && (
                <DashboardView
                  data={data}
                  user={user}
                  onNavigateBilling={(sub) => navigateTo('billing', sub)}
                  onQuickCollect={(c) => setCollectCustomer(c)}
                />
              )}

              {activeTab === 'areas' && isAdmin && (
                <AreasView data={data} onRefresh={loadBootstrap} />
              )}

              {(activeTab === 'collectors' || activeTab === 'my-ledger') && (
                <CollectorsView
                  data={data}
                  user={user}
                  onRefresh={loadBootstrap}
                  onPrint={(p) => setPrintPayload(p)}
                />
              )}

              {activeTab === 'customers' && (
                <CustomersView
                  data={data}
                  user={user}
                  onRefresh={loadBootstrap}
                  onCollect={(c) => setCollectCustomer(c)}
                  onPrint={(p) => setPrintPayload(p)}
                />
              )}

              {activeTab === 'billing' && (
                <BillingEPayView
                  key={billingSubTab}
                  data={data}
                  user={user}
                  initialSubTab={billingSubTab}
                  onRefresh={loadBootstrap}
                  onCollect={(c) => setCollectCustomer(c)}
                  onPrint={(p) => setPrintPayload(p)}
                />
              )}

              {activeTab === 'manager' && isAdmin && (
                <ManagerView
                  data={data}
                  onRefresh={loadBootstrap}
                  onPrint={(p) => setPrintPayload(p)}
                />
              )}

              {activeTab === 'settings' && isAdmin && (
                <SettingsView data={data} onRefresh={loadBootstrap} />
              )}
            </>
          )}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-slate-200 bg-white py-1.5 lg:hidden">
        {mobileBottomItems.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateTo(item.id)}
              className={`flex flex-col items-center gap-0.5 px-2 py-1 text-[11px] font-medium ${
                active ? 'text-[#0f4c5c] font-bold' : 'text-slate-500'
              }`}
            >
              {item.icon}
              <span className="truncate max-w-[70px]">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Global Collect Bill Modal & Print Preview Modal */}
      {data && (
        <CollectBillModal
          customer={collectCustomer}
          bills={data.bills}
          collections={data.collections}
          company={data.settings}
          onClose={() => setCollectCustomer(null)}
          onCollected={loadBootstrap}
          onPrint={(p) => setPrintPayload(p)}
        />
      )}

      {data && (
        <PrintPreviewModal
          payload={printPayload}
          company={data.settings}
          onClose={() => setPrintPayload(null)}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, Panel, ToastProvider } from '@/components/common';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { HonorsPage } from '@/features/honors/HonorsPage';
import { LedgerPage } from '@/features/ledger/LedgerPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { WorkPage } from '@/features/work/WorkPage';
import { requestPersistentStorage } from '@/services/storage/persistence';
import { registerServiceWorker } from './pwa/service-worker-bridge';
import type { UpdateState } from './pwa/service-worker-bridge';
import { useRoute } from './router';
import { DataProvider } from './store/data-context';
import { useDataContext } from './store/data-store';
import styles from './App.module.css';

export function App(): ReactNode {
  return (
    <ToastProvider>
      <DataProvider>
        <AppRoot />
      </DataProvider>
    </ToastProvider>
  );
}

function AppRoot(): ReactNode {
  const { route, navigate } = useRoute();
  const { state, refresh } = useDataContext();
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [applying, setApplying] = useState(false);
  // A ref, not state: the controller is never rendered, so storing it in state would force an
  // extra render pass on mount for no visible change.
  const controllerRef = useRef<ReturnType<typeof registerServiceWorker> | null>(null);

  // Ask for durable storage once, on first mount. Declining is fine and is reported in Settings.
  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  useEffect(() => {
    // In dev the plugin does not emit a worker; guard so the import does not throw.
    if (!import.meta.env.PROD) return;
    controllerRef.current = registerServiceWorker({ onStateChange: setUpdateState });
  }, []);

  const title = state.status === 'ready' ? state.data.settings.appTitle : 'CivicWorkDesk';

  if (state.status === 'error') {
    return (
      <AppShell title={title} route={route} onNavigate={navigate}>
        <Panel tone="danger">
          <h1 className={styles.errorTitle}>无法打开本机数据库</h1>
          <p>{state.error.message}</p>
          <p className={styles.errorHint}>
            可能原因：浏览器处于隐私模式、IndexedDB 被策略禁用，或以 <code>file://</code> 方式打开。
            请通过 HTTPS 或本机 localhost 打开本应用。
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            重试
          </Button>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={title}
      route={route}
      onNavigate={navigate}
      banner={
        updateState === 'update-ready' ? (
          <Panel tone="warning">
            <div className={styles.updateBar}>
              <p className={styles.updateText}>
                有新版本可用。现在应用会重新加载页面；请先保存正在编辑的内容。
              </p>
              <Button
                size="sm"
                variant="primary"
                icon={<RefreshCw size={14} />}
                busy={applying}
                onClick={() => {
                  setApplying(true);
                  void controllerRef.current?.applyUpdate();
                }}
              >
                应用更新
              </Button>
            </div>
          </Panel>
        ) : undefined
      }
    >
      {state.status === 'loading' ? (
        <p className={styles.loading} role="status">
          正在读取本机数据…
        </p>
      ) : (
        <RouteView route={route} onNavigate={navigate} />
      )}
    </AppShell>
  );
}

function RouteView({
  route,
  onNavigate,
}: {
  readonly route: ReturnType<typeof useRoute>['route'];
  readonly onNavigate: ReturnType<typeof useRoute>['navigate'];
}): ReactNode {
  switch (route) {
    case 'dashboard':
      return <DashboardPage onNavigate={onNavigate} />;
    case 'work':
      return <WorkPage />;
    case 'honors':
      return <HonorsPage />;
    case 'ledger':
      return <LedgerPage />;
    case 'reports':
      return <ReportsPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAtlas } from './store.ts';
import { Shell } from './components/Shell.tsx';
import { LoginView } from './views/Login.tsx';
import { VillageView } from './views/Village.tsx';
import { DashboardView } from './views/Dashboard.tsx';
import { MissionsView } from './views/Missions.tsx';
import { DepartmentsView } from './views/Departments.tsx';
import { MissionDetailView } from './views/MissionDetail.tsx';
import { AgentsView } from './views/Agents.tsx';
import { MemoryView } from './views/Memory.tsx';
import { AutomationView } from './views/Automation.tsx';
import { EvolutionView } from './views/Evolution.tsx';
import { LogsView } from './views/Logs.tsx';
import { SettingsView } from './views/Settings.tsx';

/**
 * Application shell and routing.
 *
 * Two coexisting experiences over one data source (SRS §3.9): the immersive
 * village at `/village`, and the professional Command Center everywhere else.
 */
export default function App() {
  const { user, booting, boot } = useAtlas();
  const location = useLocation();

  useEffect(() => {
    void boot();
  }, [boot]);

  if (booting) {
    return (
      <div className="flex h-full items-center justify-center bg-[--color-void]">
        <div className="flex flex-col items-center gap-4">
          <div className="size-10 animate-spin rounded-full border-2 border-[--color-border] border-t-[--color-atlas]" />
          <div className="font-display text-sm tracking-[0.3em] text-[--color-faint]">ATLAS OS</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginView />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* The village is full-bleed: it gets the whole viewport, not a content column. */}
      <Route path="/village" element={<VillageView />} />

      <Route element={<Shell />}>
        <Route path="/" element={<DashboardView />} />
        <Route path="/missions" element={<MissionsView />} />
        <Route path="/missions/:id" element={<MissionDetailView />} />
        <Route path="/departments" element={<DepartmentsView />} />
        <Route path="/agents" element={<AgentsView />} />
        <Route path="/memory" element={<MemoryView />} />
        <Route path="/automation" element={<AutomationView />} />
        <Route path="/evolution" element={<EvolutionView />} />
        <Route path="/logs" element={<LogsView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

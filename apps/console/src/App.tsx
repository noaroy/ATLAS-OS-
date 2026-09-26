import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAtlas } from './store.ts';
import { Shell } from './components/Shell.tsx';
import { LoginView } from './views/Login.tsx';
import { VillageView } from './views/Village.tsx';
import { DashboardView } from './views/Dashboard.tsx';
import { AtlasView } from './views/Atlas.tsx';
import { MissionsView } from './views/Missions.tsx';
import { DepartmentsView } from './views/Departments.tsx';
import { MissionDetailView } from './views/MissionDetail.tsx';
import { AgentsView } from './views/Agents.tsx';
import { MemoryView } from './views/Memory.tsx';
import { AutomationView } from './views/Automation.tsx';
import { EvolutionView } from './views/Evolution.tsx';
import { LogsView } from './views/Logs.tsx';
import { SettingsView } from './views/Settings.tsx';
import { WarRoomView } from './views/WarRoom.tsx';
import { ProspectingView } from './views/Prospecting.tsx';
import {
  AgentsView as OpsAgentsView, OrganizationView, SystemHealthView,
} from './views/Operations.tsx';
import { AiFabricView, CostsView } from './views/Fabric.tsx';
import {
  CompaniesView, CompanyDetailView, InboxView, ApprovalsView,
} from './views/Pipeline.tsx';
import { SearchFabricScreen, MultiModelView } from './views/Search.tsx';
import { OutreachScreen, FollowUpsScreen, AnalyticsScreen } from './views/Outreach.tsx';
import { SalesView } from './views/Sales.tsx';
import { HomeView } from './views/Home.tsx';
import { MobileView } from './views/Mobile.tsx';

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

      {/* L'accueil : trois questions, sans cadre ni rail. Tout le detail vit
          dans les ecrans du centre de commande, accessibles depuis la page. */}
      <Route path="/" element={<HomeView />} />

      {/* Le revenu depuis un téléphone : une colonne, une lecture, pas de rail. */}
      <Route path="/m" element={<MobileView />} />

      <Route element={<Shell />}>
        {/* L'ecran d'accueil : la page unique du moteur commercial — ce que ca
            rapporte, ou ca coince, ce qu'ATLAS propose. L'ancien accueil et le
            tableau de bord restent accessibles pour le detail operationnel. */}
        <Route path="/cc/sales" element={<SalesView />} />
        <Route path="/atlas" element={<AtlasView />} />
        <Route path="/system" element={<SystemHealthView />} />
        <Route path="/dashboard" element={<DashboardView />} />
        <Route path="/missions" element={<MissionsView />} />
        <Route path="/missions/:id" element={<MissionDetailView />} />
        <Route path="/departments" element={<DepartmentsView />} />
        <Route path="/agents" element={<AgentsView />} />
        <Route path="/memory" element={<MemoryView />} />
        <Route path="/automation" element={<AutomationView />} />
        <Route path="/evolution" element={<EvolutionView />} />
        <Route path="/logs" element={<LogsView />} />
        <Route path="/settings" element={<SettingsView />} />

        {/* Le centre de commande : une vue par question qu'on se pose le matin.
            Chacune lit les depots existants, aucune ne stocke ni ne decide. */}
        <Route path="/cc/war-room" element={<WarRoomView />} />
        <Route path="/cc/prospecting" element={<ProspectingView />} />
        <Route path="/cc/companies" element={<CompaniesView />} />
        <Route path="/cc/companies/:domain" element={<CompanyDetailView />} />
        <Route path="/cc/inbox" element={<InboxView />} />
        <Route path="/cc/approvals" element={<ApprovalsView />} />
        <Route path="/cc/agents" element={<OpsAgentsView />} />
        <Route path="/cc/organization" element={<OrganizationView />} />
        <Route path="/cc/ai-fabric" element={<AiFabricView />} />
        <Route path="/cc/costs" element={<CostsView />} />
        <Route path="/cc/system" element={<SystemHealthView />} />
        <Route path="/cc/outreach" element={<OutreachScreen />} />
        <Route path="/cc/follow-ups" element={<FollowUpsScreen />} />
        <Route path="/cc/search-fabric" element={<SearchFabricScreen />} />
        <Route path="/cc/multi-model" element={<MultiModelView />} />
        <Route path="/cc/analytics" element={<AnalyticsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

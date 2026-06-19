import { Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthProvider";
import { CallbackPage } from "./auth/CallbackPage";
import { Shell } from "./components/Shell";
import { DeployProvider, useDeploy } from "./modals/DeployContext";
import { AppsListPage } from "./pages/AppsListPage";
import { AppDetailPage } from "./pages/AppDetailPage";
import { UsagePage } from "./pages/UsagePage";
import { ApprovalsPage } from "./pages/admin/ApprovalsPage";
import { AuditPage } from "./pages/admin/AuditPage";
import { PlatformPage } from "./pages/admin/PlatformPage";
import { RegistryPage } from "./pages/admin/RegistryPage";
import { SecretsPage } from "./pages/admin/SecretsPage";
import { ViolationsPage } from "./pages/admin/ViolationsPage";

function Portal() {
  const { openDeploy } = useDeploy();
  return (
    <Shell onDeploy={() => openDeploy()}>
      <Routes>
        <Route path="/" element={<AppsListPage />} />
        <Route path="/apps/:slug" element={<AppDetailPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/admin/approvals" element={<ApprovalsPage />} />
        <Route path="/admin/audit" element={<AuditPage />} />
        <Route path="/admin/platform" element={<PlatformPage />} />
        <Route path="/admin/registry" element={<RegistryPage />} />
        <Route path="/admin/secrets" element={<SecretsPage />} />
        <Route path="/admin/violations" element={<ViolationsPage />} />
        <Route path="*" element={<AppsListPage />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/auth/callback" element={<CallbackPage />} />
        <Route
          path="*"
          element={
            <DeployProvider>
              <Portal />
            </DeployProvider>
          }
        />
      </Routes>
    </AuthProvider>
  );
}

import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthProvider";
import { CallbackPage } from "./auth/CallbackPage";
import { RequireAdmin, RequireAuth } from "./auth/guards";
import { Shell } from "./components/Shell";
import { DeployProvider } from "./modals/DeployContext";
import { HelpProvider } from "./modals/HelpContext";
import { AppsListPage } from "./pages/AppsListPage";
import { AppDetailPage } from "./pages/AppDetailPage";
import { UsagePage } from "./pages/UsagePage";
import { ApprovalsPage } from "./pages/admin/ApprovalsPage";
import { AuditPage } from "./pages/admin/AuditPage";
import { PlatformPage } from "./pages/admin/PlatformPage";
import { SecretsPage } from "./pages/admin/SecretsPage";
import { ViolationsPage } from "./pages/admin/ViolationsPage";

/** Wrap an admin route element in the platform-admin gate. */
function admin(element: ReactNode) {
  return <RequireAdmin>{element}</RequireAdmin>;
}

function Portal() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<AppsListPage />} />
        <Route path="/apps/:slug" element={<AppDetailPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/admin/approvals" element={admin(<ApprovalsPage />)} />
        <Route path="/admin/audit" element={admin(<AuditPage />)} />
        <Route path="/admin/platform" element={admin(<PlatformPage />)} />
        {/* The admin registry was a second, admin-only rendering of the same
            `GET /api/v1/apps` the apps page shows. It is now that page's `all`
            scope, open to any signed-in principal — so the old route keeps
            working as a link, rather than 404ing bookmarks. */}
        <Route path="/admin/registry" element={<Navigate to="/?scope=all" replace />} />
        <Route path="/admin/secrets" element={admin(<SecretsPage />)} />
        <Route path="/admin/violations" element={admin(<ViolationsPage />)} />
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
              <HelpProvider>
                <RequireAuth>
                  <Portal />
                </RequireAuth>
              </HelpProvider>
            </DeployProvider>
          }
        />
      </Routes>
    </AuthProvider>
  );
}

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CreateAppModal } from "./CreateAppModal";
import { DeployModal } from "./DeployModal";

/** Global launcher for the deploy/create modals (sidebar button, page CTAs). */

interface DeployControls {
  /** Open the deploy modal, optionally preselecting an app. */
  openDeploy: (slug?: string) => void;
  openCreate: () => void;
}

const DeployCtx = createContext<DeployControls | null>(null);

export function DeployProvider({ children }: { children: ReactNode }) {
  const [deploySlug, setDeploySlug] = useState<string | null | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);

  const openDeploy = useCallback((slug?: string) => setDeploySlug(slug ?? null), []);
  const openCreate = useCallback(() => setCreateOpen(true), []);
  const value = useMemo(() => ({ openDeploy, openCreate }), [openDeploy, openCreate]);

  return (
    <DeployCtx.Provider value={value}>
      {children}
      <DeployModal
        opened={deploySlug !== undefined}
        initialSlug={deploySlug ?? undefined}
        onClose={() => setDeploySlug(undefined)}
        onCreateApp={() => {
          setDeploySlug(undefined);
          setCreateOpen(true);
        }}
      />
      <CreateAppModal opened={createOpen} onClose={() => setCreateOpen(false)} />
    </DeployCtx.Provider>
  );
}

export function useDeploy(): DeployControls {
  const ctx = useContext(DeployCtx);
  if (!ctx) throw new Error("useDeploy outside DeployProvider");
  return ctx;
}

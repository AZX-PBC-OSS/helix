import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CreateAppModal } from "./CreateAppModal";
import { DeployModal } from "./DeployModal";

/** Global launcher for the deploy/create modals, opened from page-level CTAs. */

interface DeployControls {
  /**
   * Open the deploy modal against an app. The slug is required: a build is
   * always shipped *into* something, and picking that something is the apps page's
   * job — it shows live/preview state, host and version, where an in-modal
   * app dropdown showed a name and a slug.
   */
  openDeploy: (slug: string) => void;
  openCreate: () => void;
}

const DeployCtx = createContext<DeployControls | null>(null);

export function DeployProvider({ children }: { children: ReactNode }) {
  // Open-ness is tracked apart from the target so the slug survives Mantine's
  // close transition — collapsing the two would blank the modal body mid-fade.
  const [deploySlug, setDeploySlug] = useState<string | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const openDeploy = useCallback((slug: string) => {
    setDeploySlug(slug);
    setDeployOpen(true);
  }, []);
  const openCreate = useCallback(() => setCreateOpen(true), []);
  const value = useMemo(() => ({ openDeploy, openCreate }), [openDeploy, openCreate]);

  return (
    <DeployCtx.Provider value={value}>
      {children}
      <DeployModal opened={deployOpen} slug={deploySlug} onClose={() => setDeployOpen(false)} />
      <CreateAppModal opened={createOpen} onClose={() => setCreateOpen(false)} />
    </DeployCtx.Provider>
  );
}

export function useDeploy(): DeployControls {
  const ctx = useContext(DeployCtx);
  if (!ctx) throw new Error("useDeploy outside DeployProvider");
  return ctx;
}

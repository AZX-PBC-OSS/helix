import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { HelpModal } from "./HelpModal";

/**
 * Global launcher for the onboarding modal, opened from more than one place.
 *
 * It lived on `useState` in `components/Shell.tsx` while the sidebar footer was
 * the only entry point. The apps page's handoff band is the second, and it sits
 * under `Shell` rather than inside it — hence a provider, mounted above both.
 * Deliberately not folded into `DeployContext`: that one launches the
 * deploy/create dialogs, and `useDeploy().openHelp` would read wrong.
 */

interface HelpControls {
  openHelp: () => void;
}

const HelpCtx = createContext<HelpControls | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openHelp = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ openHelp }), [openHelp]);

  return (
    <HelpCtx.Provider value={value}>
      {children}
      <HelpModal opened={open} onClose={() => setOpen(false)} />
    </HelpCtx.Provider>
  );
}

export function useHelp(): HelpControls {
  const ctx = useContext(HelpCtx);
  if (!ctx) throw new Error("useHelp outside HelpProvider");
  return ctx;
}

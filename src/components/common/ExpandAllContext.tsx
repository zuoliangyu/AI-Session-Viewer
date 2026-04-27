import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ExpandAllState {
  expanded: boolean;
  version: number;
}

const ExpandAllContext = createContext<ExpandAllState | null>(null);

export function ExpandAllProvider({
  value,
  children,
}: {
  value: ExpandAllState;
  children: ReactNode;
}) {
  return (
    <ExpandAllContext.Provider value={value}>
      {children}
    </ExpandAllContext.Provider>
  );
}

export function useExpandAllControl(
  defaultExpanded = true,
  options?: { followGlobal?: boolean }
) {
  const ctx = useContext(ExpandAllContext);
  const followGlobal = options?.followGlobal ?? false;
  // When followGlobal=true and a context is present, the *initial* expanded
  // state mirrors the page-level setting (so persisted "default collapsed"
  // wins on first paint). Otherwise each block keeps its hard-coded default.
  const initial = followGlobal && ctx ? ctx.expanded : defaultExpanded;
  const [expanded, setExpanded] = useState(initial);
  const skipFirstSyncRef = useRef(true);

  // Sync to the global expand/collapse state only when the user explicitly
  // toggles it (version bumps). The first effect run at mount is a no-op so
  // blocks like thinking can keep their own defaultExpanded=false even when
  // the surrounding page starts in the "all expanded" state.
  useEffect(() => {
    if (skipFirstSyncRef.current) {
      skipFirstSyncRef.current = false;
      return;
    }
    if (!ctx) return;
    setExpanded(ctx.expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.version]);

  return { expanded, setExpanded };
}

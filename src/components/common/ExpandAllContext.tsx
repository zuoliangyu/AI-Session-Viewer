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

export function useExpandAllControl(defaultExpanded = true) {
  const ctx = useContext(ExpandAllContext);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const skipFirstSyncRef = useRef(true);

  // Sync to the global expand/collapse state only when the user explicitly
  // toggles it (version bumps). The first effect run at mount is a no-op so
  // that blocks like thinking can keep their own defaultExpanded=false even
  // when the surrounding page starts in the "all expanded" state.
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

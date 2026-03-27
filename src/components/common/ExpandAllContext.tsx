import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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
  const [expanded, setExpanded] = useState(() => ctx?.expanded ?? defaultExpanded);

  useEffect(() => {
    if (!ctx) return;
    setExpanded(ctx.expanded);
  }, [ctx?.expanded, ctx?.version]);

  return { expanded, setExpanded };
}

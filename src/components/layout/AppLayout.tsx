import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { ScrollArea } from "../ScrollArea";
import { Sidebar } from "./Sidebar";
import { UpdateDialog } from "./UpdateDialog";

export function AppLayout() {
  const { t } = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const location = useLocation();
  const navigationRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => { setCompact(media.matches); setNavigationOpen(false); };
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { setNavigationOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!navigationOpen) return;
    const previous = document.activeElement;
    navigationRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [navigationOpen]);
  return (
    <div className="workspace-shell flex h-dvh overflow-hidden">
      {compact && navigationOpen && <button className="fixed inset-0 z-40 bg-black/30" aria-label={t("关闭导航")} onClick={() => setNavigationOpen(false)} />}
      <div
        ref={navigationRef}
        role={compact && navigationOpen ? "dialog" : undefined}
        aria-modal={compact && navigationOpen ? true : undefined}
        aria-label={t("主导航")}
        inert={compact && !navigationOpen}
        className={`workspace-navigation ${navigationOpen ? "is-open" : ""}`}
        onKeyDown={(event) => {
          if (!compact || !navigationOpen) return;
          if (event.key === "Escape") setNavigationOpen(false);
          if (event.key !== "Tab") return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, a, select, input, summary, [tabindex='0']")).filter((item) => item.getClientRects().length && !item.matches(":disabled"));
          const first = items[0]; const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <button className="absolute right-2 top-2 z-10 rounded p-1.5 text-muted-foreground lg:hidden" aria-label={t("关闭导航")} onClick={() => setNavigationOpen(false)}><X className="h-4 w-4" /></button>
        <Sidebar />
      </div>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" inert={compact && navigationOpen}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3 lg:hidden">
          <button ref={triggerRef} className="toolbar-button" aria-label={t("打开导航")} aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><Menu className="h-4 w-4" />{t("导航")}</button>
          <span className="text-xs font-medium text-muted-foreground">AI Session Viewer</span>
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full" contentClassName="h-full">
          <Outlet />
        </ScrollArea>
      </main>
      <UpdateDialog />
    </div>
  );
}

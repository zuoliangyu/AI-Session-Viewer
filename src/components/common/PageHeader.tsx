import { t } from "../../i18n/index.js";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useAppStore } from "../../stores/appStore";

export interface Crumb {
  label: string;
  /** Omit for the current (last) crumb. */
  to?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  omp: "Oh My Pi",
};

/** Breadcrumb trail starting at the active source, so every page shows which
 *  data source it belongs to and back navigation is one click. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const source = useAppStore((state) => state.source);
  const crumbs: Crumb[] = [{ label: SOURCE_LABELS[source] ?? source, to: "/projects" }, ...items];
  return (
    <nav aria-label={t("面包屑导航")} className="mb-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={`${index}-${crumb.label}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden />}
            {crumb.to && !last ? (
              <Link to={crumb.to} className="truncate hover:text-foreground hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate" aria-current={last ? "page" : undefined}>
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Standard page header: breadcrumb, title, one-line description, actions on
 *  the right. Keeps title/action placement identical across pages. */
export function PageHeader({
  breadcrumbs,
  title,
  description,
  actions,
  className = "",
}: {
  breadcrumbs?: Crumb[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`workspace-page-header ${className}`}>
      <div className="min-w-0 flex-1">
        {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
        <h1 className="workspace-page-title truncate">{title}</h1>
        {description && <div className="workspace-page-description truncate">{description}</div>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

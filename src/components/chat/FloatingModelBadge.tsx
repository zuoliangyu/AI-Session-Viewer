import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { ChevronDown, Bot } from "lucide-react";

interface Props {
  model: string;
  onClick: () => void;
}

/** Derive a short display name from a full model ID. */
function shortName(id: string): string {
  let name = id.replace(/-\d{8}$/, "");
  name = name.replace(/^claude-/, "");
  return name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

export function FloatingModelBadge({ model, onClick }: Props) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-10 flex justify-center py-1.5 pointer-events-none">
      <button
        onClick={onClick}
        className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 text-xs font-medium backdrop-blur-sm transition-colors"
      >
        <Bot className="w-3 h-3" />
        <span>{model ? shortName(model) : t("选择模型")}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
    </div>
  );
}

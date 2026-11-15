import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";

export function TagLoadError() {
  const { t } = useTranslation();
  const status = useAppStore((state) => state.crossProjectTagsStatus);
  const error = useAppStore((state) => state.crossProjectTagsError);
  const load = useAppStore((state) => state.loadCrossProjectTags);
  if (status !== "error") return null;

  return (
    <div role="alert" className="mb-3 flex items-center gap-2 text-xs text-destructive">
      <span className="min-w-0 break-words">
        {t("标签加载失败：{{message}}", { message: error })}
      </span>
      <button type="button" className="shrink-0 underline" onClick={() => void load(true)}>
        {t("重试")}
      </button>
    </div>
  );
}

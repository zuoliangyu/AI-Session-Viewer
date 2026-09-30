import { t, getLanguage, setLanguage } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { api } from "../../services/api";
import type { ModelInfo } from "../../types/chat";
import { UpdateIndicator } from "../layout/UpdateIndicator";
import {
  formatDateTime,
  getSupportedTimeZones,
  getSystemTimeZone,
} from "../../utils/dateTime";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  Settings,
  Mail,
  Users,
  Github,
  ExternalLink,
  RefreshCw,
  Plus,
  Trash2,
  Check,
  Copy,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { SOURCE_OPTIONS, readHiddenSources, writeHiddenSources, HIDDEN_SOURCES_CHANGED, type SessionSource } from "../layout/sourceOptions";
import { PageHeader } from "../common/PageHeader";
import { BookOpen, Info, MessageSquare, RefreshCcw, SlidersHorizontal } from "lucide-react";

declare const __IS_TAURI__: boolean;
declare const __APP_VERSION__: string;

type SettingsSection = "general" | "chat" | "update" | "guide" | "about";

const openExternal = async (url: string) => {
  if (__IS_TAURI__) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
};

/** Settings as a routed page (was a 28rem modal behind a 14px gear), with a
 *  section nav so sections are discoverable and deep-linkable via `?section=`. */
export function SettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const sections: { id: SettingsSection; label: string; icon: typeof Info }[] = [
    { id: "general", label: t("显示设置"), icon: SlidersHorizontal },
    { id: "chat", label: t("对话设置"), icon: MessageSquare },
    ...(__IS_TAURI__ ? [{ id: "update" as const, label: t("更新检查"), icon: RefreshCcw }] : []),
    { id: "guide", label: t("使用说明"), icon: BookOpen },
    { id: "about", label: t("关于作者"), icon: Info },
  ];
  const requested = searchParams.get("section") as SettingsSection | null;
  const section: SettingsSection = sections.some((item) => item.id === requested) ? requested! : "general";

  const [hiddenSources, setHiddenSources] = useState<SessionSource[]>(readHiddenSources);
  useEffect(() => {
    const update = () => setHiddenSources(readHiddenSources());
    window.addEventListener(HIDDEN_SOURCES_CHANGED, update);
    return () => window.removeEventListener(HIDDEN_SOURCES_CHANGED, update);
  }, []);

  return (
    <div className="workspace-page">
      <PageHeader title={t("设置")} description={<>v{__APP_VERSION__}</>} />
      <div className="flex flex-col gap-4 md:flex-row">
        <nav aria-label={t("设置")} className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSearchParams({ section: id }, { replace: true })}
              aria-current={section === id ? "page" : undefined}
              className={"navigation-link " + (section === id ? "is-active" : "")}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
        <section className="min-w-0 flex-1 rounded-lg border border-border bg-card">
          {section === "chat" ? (
            <ChatSettingsTab />
          ) : section === "update" && __IS_TAURI__ ? (
            <div className="p-4">
              <UpdateIndicator />
            </div>
          ) : section === "guide" ? (
            <div className="p-4 space-y-4 text-sm text-foreground">
        <section>
          <h3 className="font-medium mb-1.5">{t("侧边栏")}</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{t("通过侧边栏顶部的纵向列表切换 Claude / Codex / Grok / Oh My Pi")}</li>
            <li>{t("在显示设置中选择侧栏显示哪些 Agent；工具与管理位于侧栏底部")}</li>
            <li>{t("项目列表点击进入对应项目的会话列表")}</li>
            <li>{t("快捷入口：全局搜索、使用统计、无效项管理、回收站")}</li>
          </ul>
        </section>
        <section>
          <h3 className="font-medium mb-1.5">{t("项目列表")}</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{t("标签 pill 可筛选项目")}</li>
            <li>{t("点击项目卡片进入会话列表")}</li>
          </ul>
        </section>
        <section>
          <h3 className="font-medium mb-1.5">{t("会话列表")}</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{t("点击卡片查看消息详情")}</li>
            <li>{t("卡片“操作”菜单提供收藏、标签编辑、续聊命令、导出和删除")}</li>
            <li>{t("会话页点“继续对话”展开输入框；“详情”中可打开终端或复制续聊命令")}</li>
            <li>{t("标签筛选快速定位会话")}</li>
          </ul>
        </section>
        <section>
          <h3 className="font-medium mb-1.5">{t("消息详情")}</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{t("向上滚动自动加载更早消息")}</li>
            <li>{t("顶栏“显示”菜单可切换时间戳 / 模型显示")}</li>
            <li>{t("右侧位置条标出每个提问，点击或拖动即可跳转")}</li>
          </ul>
        </section>
        <section>
          <h3 className="font-medium mb-1.5">{t("全局搜索")}</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{t("输入关键词跨项目搜索消息")}</li>
            <li>{t("标签筛选缩小搜索范围")}</li>
            <li>{t("点击结果直接跳转到对应消息")}</li>
          </ul>
        </section>
        <section>
          <h3 className="font-medium mb-1.5">{t("主题切换")}</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{t("侧栏底部按钮组切换亮色 / 暗色 / 跟随系统；设置入口也在侧栏底部")}</li>
          </ul>
        </section>
      </div>
          ) : section === "about" ? (
            <div className="p-4 space-y-3">
        <div className="flex items-center gap-2.5 text-sm text-foreground">
          <Users className="w-4 h-4 text-muted-foreground shrink-0" />
          <span>{t("作者：左岚")}</span>
        </div>
        <button
          onClick={() => openExternal("mailto:zuolan1102@qq.com")}
          className="flex items-center gap-2.5 text-sm text-foreground hover:text-accent-foreground transition-colors"
        >
          <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
          <span>zuolan1102@qq.com</span>
        </button>
        <div className="flex items-center gap-2.5 text-sm text-foreground">
          <svg className="w-4 h-4 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.395 15.035a39.548 39.548 0 0 0-1.51-3.302c-.18-.348-.478-.81-.478-.81s.09-.604.192-1.044c.118-.502.143-.878.143-1.37 0-2.737-1.94-5.057-4.96-5.057-1.063 0-2.044.291-2.893.812-.38-.133-.78-.232-1.198-.298a10.71 10.71 0 0 0-.93-.09c-.213-.01-.432-.013-.623-.002-.39.021-.72.068-.72.068s-.29-.012-.603.063c-.26.064-.505.15-.74.266A5.422 5.422 0 0 0 4.25 9.498c0 .608.106 1.178.3 1.698a8.38 8.38 0 0 0-.353.638c-.394.811-.64 1.727-.64 2.678 0 3.456 2.727 5.94 6.262 5.94.857 0 1.67-.14 2.42-.395.324.085.67.14 1.03.162.196.01.404.006.61-.008.37-.027.68-.071.68-.071s.25.021.54-.048c.244-.058.471-.137.692-.241a5.082 5.082 0 0 0 2.804-4.623c0-.493-.074-.961-.21-1.397.275-.376.524-.776.746-1.196zm-5.905 4.238c-.522.063-1.084-.129-1.084-.129s-.254.09-.558.127a3.282 3.282 0 0 1-.467.018 2.58 2.58 0 0 1-.519-.062c-.186-.049-.37-.12-.37-.12s-.478.136-.886.096c-1.863-.181-3.26-1.467-3.26-3.292 0-.375.07-.728.194-1.052.247-.634.72-1.168 1.343-1.518.703-.395 1.622-.584 2.732-.482.32.03.628.084.918.162.442-.285.957-.464 1.51-.502.062-.004.126-.005.189-.003.063.003.127.01.193.02 1.612.234 2.754 1.578 2.754 3.173 0 1.78-1.31 3.37-2.689 3.564z" />
          </svg>
          <span>{t("QQ 群：1019721429")}</span>
        </div>
        <button
          onClick={() => openExternal("https://space.bilibili.com/27619688")}
          className="flex items-center gap-2.5 text-sm text-foreground hover:text-accent-foreground transition-colors"
        >
          <svg className="w-4 h-4 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.787 1.893v7.44c.018.764.281 1.395.787 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.787-1.893v-7.44c-.018-.764-.281-1.395-.787-1.893a2.51 2.51 0 0 0-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z" />
          </svg>
          <span>{t("哔哩哔哩")}</span>
          <ExternalLink className="w-3 h-3 text-muted-foreground" />
        </button>
        <button
          onClick={() => openExternal("https://github.com/zuoliangyu/AI-Session-Viewer")}
          className="flex items-center gap-2.5 text-sm text-foreground hover:text-accent-foreground transition-colors"
        >
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <span>GitHub</span>
          <ExternalLink className="w-3 h-3 text-muted-foreground" />
        </button>
      </div>
          ) : (
            <DisplaySettingsTab hiddenSources={hiddenSources} onHiddenSourcesChange={(next) => { writeHiddenSources(next); }} />
          )}
        </section>
      </div>
    </div>
  );
}

function DisplaySettingsTab({ hiddenSources, onHiddenSourcesChange }: {
  hiddenSources: SessionSource[];
  onHiddenSourcesChange: (next: SessionSource[]) => void;
}) {
  const { t } = useTranslation();
  const timeZone = useAppStore((state) => state.timeZone);
  const setTimeZone = useAppStore((state) => state.setTimeZone);
  const systemTimeZone = useMemo(getSystemTimeZone, []);
  const timeZones = useMemo(getSupportedTimeZones, []);

  return (
    <div className="p-4 space-y-3 text-sm">
      <label className="block space-y-1.5 border-b border-border pb-4">
        <span className="font-medium text-foreground">{t("界面语言 / Language")}</span>
        <select
          value={getLanguage()}
          onChange={(event) => void setLanguage(event.target.value === "en" ? "en" : "zh-CN")}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground"
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
        <span className="block text-xs text-muted-foreground">{t("默认使用中文，语言选择会自动保存。")}</span>
      </label>
      <fieldset className="space-y-2 border-b border-border pb-4">
        <legend className="mb-2 font-medium">{t("侧栏显示的 Agent")}</legend>
        <p className="text-xs text-muted-foreground">{t("隐藏不常用的来源，至少保留一个。隐藏不会删除会话数据。")}</p>
        {SOURCE_OPTIONS.map((option) => <label key={option.id} className="flex items-center justify-between gap-3 rounded px-1 py-1">
          <span>{option.label}</span>
          <input type="checkbox" className="accent-primary" checked={!hiddenSources.includes(option.id)} disabled={!hiddenSources.includes(option.id) && hiddenSources.length === SOURCE_OPTIONS.length - 1} onChange={(event) => onHiddenSourcesChange(event.target.checked ? hiddenSources.filter((id) => id !== option.id) : [...hiddenSources, option.id])} />
        </label>)}
      </fieldset>
      <label className="block space-y-1.5">
        <span className="font-medium text-foreground">{t("时区")}</span>
        <select
          value={timeZone}
          onChange={(event) => setTimeZone(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground"
        >
          <option value="">{t("跟随系统（{{zone}}）", { zone: systemTimeZone })}</option>
          {timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <div className="text-xs text-muted-foreground">
        {t("当前时间：")}{formatDateTime(new Date(), timeZone)}
      </div>
    </div>
  );
}

function ProviderModelManager({ source }: { source: "claude" | "codex" }) {
  const { t } = useTranslation();
  const {
    addCustomModel,
    removeCustomModel,
    claudeApiKeyOverride,
    claudeBaseUrlOverride,
    codexApiKeyOverride,
    codexBaseUrlOverride,
  } = useChatStore(
    useShallow((state) => ({ addCustomModel: state.addCustomModel, removeCustomModel: state.removeCustomModel, claudeApiKeyOverride: state.claudeApiKeyOverride, claudeBaseUrlOverride: state.claudeBaseUrlOverride, codexApiKeyOverride: state.codexApiKeyOverride, codexBaseUrlOverride: state.codexBaseUrlOverride })),
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);
  const [newModelIds, setNewModelIds] = useState("");
  const [addedCount, setAddedCount] = useState<number | null>(null);

  const apiKey = source === "codex" ? codexApiKeyOverride : claudeApiKeyOverride;
  const baseUrl = source === "codex" ? codexBaseUrlOverride : claudeBaseUrlOverride;

  // Custom model IDs for this source (re-read whenever models change)
  const customModelIds = useMemo(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(`chat_customModels_${source}`) || "[]"));
    } catch {
      return new Set<string>();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, source]);

  const loadModels = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listModels(source, apiKey, baseUrl);
      // Prepend persisted custom models not already in result
      const customKey = `chat_customModels_${source}`;
      const customIds: string[] = JSON.parse(localStorage.getItem(customKey) || "[]");
      const resultIds = new Set(result.map((m) => m.id));
      const provider = source === "codex" ? "openai" : "anthropic";
      const extras: ModelInfo[] = customIds
        .filter((id) => !resultIds.has(id))
        .map((id) => ({ id, name: id, provider, group: t("自定义"), created: null }));
      setModels([...extras, ...result]);
      setFetched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFetched(true);
    } finally {
      setLoading(false);
    }
  };

  const parseModelIds = (input: string): string[] =>
    input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

  const handleBatchAdd = () => {
    const ids = parseModelIds(newModelIds);
    if (ids.length === 0) return;
    let count = 0;
    const provider = source === "codex" ? "openai" : "anthropic";
    for (const id of ids) {
      if (!models.some((m) => m.id === id)) {
        addCustomModel(id, source);
        setModels((prev) => [{ id, name: id, provider, group: t("自定义"), created: null }, ...prev]);
        count++;
      }
    }
    setAddedCount(count);
    setNewModelIds("");
    setShowAddInput(false);
    setTimeout(() => setAddedCount(null), 2000);
  };

  const handleRemove = (id: string) => {
    removeCustomModel(id, source);
    setModels((prev) => prev.filter((m) => m.id !== id));
  };

  const parsedCount = parseModelIds(newModelIds).length;

  const grouped = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of models) {
      if (!groups[m.group]) groups[m.group] = [];
      groups[m.group].push(m);
    }
    return groups;
  }, [models]);

  return (
    <div className="mt-3 space-y-2">
      {/* Action row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={loadModels}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-muted text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          {fetched ? t("刷新模型列表") : t("获取模型列表")}
        </button>
        <button
          onClick={() => { setShowAddInput((v) => !v); setAddedCount(null); }}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
            showAddInput
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-muted text-foreground hover:bg-accent/50"
          }`}
        >
          <Plus className="w-3 h-3" />
          {t("手动添加")}</button>
        {fetched && !loading && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {models.length} {t("个模型")}{customModelIds.size > 0 && t("（{{v0}} 个自定义）", { v0: customModelIds.size })}
          </span>
        )}
      </div>

      {/* Added toast */}
      {addedCount !== null && (
        <div className="flex items-center gap-1 text-xs text-success">
          <Check className="w-3 h-3" />
          {t("已添加{{v0}} 个自定义模型", { v0: addedCount })}</div>
      )}

      {/* Batch add textarea */}
      {showAddInput && (
        <div className="space-y-1.5">
          <textarea
            value={newModelIds}
            onChange={(e) => setNewModelIds(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); handleBatchAdd(); }
              if (e.key === "Escape") { e.preventDefault(); setShowAddInput(false); }
            }}
            placeholder={
              source === "codex"
                ? t("每行一个模型 ID，例如：\no4-mini\ngpt-4.1\ncustom-model-id")
                : t("每行一个模型 ID，例如：\nclaude-sonnet-4-20250514\nclaude-opus-4-20250514")
            }
            rows={4}
            className="w-full bg-muted border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            autoFocus
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {parsedCount > 0 ? t("识别到 {{v0}} 个 ID", { v0: parsedCount }) : t("每行一个或逗号分隔")}
            </span>
            <button
              onClick={handleBatchAdd}
              disabled={parsedCount === 0}
              className="px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {t("添加")}{parsedCount > 0 ? `（${parsedCount}）` : ""}
            </button>
          </div>
        </div>
      )}

      {/* Status */}
      {loading && (
        <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          {t("正在获取...")}</div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 py-1 text-xs text-destructive">
          <AlertCircle className="w-3 h-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}
      {fetched && !loading && models.length === 0 && !error && (
        <p className="text-xs text-muted-foreground py-1">
          {t("未获取到模型。")}{!apiKey && t("请先配置 API Key 或手动输入覆盖值。")}
        </p>
      )}

      {/* Model list */}
      {fetched && !loading && models.length > 0 && (
        <div className="border border-border rounded overflow-hidden max-h-52 overflow-y-auto">
          {Object.entries(grouped).map(([group, grpModels]) => (
            <div key={group}>
              <div className="px-2 py-0.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/60 sticky top-0">
                {group}
                <span className="ml-1 font-normal opacity-60">({grpModels.length})</span>
              </div>
              {grpModels.map((m) => {
                const isCustom = customModelIds.has(m.id);
                return (
                  <div
                    key={m.id}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-accent/30 transition-colors group"
                  >
                    <span className="truncate flex-1 text-foreground" title={m.id}>{m.name}</span>
                    {m.id !== m.name && (
                      <span className="text-[10px] text-muted-foreground/70 truncate max-w-[9rem] font-mono">{m.id}</span>
                    )}
                    {isCustom ? (
                      <button
                        onClick={() => handleRemove(m.id)}
                        className="p-0.5 rounded text-transparent group-hover:text-muted-foreground hover:!text-destructive transition-colors shrink-0"
                        title={t("移除自定义模型")}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CliConfigInfo({
  config,
  loading,
  error,
  onFetch,
}: {
  config: import("../../types/chat").CliConfig | null;
  loading: boolean;
  error: string | null;
  onFetch: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t("检测中...")}</div>
    );
  }
  if (error) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
        <button onClick={onFetch} className="text-xs text-primary hover:text-primary/80">{t("重试")}</button>
      </div>
    );
  }
  if (!config) {
    return <button onClick={onFetch} className="text-xs text-primary hover:text-primary/80">{t("检测配置")}</button>;
  }

  const isCodex = config.source === "codex";

  return (
    <div className="space-y-2 text-xs">
      {isCodex ? (
        // ── Codex: show both files separately ──
        <>
          {/* auth.json */}
          <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
              <span>auth.json</span>
              <span className="font-normal opacity-60 truncate">{config.authJsonPath}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.authJsonHasKey ? "bg-green-500" : "bg-yellow-500"}`} />
              <span className="text-muted-foreground">API Key:</span>
              <span className="font-mono text-foreground">
                {config.authJsonHasKey ? config.authJsonKeyMasked : t("未找到")}
              </span>
              {config.authJsonHasKey && config.apiKeySource === "auth.json" && (
                <span className="ml-auto text-[10px] text-success">{t("✓ 使用中")}</span>
              )}
            </div>
          </div>

          {/* config.toml */}
          <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
              <span>config.toml</span>
              <span className="font-normal opacity-60 truncate">{config.configPath}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.configTomlUrl ? "bg-green-500" : "bg-yellow-500"}`} />
              <span className="text-muted-foreground">Base URL:</span>
              <span className="font-mono text-foreground truncate">
                {config.configTomlUrl || t("未找到（将用默认值）")}
              </span>
              {config.configTomlUrl && config.baseUrlSource === "config.toml" && (
                <span className="ml-auto shrink-0 text-[10px] text-success">{t("✓ 使用中")}</span>
              )}
            </div>
            {config.configTomlHasKey && (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-blue-400" />
                <span className="text-muted-foreground">API Key:</span>
                <span className="font-mono text-foreground">{config.configTomlKeyMasked}</span>
                {config.apiKeySource === "config.toml" && (
                  <span className="ml-auto text-[10px] text-success">{t("✓ 使用中")}</span>
                )}
              </div>
            )}
            {config.defaultModel && (
              <div className="flex items-center gap-2">
                <span className="w-1.5 shrink-0" />
                <span className="text-muted-foreground">{t("默认模型:")}</span>
                <span className="font-mono text-foreground">{config.defaultModel}</span>
              </div>
            )}
          </div>

          {/* Resolved summary */}
          {!config.hasApiKey && (
            <p className="text-[11px] text-warning">
              {t("未找到 API Key，请在 auth.json 中配置或在下方手动填入。")}</p>
          )}
          {config.baseUrlSource === "default" && (
            <p className="text-[11px] text-muted-foreground">
              {t("Base URL 使用默认值：")}{config.baseUrl}
            </p>
          )}
        </>
      ) : (
        // ── Claude: simple display ──
        <>
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${config.hasApiKey ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-muted-foreground">API Key:</span>
            <span className="font-mono text-foreground">{config.hasApiKey ? config.apiKeyMasked : t("未配置")}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="ml-3.5 text-muted-foreground">Base URL:</span>
            <span className="font-mono text-foreground truncate">{config.baseUrl}</span>
          </div>
          {config.defaultModel && (
            <div className="flex items-center gap-2">
              <span className="ml-3.5 text-muted-foreground">{t("默认模型:")}</span>
              <span className="font-mono text-foreground">{config.defaultModel}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="ml-3.5 text-muted-foreground">{t("配置文件:")}</span>
            <span className="text-foreground/60 font-mono truncate text-[10px]">{config.configPath}</span>
          </div>
        </>
      )}

      <button onClick={onFetch} className="text-xs text-primary hover:text-primary/80">
        {t("重新检测")}</button>
    </div>
  );
}

function CliConfigDisplay() {
  useTranslation();
  const { cliConfig, cliConfigLoading, cliConfigError, fetchCliConfig } = useChatStore(
    useShallow((state) => ({ cliConfig: state.cliConfig, cliConfigLoading: state.cliConfigLoading, cliConfigError: state.cliConfigError, fetchCliConfig: state.fetchCliConfig })),
  );
  const [fetched, setFetched] = useState(false);
  const handleFetch = async () => { await fetchCliConfig(); setFetched(true); };
  useEffect(() => { if (!fetched) handleFetch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <CliConfigInfo config={cliConfig} loading={cliConfigLoading} error={cliConfigError} onFetch={handleFetch} />;
}

function CodexCliConfigDisplay() {
  useTranslation();
  const { codexCliConfig, codexCliConfigLoading, codexCliConfigError, fetchCodexCliConfig } = useChatStore(
    useShallow((state) => ({ codexCliConfig: state.codexCliConfig, codexCliConfigLoading: state.codexCliConfigLoading, codexCliConfigError: state.codexCliConfigError, fetchCodexCliConfig: state.fetchCodexCliConfig })),
  );
  const [fetched, setFetched] = useState(false);
  const handleFetch = async () => { await fetchCodexCliConfig(); setFetched(true); };
  useEffect(() => { if (!fetched) handleFetch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <CliConfigInfo config={codexCliConfig} loading={codexCliConfigLoading} error={codexCliConfigError} onFetch={handleFetch} />;
}

type InstallMethod = "npm" | "nvm" | "bun" | "other";

const INSTALL_HINTS: Record<InstallMethod, { label: string; paths: string[]; tip: string }> = {
  npm: {
    get label() { return t("npm 全局安装"); },
    get paths() { return [
      "Windows: %APPDATA%\\npm\\claude.cmd",
      t("Mac/Linux: ~/.npm-global/bin/claude 或 /usr/local/bin/claude"),
    ]; },
    get tip() { return t("在终端运行 `npm list -g @anthropic-ai/claude-code` 确认安装，再用 `which claude`（Mac/Linux）或 `where claude`（Windows）获取实际路径，填入下方「CLI 路径」"); },
  },
  nvm: {
    label: "nvm (all platforms)",
    paths: [
      "Mac/Linux: ~/.nvm/versions/node/{version}/bin/claude",
      "Windows (nvm-windows): %APPDATA%\\nvm\\{version}\\claude.cmd",
    ],
    get tip() { return t("由于桌面应用不继承 shell 的 nvm PATH，自动检测可能失败。请在终端执行 `nvm use` 激活版本后运行 `which claude`（Mac/Linux）或 `where claude`（Windows），将完整路径填入下方「CLI 路径」"); },
  },
  bun: {
    get label() { return t("bun 全局安装"); },
    paths: [
      "Mac/Linux: ~/.bun/bin/claude",
      "Windows: %USERPROFILE%\\.bun\\bin\\claude.exe",
    ],
    get tip() { return t("在终端运行 `bun pm ls -g` 确认安装，再将 `~/.bun/bin/claude` 填入下方「CLI 路径」"); },
  },
  other: {
    get label() { return t("手动 / 其他"); },
    get paths() { return [t("自定义路径")]; },
    get tip() { return t("在终端运行 `which claude`（Mac/Linux）或 `where claude`（Windows）获取路径，填入下方「CLI 路径」"); },
  },
};

function CopyCommandLine({ cmd }: { cmd: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 bg-muted/60 rounded px-2 py-1">
      <code className="flex-1 text-[11px] font-mono text-foreground select-all">{cmd}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title={t("复制")}
      >
        {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function ChatSettingsTab() {
  const { t } = useTranslation();
  const { terminalShell, setTerminalShell } = useAppStore(
    useShallow((state) => ({ terminalShell: state.terminalShell, setTerminalShell: state.setTerminalShell })),
  );
  const {
    skipPermissions,
    setSkipPermissions,
    defaultModel,
    setDefaultModel,
    cliPath,
    setCliPath,
    availableClis,
    detectCli,
    claudeApiKeyOverride,
    claudeBaseUrlOverride,
    codexApiKeyOverride,
    codexBaseUrlOverride,
    setClaudeApiKeyOverride,
    setClaudeBaseUrlOverride,
    setCodexApiKeyOverride,
    setCodexBaseUrlOverride,
  } = useChatStore(
    useShallow((state) => ({ skipPermissions: state.skipPermissions, setSkipPermissions: state.setSkipPermissions, defaultModel: state.defaultModel, setDefaultModel: state.setDefaultModel, cliPath: state.cliPath, setCliPath: state.setCliPath, availableClis: state.availableClis, detectCli: state.detectCli, claudeApiKeyOverride: state.claudeApiKeyOverride, claudeBaseUrlOverride: state.claudeBaseUrlOverride, codexApiKeyOverride: state.codexApiKeyOverride, codexBaseUrlOverride: state.codexBaseUrlOverride, setClaudeApiKeyOverride: state.setClaudeApiKeyOverride, setClaudeBaseUrlOverride: state.setClaudeBaseUrlOverride, setCodexApiKeyOverride: state.setCodexApiKeyOverride, setCodexBaseUrlOverride: state.setCodexBaseUrlOverride })),
  );

  const isWindows = __IS_TAURI__ && navigator.platform.startsWith("Win");
  const [installMethod, setInstallMethod] = useState<InstallMethod>(
    () => (localStorage.getItem("chat_installMethod") as InstallMethod) || "npm"
  );
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);

  const handleDetect = async () => {
    setDetecting(true);
    await detectCli();
    setDetecting(false);
    setDetected(true);
  };

  const handleMethodChange = (m: InstallMethod) => {
    setInstallMethod(m);
    localStorage.setItem("chat_installMethod", m);
    setDetected(false);
  };

  const hint = INSTALL_HINTS[installMethod];
  const claudeNotFound = detected && !availableClis.some((c) => c.cliType === "claude");
  const codexNotFound = detected && !availableClis.some((c) => c.cliType === "codex");

  return (
    <div className="p-4 space-y-4 text-sm">
      <section>
        <h3 className="font-medium mb-2 text-foreground">{t("CLI 状态")}</h3>
        <div className="space-y-2">
          {availableClis.length > 0 ? (
            availableClis.map((cli, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full shrink-0" />
                <span className="capitalize font-medium">{cli.cliType}</span>
                {cli.version && <span>{cli.version}</span>}
                <span className="truncate text-muted-foreground/60">
                  {cli.path}
                </span>
              </div>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">{t("未检测到已安装的 CLI")}</p>
          )}

          {/* 安装方式选择 */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">{t("安装方式")}</p>
            <div className="flex flex-wrap gap-1">
              {(["npm", "nvm", "bun", "other"] as InstallMethod[]).map((m) => (
                <button
                  key={m}
                  onClick={() => handleMethodChange(m)}
                  className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                    installMethod === m
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                  }`}
                >
                  {INSTALL_HINTS[m].label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleDetect}
            disabled={detecting}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${detecting ? "animate-spin" : ""}`} />
            {detecting ? t("检测中...") : t("重新检测")}
          </button>

          {/* Claude 检测失败提示 */}
          {claudeNotFound && (
            <div className="rounded-md bg-warning/10 border border-warning/30 p-2.5 space-y-1.5">
              <p className="text-xs font-medium text-warning">
                {t("未找到 Claude CLI")}</p>
              <p className="text-[11px] text-muted-foreground">{t("通过 npm 安装：")}</p>
              <CopyCommandLine cmd="npm install -g @anthropic-ai/claude-code" />
              <ul className="space-y-0.5 mt-1">
                {hint.paths.map((p, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground font-mono">{p}</li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{hint.tip}</p>
            </div>
          )}

          {/* Codex 检测失败提示 */}
          {codexNotFound && (
            <div className="rounded-md bg-info/10 border border-info/30 p-2.5 space-y-1.5">
              <p className="text-xs font-medium text-info">
                {t("未找到 Codex CLI（可选）")}</p>
              <p className="text-[11px] text-muted-foreground">{t("通过 npm 安装：")}</p>
              <CopyCommandLine cmd="npm install -g @openai/codex" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("安装后点击「重新检测」。若使用 nvm，需先")}<code className="font-mono">nvm use</code> {t("激活对应版本。")}</p>
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="font-medium mb-2 text-foreground">{t("CLI 路径")}</h3>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={cliPath}
            onChange={(e) => setCliPath(e.target.value)}
            placeholder={
              navigator.platform.startsWith("Win")
                ? "C:\\Users\\<user>\\.bun\\bin\\claude.exe"
                : "/usr/local/bin/claude"
            }
            className="flex-1 bg-muted border border-border rounded px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          {__IS_TAURI__ && (
            <button
              onClick={async () => {
                const selected = await openFileDialog({ multiple: false, directory: false });
                if (typeof selected === "string") setCliPath(selected);
              }}
              className="shrink-0 px-2.5 py-1.5 text-xs bg-muted border border-border rounded hover:bg-accent transition-colors"
              title={t("浏览文件")}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("留空则自动检测。如自动检测失败，请手动指定 Claude CLI 可执行文件路径")}</p>
      </section>

      <section>
        <h3 className="font-medium mb-2 text-foreground">{t("默认模型")}</h3>
        <input
          type="text"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder={t("留空使用 CLI 配置中的默认模型")}
          className="w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t("新建对话时使用的默认模型（优先于 CLI 配置）")}</p>
      </section>

      {/* Anthropic (Claude) */}
      <section>
        <h3 className="font-medium mb-2 text-foreground">Anthropic (Claude)</h3>
        <CliConfigDisplay />
        <div className="mt-3 space-y-2">
          <div>
            <label className="text-xs text-muted-foreground">{t("手动 API Key（覆盖自动检测）")}</label>
            <input
              type="password"
              value={claudeApiKeyOverride}
              onChange={(e) => setClaudeApiKeyOverride(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-1 w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t("手动 Base URL（覆盖自动检测）")}</label>
            <input
              type="text"
              value={claudeBaseUrlOverride}
              onChange={(e) => setClaudeBaseUrlOverride(e.target.value)}
              placeholder="https://api.anthropic.com"
              className="mt-1 w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
        <ProviderModelManager source="claude" />
      </section>

      {/* OpenAI (Codex) */}
      <section>
        <h3 className="font-medium mb-2 text-foreground">OpenAI (Codex)</h3>
        <CodexCliConfigDisplay />
        <div className="mt-3 space-y-2">
          <div>
            <label className="text-xs text-muted-foreground">{t("手动 API Key（覆盖自动检测）")}</label>
            <input
              type="password"
              value={codexApiKeyOverride}
              onChange={(e) => setCodexApiKeyOverride(e.target.value)}
              placeholder="sk-..."
              className="mt-1 w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t("手动 Base URL（覆盖自动检测）")}</label>
            <input
              type="text"
              value={codexBaseUrlOverride}
              onChange={(e) => setCodexBaseUrlOverride(e.target.value)}
              placeholder="https://api.openai.com"
              className="mt-1 w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
        <ProviderModelManager source="codex" />
      </section>

      {isWindows && (
        <section>
          <h3 className="font-medium mb-2 text-foreground">{t("终端类型")}</h3>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="terminalShell"
                value="cmd"
                checked={terminalShell === "cmd"}
                onChange={() => setTerminalShell("cmd")}
                className="rounded-full border-border"
              />
              <span className="text-xs text-foreground">CMD</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="terminalShell"
                value="powershell"
                checked={terminalShell === "powershell"}
                onChange={() => setTerminalShell("powershell")}
                className="rounded-full border-border"
              />
              <span className="text-xs text-foreground">PowerShell</span>
            </label>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("恢复会话时使用的终端类型")}</p>
        </section>
      )}

      <section>
        <h3 className="font-medium mb-2 text-foreground">{t("权限模式")}</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={skipPermissions}
            onChange={(e) => setSkipPermissions(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-xs text-foreground">
            {t("跳过权限确认 (--dangerously-skip-permissions)")}</span>
        </label>
        <p className="mt-1 text-xs text-warning">
          {skipPermissions
            ? t("警告：CLI 将自动执行所有工具操作而不请求确认")
            : t("CLI 会在执行文件修改等操作前请求确认")}
        </p>
      </section>
    </div>
  );
}

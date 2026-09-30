import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Check,
  Loader2,
  Plug,
  RefreshCw,
  X,
} from "lucide-react";
import {
  applyNodeMcpServer,
  getNodeConfigManifest,
  getSkillSyncNodes,
  type ConfigSyncManifest,
  type McpServerManifest,
  type PluginManifestItem,
} from "../../services/skillSync";
import { EscapeToClose } from "../common/EscapeToClose";

type Tab = "mcp" | "plugins";

const EMPTY_MANIFEST: ConfigSyncManifest = { mcpServers: [], plugins: [] };

const mcpKey = (item: McpServerManifest) => `${item.client}:${item.name}`;
const pluginKey = (item: PluginManifestItem) =>
  `${item.client}:${item.kind}:${item.name}`;
const sameMcp = (left: McpServerManifest, right?: McpServerManifest) =>
  !!right && JSON.stringify(left.config) === JSON.stringify(right.config);

export function ConfigSyncDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const nodes = useMemo(getSkillSyncNodes, [t]);
  const [tab, setTab] = useState<Tab>("mcp");
  const [sourceId, setSourceId] = useState(nodes[0]?.id ?? "");
  const [targetId, setTargetId] = useState(nodes[1]?.id ?? "");
  const [sourceManifest, setSourceManifest] =
    useState<ConfigSyncManifest>(EMPTY_MANIFEST);
  const [targetManifest, setTargetManifest] =
    useState<ConfigSyncManifest>(EMPTY_MANIFEST);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  const targetMcp = useMemo(
    () => new Map(targetManifest.mcpServers.map((item) => [mcpKey(item), item])),
    [targetManifest],
  );
  const targetPlugins = useMemo(
    () => new Map(targetManifest.plugins.map((item) => [pluginKey(item), item])),
    [targetManifest],
  );

  const loadPreview = async () => {
    if (!source || !target || source.id === target.id) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const [sourceData, targetData] = await Promise.all([
        getNodeConfigManifest(source),
        getNodeConfigManifest(target),
      ]);
      const targetByKey = new Map(
        targetData.mcpServers.map((item) => [mcpKey(item), item]),
      );
      setSourceManifest(sourceData);
      setTargetManifest(targetData);
      setSelected(
        new Set(
          sourceData.mcpServers
            .filter((item) => !targetByKey.has(mcpKey(item)))
            .map(mcpKey),
        ),
      );
    } catch (cause) {
      setSourceManifest(EMPTY_MANIFEST);
      setTargetManifest(EMPTY_MANIFEST);
      setSelected(new Set());
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPreview();
  }, [sourceId, targetId]);

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    const allowed = sourceManifest.mcpServers
      .filter((item) => {
        const targetItem = targetMcp.get(mcpKey(item));
        return !sameMcp(item, targetItem) && (overwrite || !targetItem);
      })
      .map(mcpKey);
    setSelected(selected.size === allowed.length ? new Set() : new Set(allowed));
  };

  const syncMcp = async () => {
    if (!target) return;
    const servers = sourceManifest.mcpServers.filter((item) => {
      const targetItem = targetMcp.get(mcpKey(item));
      return (
        selected.has(mcpKey(item)) &&
        !sameMcp(item, targetItem) &&
        (overwrite || !targetItem)
      );
    });
    if (servers.length === 0) return;

    setSyncing(true);
    setError(null);
    setResult(null);
    let completed = 0;
    try {
      for (const server of servers) {
        const targetItem = targetMcp.get(mcpKey(server));
        await applyNodeMcpServer(
          target,
          server,
          targetItem?.hash ?? "missing",
          overwrite,
        );
        completed += 1;
      }
      await loadPreview();
      setResult(t("已同步 {{v0}} 个 MCP 声明", { v0: completed }));
    } catch (cause) {
      setError(
        `${completed > 0 ? t("已完成 {{v0}} 个；", { v0: completed }) : ""}${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <EscapeToClose onClose={onClose} />
      <div
        className="flex max-h-[85vh] w-[48rem] max-w-full flex-col rounded-lg border border-border bg-card shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("MCP / 插件跨机同步")}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("关闭")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {nodes.length < 2 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {t("至少需要两个可访问的 session-web 节点。")}</div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border p-4">
              <select
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-2 text-sm"
                title={t("源机器")}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={node.id === targetId}>
                    {node.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setSourceId(targetId);
                  setTargetId(sourceId);
                }}
                className="rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("交换源机器和目标机器")}
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              <select
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-2 text-sm"
                title={t("目标机器")}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={node.id === sourceId}>
                    {node.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void loadPreview()}
                disabled={loading || syncing}
                className="rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                title={t("刷新预览")}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>

            <div className="flex border-b border-border">
              {(["mcp", "plugins"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setTab(value)}
                  className={`flex-1 px-4 py-2 text-sm font-medium ${
                    tab === value
                      ? "border-b-2 border-foreground text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {value === "mcp" ? "MCP" : t("插件声明")}
                </button>
              ))}
            </div>

            {tab === "mcp" && (
              <div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs">
                <button
                  onClick={selectAll}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t("全选 / 取消全选")}</button>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setOverwrite(checked);
                      if (!checked) {
                        setSelected(
                          (current) =>
                            new Set(
                              [...current].filter(
                                (key) => !targetMcp.has(key),
                              ),
                            ),
                        );
                      }
                    }}
                  />
                  {t("覆盖同名声明（自动备份）")}</label>
              </div>
            )}

            <div className="min-h-0 flex-1 divide-y divide-border overflow-auto">
              {loading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("正在生成差异预览...")}</div>
              ) : tab === "mcp" ? (
                sourceManifest.mcpServers.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground">
                    {t("源机器没有 MCP 声明。")}</div>
                ) : (
                  sourceManifest.mcpServers.map((item) => {
                    const key = mcpKey(item);
                    const targetItem = targetMcp.get(key);
                    const same = sameMcp(item, targetItem);
                    const disabled = same || (!!targetItem && !overwrite);
                    return (
                      <div key={key} className={disabled ? "opacity-60" : ""}>
                        <label className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            disabled={disabled || syncing}
                            onChange={() => toggle(key)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{item.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {item.client === "claude" ? "Claude" : "Codex"}
                              {item.redactedFields.length > 0 &&
                                t(" · 需在目标机补充 {{v0}} 项敏感或机器相关值", { v0: item.redactedFields.length })}
                            </div>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {same
                              ? t("相同")
                              : targetItem
                                ? overwrite
                                  ? t("覆盖")
                                  : t("冲突")
                                : t("新增")}
                          </span>
                        </label>
                        <details className="px-11 pb-3 text-xs">
                          <summary className="cursor-pointer text-muted-foreground">
                            {t("查看脱敏配置")}</summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono">
                            {JSON.stringify(item.config, null, 2)}
                          </pre>
                        </details>
                      </div>
                    );
                  })
                )
              ) : sourceManifest.plugins.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  {t("源机器没有插件安装声明。")}</div>
              ) : (
                sourceManifest.plugins.map((item) => {
                  const targetItem = targetPlugins.get(pluginKey(item));
                  const sameDeclaration =
                    targetItem?.version === item.version &&
                    targetItem?.source === item.source;
                  return (
                    <div
                      key={pluginKey(item)}
                      className="flex items-center gap-3 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{item.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {item.client === "claude" ? "Claude" : "Codex"} · {item.kind}
                          {item.version && ` · ${item.version}`}
                          {item.source && ` · ${item.source}`}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {!targetItem
                          ? t("目标缺少")
                          : sameDeclaration
                            ? t("已存在")
                            : t("声明不同")}
                      </span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                        {t("仅预览")}</span>
                    </div>
                  );
                })
              )}
            </div>

            {(error || result) && (
              <div
                className={`border-t border-border px-4 py-3 text-xs ${
                  error ? "text-destructive" : "text-green-500"
                }`}
              >
                {error ?? result}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-border p-4">
              <button
                onClick={onClose}
                disabled={syncing}
                className="rounded border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
              >
                {t("关闭")}</button>
              {tab === "mcp" && (
                <button
                  onClick={() => void syncMcp()}
                  disabled={syncing || loading || selected.size === 0}
                  className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {syncing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {t("开始同步")}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

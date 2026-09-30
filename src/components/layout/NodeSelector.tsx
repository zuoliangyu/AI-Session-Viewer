import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  Server,
  Settings2,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  getActiveNodeId,
  getViewerNodes,
  LOCAL_NODE_ID,
  probeViewerNode,
  removeViewerNode,
  saveViewerNode,
  setActiveNodeId,
  type NodeStatus,
  type ViewerNode,
} from "../../services/nodeConfig";
import { EscapeToClose } from "../common/EscapeToClose";

declare const __IS_TAURI__: boolean;

const EMPTY_FORM = { name: "", baseUrl: "", token: "" };

export function NodeSelector() {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState(getViewerNodes);
  const [activeId, setActiveId] = useState(getActiveNodeId);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const activeStatus = activeId === LOCAL_NODE_ID ? "online" : statuses[activeId];

  const probe = async (node: ViewerNode) => {
    setStatuses((current) => ({ ...current, [node.id]: "checking" }));
    const status = await probeViewerNode(node);
    setStatuses((current) => ({ ...current, [node.id]: status }));
  };

  useEffect(() => {
    const refresh = () => {
      setNodes(getViewerNodes());
      setActiveId(getActiveNodeId());
    };
    window.addEventListener("asv-node-config-changed", refresh);
    return () => window.removeEventListener("asv-node-config-changed", refresh);
  }, []);

  useEffect(() => {
    const active = nodes.find((node) => node.id === activeId);
    if (!active) return;
    void probe(active);
    const timer = window.setInterval(() => void probe(active), 30_000);
    return () => window.clearInterval(timer);
  }, [activeId, nodes]);

  useEffect(() => {
    if (!open) return;
    for (const node of nodes) void probe(node);
  }, [open]);

  const switchNode = (id: string) => {
    if (id === activeId) return;
    setActiveNodeId(id);
    setActiveId(id);
    window.history.replaceState(null, "", "/projects");
    window.location.reload();
  };

  const startEdit = (node?: ViewerNode) => {
    setEditingId(node?.id ?? null);
    setForm(
      node
        ? { name: node.name, baseUrl: node.baseUrl, token: node.token }
        : EMPTY_FORM,
    );
    setError(null);
  };

  const save = () => {
    try {
      const node = saveViewerNode({ id: editingId ?? undefined, ...form });
      const next = getViewerNodes();
      setNodes(next);
      setEditingId(null);
      setForm(EMPTY_FORM);
      setError(null);
      void probe(node);
      if (node.id === activeId) window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = (node: ViewerNode) => {
    if (!window.confirm(t("确定删除机器“{{v0}}”吗？", { v0: node.name }))) return;
    const wasActive = node.id === activeId;
    removeViewerNode(node.id);
    setNodes(getViewerNodes());
    if (wasActive) {
      window.history.replaceState(null, "", "/projects");
      window.location.reload();
    }
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            activeStatus === "online"
              ? "bg-green-500"
              : activeStatus === "checking"
                ? "bg-yellow-500"
                : activeStatus
                  ? "bg-red-500"
                  : "bg-muted-foreground"
          }`}
          title={
            activeStatus === "online"
              ? t("机器在线")
              : activeStatus === "unauthorized"
                ? t("访问令牌无效")
                : activeStatus === "checking"
                  ? t("正在检查连接")
                  : activeStatus
                    ? t("机器离线")
                    : t("尚未检查连接")
          }
        />
        <select
          value={activeId}
          onChange={(event) => switchNode(event.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-card px-1 text-xs text-foreground"
          aria-label={t("当前机器")}
          title={t("当前机器")}
        >
          <option value={LOCAL_NODE_ID}>
            {__IS_TAURI__ ? t("本机") : t("当前服务器")}
          </option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setOpen(true)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("管理机器")}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <EscapeToClose onClose={() => setOpen(false)} />
          <div
            className="w-[36rem] max-w-full max-h-[85vh] overflow-auto rounded-lg border border-border bg-card shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{t("机器管理")}</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("关闭")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="divide-y divide-border">
              {nodes.map((node) => {
                const status = statuses[node.id];
                return (
                  <div key={node.id} className="flex items-center gap-3 px-4 py-3">
                    {status === "checking" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : status === "online" ? (
                      <Wifi className="h-4 w-4 text-green-500" />
                    ) : status ? (
                      <WifiOff className="h-4 w-4 text-red-500" />
                    ) : (
                      <Server className="h-4 w-4 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{node.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {node.baseUrl}
                      </div>
                    </div>
                    <button
                      onClick={() => void probe(node)}
                      className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t("测试连接")}
                    >
                      <Wifi className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => startEdit(node)}
                      className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t("编辑机器")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => remove(node)}
                      className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                      title={t("删除机器")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="space-y-3 border-t border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  {editingId ? t("编辑机器") : t("添加机器")}
                </h3>
                {editingId && (
                  <button
                    onClick={() => startEdit()}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("添加机器")}</button>
                )}
              </div>
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder={t("机器名称")}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="https://viewer.example.com"
                inputMode="url"
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono"
              />
              <input
                type="password"
                autoComplete="off"
                value={form.token}
                onChange={(event) => setForm({ ...form, token: event.target.value })}
                placeholder={t("Bearer Token（可选）")}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex justify-end">
                <button
                  onClick={save}
                  className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
                >
                  <Check className="h-3.5 w-3.5" />
                  {t("保存")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

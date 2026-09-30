import { t } from "../i18n/index.js";
export const LOCAL_NODE_ID = "local";

const NODES_KEY = "asv_nodes_v1";
const ACTIVE_NODE_KEY = "asv_active_node";

export interface ViewerNode {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
}

export type NodeStatus = "checking" | "online" | "offline" | "unauthorized";

export function normalizeNodeUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(t("节点地址必须使用 http:// 或 https://"));
  }
  if (url.username || url.password) {
    throw new Error(t("节点地址不能包含用户名或密码"));
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(t("节点地址只能填写服务器根地址"));
  }
  return url.origin;
}

export function getViewerNodes(): ViewerNode[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NODES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (node): node is ViewerNode =>
        typeof node?.id === "string" &&
        typeof node?.name === "string" &&
        typeof node?.baseUrl === "string" &&
        typeof node?.token === "string",
    );
  } catch {
    return [];
  }
}

function writeViewerNodes(nodes: ViewerNode[]): void {
  localStorage.setItem(NODES_KEY, JSON.stringify(nodes));
  window.dispatchEvent(new CustomEvent("asv-node-config-changed"));
}

export function saveViewerNode(
  value: Omit<ViewerNode, "id"> & { id?: string },
): ViewerNode {
  const nodes = getViewerNodes();
  const node: ViewerNode = {
    id:
      value.id ||
      crypto.randomUUID?.() ||
      `node-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: value.name.trim(),
    baseUrl: normalizeNodeUrl(value.baseUrl),
    token: value.token.trim(),
  };
  if (!node.name) throw new Error(t("请输入机器名称"));

  const index = nodes.findIndex((item) => item.id === node.id);
  if (index >= 0) nodes[index] = node;
  else nodes.push(node);
  writeViewerNodes(nodes);
  return node;
}

export function removeViewerNode(id: string): void {
  writeViewerNodes(getViewerNodes().filter((node) => node.id !== id));
  if (getActiveNodeId() === id) setActiveNodeId(LOCAL_NODE_ID);
}

export function getActiveNodeId(): string {
  const id = localStorage.getItem(ACTIVE_NODE_KEY) || LOCAL_NODE_ID;
  return id === LOCAL_NODE_ID || getViewerNodes().some((node) => node.id === id)
    ? id
    : LOCAL_NODE_ID;
}

export function setActiveNodeId(id: string): void {
  localStorage.setItem(ACTIVE_NODE_KEY, id);
}

export function getActiveRemoteNode(): ViewerNode | null {
  const id = getActiveNodeId();
  return getViewerNodes().find((node) => node.id === id) ?? null;
}

export function isRemoteNodeActive(): boolean {
  return getActiveRemoteNode() !== null;
}

export function getApiBaseUrl(): string {
  return getActiveRemoteNode()?.baseUrl ?? window.location.origin;
}

export function getApiToken(): string | null {
  const remote = getActiveRemoteNode();
  return remote ? remote.token || null : localStorage.getItem("asv_token");
}

export function setApiToken(token: string): void {
  const remote = getActiveRemoteNode();
  if (!remote) {
    if (token) localStorage.setItem("asv_token", token);
    else localStorage.removeItem("asv_token");
    return;
  }
  saveViewerNode({ ...remote, token });
}

export async function probeViewerNode(node: ViewerNode): Promise<NodeStatus> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = {};
    if (node.token) headers.Authorization = `Bearer ${node.token}`;
    const response = await fetch(new URL("/api/cli/detect", node.baseUrl), {
      headers,
      signal: controller.signal,
    });
    if (response.status === 401) return "unauthorized";
    return response.ok ? "online" : "offline";
  } catch {
    return "offline";
  } finally {
    window.clearTimeout(timeout);
  }
}

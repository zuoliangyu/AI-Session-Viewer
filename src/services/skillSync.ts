import { t } from "../i18n/index.js";
import type { ImportResult, SkillsResult } from "../types";
import {
  getViewerNodes,
  LOCAL_NODE_ID,
  type ViewerNode,
} from "./nodeConfig";

declare const __IS_TAURI__: boolean;

export function getSkillSyncNodes(): ViewerNode[] {
  const nodes = getViewerNodes();
  if (__IS_TAURI__) return nodes;

  const currentOrigin = window.location.origin;
  return [
    {
      id: LOCAL_NODE_ID,
      name: t("当前服务器"),
      baseUrl: currentOrigin,
      token: localStorage.getItem("asv_token") ?? "",
    },
    ...nodes.filter((node) => node.baseUrl !== currentOrigin),
  ];
}

async function nodeFetch(
  node: ViewerNode,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (node.token) headers.set("Authorization", `Bearer ${node.token}`);
  const response = await fetch(new URL(path, node.baseUrl), { ...init, headers });
  if (response.status === 401) throw new Error(t("{{v0}} 的访问令牌无效", { v0: node.name }));
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || t("{{v0}} 请求失败 ({{v1}})", { v0: node.name, v1: response.status }));
  }
  return response;
}

export type McpClient = "claude" | "codex";

export interface McpServerManifest {
  client: McpClient;
  name: string;
  config: Record<string, unknown>;
  redactedFields: string[];
  hash: string;
}

export interface PluginManifestItem {
  client: McpClient;
  kind: "marketplace" | "plugin";
  name: string;
  version: string | null;
  source: string | null;
}

export interface ConfigSyncManifest {
  mcpServers: McpServerManifest[];
  plugins: PluginManifestItem[];
}

export async function listNodeGlobalSkills(node: ViewerNode): Promise<SkillsResult> {
  return (await nodeFetch(node, "/api/skills")).json();
}

export async function exportNodeGlobalSkill(
  node: ViewerNode,
  slug: string,
): Promise<ArrayBuffer> {
  const path = `/api/skills/sync-export?slug=${encodeURIComponent(slug)}`;
  return (await nodeFetch(node, path)).arrayBuffer();
}

export async function applyNodeGlobalSkill(
  node: ViewerNode,
  slug: string,
  archive: ArrayBuffer,
  overwrite: boolean,
): Promise<ImportResult> {
  const path =
    `/api/skills/sync-apply?slug=${encodeURIComponent(slug)}` +
    `&overwrite=${String(overwrite)}`;
  return (
    await nodeFetch(node, path, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: archive,
    })
  ).json();
}

export async function getNodeConfigManifest(
  node: ViewerNode,
): Promise<ConfigSyncManifest> {
  return (await nodeFetch(node, "/api/sync/config-manifest")).json();
}

export async function applyNodeMcpServer(
  node: ViewerNode,
  server: McpServerManifest,
  expectedHash: string,
  overwrite: boolean,
): Promise<void> {
  await nodeFetch(node, "/api/sync/mcp-apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: server.client,
      name: server.name,
      config: server.config,
      expectedHash,
      overwrite,
    }),
  });
}

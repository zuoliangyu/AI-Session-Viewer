import { create } from "zustand";
import type {
  CliInstallation,
  CliConfig,
  ModelInfo,
  ChatMessage,
  ChatContentBlock,
} from "../types/chat";
import { api } from "../services/api";

type ChatSource = "claude" | "codex";

export const DEFAULT_CHAT_PANE_ID = "default";

export interface ChatPaneState {
  isActive: boolean;
  sessionId: string | null;
  projectPath: string;
  model: string;
  source: ChatSource;
  messages: ChatMessage[];
  rawOutput: string[];
  isStreaming: boolean;
  error: string | null;
}

type ChatPaneStateMap = Record<string, ChatPaneState>;
type ChatPaneStateUpdater =
  | Partial<ChatPaneState>
  | ((pane: ChatPaneState) => ChatPaneState);

interface ChatState {
  activePaneId: string;
  panes: ChatPaneStateMap;

  // Chat status
  isActive: boolean;
  sessionId: string | null;
  projectPath: string;
  model: string;
  source: ChatSource;

  // Messages
  messages: ChatMessage[];
  rawOutput: string[];
  isStreaming: boolean;
  error: string | null;

  // CLI info
  availableClis: CliInstallation[];

  // Model list
  modelList: ModelInfo[];
  modelListLoading: boolean;
  modelListError: string | null;

  // CLI config (auto-detected)
  cliConfig: CliConfig | null;
  cliConfigLoading: boolean;
  cliConfigError: string | null;
  codexCliConfig: CliConfig | null;
  codexCliConfigLoading: boolean;
  codexCliConfigError: string | null;

  // Manual API overrides (persisted to localStorage)
  claudeApiKeyOverride: string;
  claudeBaseUrlOverride: string;
  codexApiKeyOverride: string;
  codexBaseUrlOverride: string;

  // Settings (persisted to localStorage)
  skipPermissions: boolean;
  defaultModel: string;
  cliPath: string;

  // Actions
  detectCli: () => Promise<void>;
  fetchCliConfig: () => Promise<void>;
  fetchCodexCliConfig: () => Promise<void>;
  setClaudeApiKeyOverride: (v: string) => void;
  setClaudeBaseUrlOverride: (v: string) => void;
  setCodexApiKeyOverride: (v: string) => void;
  setCodexBaseUrlOverride: (v: string) => void;
  fetchModelList: () => Promise<void>;
  getPaneState: (paneId?: string) => ChatPaneState;
  setActivePane: (paneId: string) => void;
  setPaneState: (paneId: string, updater: ChatPaneStateUpdater) => void;
  clearPane: (paneId: string) => void;
  cancelPane: (paneId: string) => Promise<void>;
  startNewChatInPane: (
    paneId: string,
    projectPath: string,
    prompt: string,
    model: string
  ) => Promise<void>;
  continueExistingChatInPane: (
    paneId: string,
    sessionId: string,
    projectPath: string,
    prompt: string,
    model: string
  ) => Promise<void>;
  addStreamLineToPane: (paneId: string, line: string) => void;
  setPaneStreaming: (paneId: string, value: boolean) => void;
  setPaneSessionId: (paneId: string, id: string | null) => void;
  setPaneError: (paneId: string, error: string | null) => void;
  setPaneProjectPath: (paneId: string, path: string) => void;
  setPaneModel: (paneId: string, model: string) => void;
  setPaneSource: (paneId: string, source: ChatSource) => void;
  startNewChat: (
    projectPath: string,
    prompt: string,
    model: string
  ) => Promise<void>;
  continueExistingChat: (
    sessionId: string,
    projectPath: string,
    prompt: string,
    model: string
  ) => Promise<void>;
  cancelChat: () => Promise<void>;
  clearChat: () => void;
  setSkipPermissions: (v: boolean) => void;
  setDefaultModel: (m: string) => void;
  setCliPath: (p: string) => void;
  addCustomModel: (modelId: string, source?: "claude" | "codex") => void;
  removeCustomModel: (modelId: string, source?: "claude" | "codex") => void;
  addStreamLine: (line: string) => void;
  setStreaming: (v: boolean) => void;
  setSessionId: (id: string) => void;
  setError: (e: string | null) => void;
  setProjectPath: (p: string) => void;
  setModel: (m: string) => void;
  setSource: (s: ChatSource) => void;
}

function createChatPaneState(
  overrides: Partial<ChatPaneState> = {}
): ChatPaneState {
  return {
    isActive: false,
    sessionId: null,
    projectPath: "",
    model: localStorage.getItem("chat_lastUsedModel") || "",
    source: "claude",
    messages: [],
    rawOutput: [],
    isStreaming: false,
    error: null,
    ...overrides,
  };
}

function toLegacyPaneFields(pane: ChatPaneState): Pick<
  ChatState,
  | "isActive"
  | "sessionId"
  | "projectPath"
  | "model"
  | "source"
  | "messages"
  | "rawOutput"
  | "isStreaming"
  | "error"
> {
  return {
    isActive: pane.isActive,
    sessionId: pane.sessionId,
    projectPath: pane.projectPath,
    model: pane.model,
    source: pane.source,
    messages: pane.messages,
    rawOutput: pane.rawOutput,
    isStreaming: pane.isStreaming,
    error: pane.error,
  };
}

function getOrCreatePaneState(
  panes: ChatPaneStateMap,
  paneId: string,
  fallback?: Partial<ChatPaneState>
): ChatPaneState {
  return panes[paneId] ?? createChatPaneState(fallback);
}

function getPaneFallbackFromState(
  state: Pick<ChatState, "model" | "source" | "projectPath">
): Partial<ChatPaneState> {
  return {
    model: state.model,
    source: state.source,
    projectPath: state.projectPath,
  };
}

function applyPaneStateUpdate(
  state: ChatState,
  paneId: string,
  updater: ChatPaneStateUpdater
): Partial<ChatState> {
  const currentPane = getOrCreatePaneState(
    state.panes,
    paneId,
    getPaneFallbackFromState(state)
  );
  const nextPane =
    typeof updater === "function"
      ? updater(currentPane)
      : { ...currentPane, ...updater };
  const panes = {
    ...state.panes,
    [paneId]: nextPane,
  };

  if (paneId === state.activePaneId) {
    return {
      panes,
      ...toLegacyPaneFields(nextPane),
    };
  }

  return { panes };
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP + non-localhost)
  // crypto.getRandomValues() is still available in non-secure contexts
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16)
  );
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

/** Result of parsing a single stream line */
type ParseResult =
  | { action: "add"; message: ChatMessage }
  | { action: "delta"; delta: string; blockIndex: number }
  | { action: "block_start"; blockType: string; blockIndex: number }
  | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseClaudeStreamLine(line: string): ParseResult {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }

  if (!data || typeof data !== "object" || !data.type) return null;

  const recordType: string = data.type;

  // System init — extract session_id only, no visible message
  if (recordType === "system" && data.subtype === "init") {
    return null;
  }

  // Stream events — incremental content updates
  if (recordType === "stream_event" && data.event) {
    const evt = data.event;
    if (evt.type === "content_block_start" && typeof evt.index === "number") {
      const blockType = evt.content_block?.type || "text";
      return { action: "block_start", blockType, blockIndex: evt.index };
    }
    if (evt.type === "content_block_delta" && typeof evt.index === "number") {
      const delta = evt.delta;
      if (delta?.type === "text_delta" && delta.text) {
        return { action: "delta", delta: delta.text, blockIndex: evt.index };
      }
      if (delta?.type === "thinking_delta" && delta.thinking) {
        return { action: "delta", delta: delta.thinking, blockIndex: evt.index };
      }
    }
    // message_start: create a placeholder assistant message
    if (evt.type === "message_start" && evt.message) {
      const msg = evt.message;
      return {
        action: "add",
        message: {
          id: generateUUID(),
          role: "assistant",
          content: [],
          model: msg.model,
          timestamp: new Date().toISOString(),
          usage: msg.usage
            ? {
                inputTokens: msg.usage.input_tokens ?? 0,
                outputTokens: msg.usage.output_tokens ?? 0,
                cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
              }
            : undefined,
        },
      };
    }
    return null;
  }

  // Complete assistant message (final, replaces streaming placeholder)
  if (recordType === "assistant" && data.message) {
    const msg = data.message;
    const content = parseContentValue(msg.content);
    if (content.length === 0) return null;

    const usage = msg.usage || data.usage;
    if (usage && (usage.output_tokens ?? 0) === 0) return null;

    return {
      action: "add",
      message: {
        id: generateUUID(),
        role: "assistant",
        content,
        model: msg.model || data.model,
        timestamp: data.timestamp || new Date().toISOString(),
        usage: usage
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            }
          : undefined,
      },
    };
  }

  // User message (including tool_result content blocks)
  if (recordType === "user" && data.message) {
    const msg = data.message;
    const content = parseContentValue(msg.content);
    if (content.length === 0) return null;

    return {
      action: "add",
      message: {
        id: generateUUID(),
        role: "user",
        content,
        timestamp: data.timestamp || new Date().toISOString(),
      },
    };
  }

  // Result message — final summary with token breakdown
  if (recordType === "result") {
    const text =
      data.result ||
      data.error ||
      (data.is_error ? "Error" : "Done");
    const durationInfo = data.duration_ms
      ? ` (${(data.duration_ms / 1000).toFixed(1)}s)`
      : "";

    const usage = data.usage;
    let tokenInfo = "";
    if (usage) {
      const parts: string[] = [];
      if (usage.input_tokens) parts.push(`输入: ${usage.input_tokens.toLocaleString()}`);
      if (usage.output_tokens) parts.push(`输出: ${usage.output_tokens.toLocaleString()}`);
      if (usage.cache_creation_input_tokens) parts.push(`写入缓存: ${usage.cache_creation_input_tokens.toLocaleString()}`);
      if (usage.cache_read_input_tokens) parts.push(`读取缓存: ${usage.cache_read_input_tokens.toLocaleString()}`);
      if (parts.length > 0) tokenInfo = ` [${parts.join(" · ")}]`;
    }

    return {
      action: "add",
      message: {
        id: generateUUID(),
        role: "system",
        content: [{ type: "text", text: `${text}${durationInfo}${tokenInfo}` }],
        timestamp: new Date().toISOString(),
      },
    };
  }

  return null;
}

/**
 * Parse Claude's `content` field which can be:
 * - A plain string (user prompt text)
 * - An array of content blocks (text, thinking, tool_use, tool_result, etc.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContentValue(content: any): ChatContentBlock[] {
  if (!content) return [];

  // Plain string content
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }

  // Array of content blocks
  if (!Array.isArray(content)) return [];

  const results: ChatContentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const blockType: string = block.type;

    if (blockType === "text" && block.text) {
      results.push({ type: "text", text: block.text });
    } else if (blockType === "thinking" && block.thinking) {
      results.push({ type: "thinking", text: block.thinking });
    } else if (blockType === "tool_use" && block.name) {
      results.push({
        type: "tool_use",
        id: block.id || "",
        name: block.name,
        input:
          typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2),
      });
    } else if (blockType === "tool_result") {
      let resultContent: string;
      if (typeof block.content === "string") {
        resultContent = block.content;
      } else if (Array.isArray(block.content)) {
        // tool_result content can be an array of {type:"text", text:"..."} blocks
        resultContent = block.content
          .map((c: any) => (typeof c === "string" ? c : c?.text || JSON.stringify(c)))
          .join("\n");
      } else if (block.content) {
        resultContent = JSON.stringify(block.content, null, 2);
      } else {
        resultContent = "";
      }
      results.push({
        type: "tool_result",
        toolUseId: block.tool_use_id || "",
        content: resultContent,
        isError: block.is_error || false,
      });
    }
  }
  return results;
}

/**
 * Parse a single line from `codex exec --json` stdout.
 * Events: thread.started, item.completed (agent_message/reasoning/command_execution/file_change),
 *         turn.completed, turn.failed
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCodexStreamLine(line: string): { action: "session_id"; id: string } | { action: "add"; message: ChatMessage } | { action: "done"; usage?: any } | null {
  let data: any;
  try { data = JSON.parse(line); } catch { return null; }
  if (!data || typeof data !== "object") return null;

  const type: string = data.type;

  // Session ID comes from thread.started
  if (type === "thread.started" && data.thread_id) {
    return { action: "session_id", id: data.thread_id };
  }

  // Completed items — agent messages and reasoning
  if (type === "item.completed" && data.item) {
    const item = data.item;
    const itemType: string = item.type || "";

    if (itemType === "agent_message" && item.text) {
      return {
        action: "add",
        message: {
          id: generateUUID(),
          role: "assistant",
          content: [{ type: "text", text: item.text }],
          timestamp: new Date().toISOString(),
        },
      };
    }

    if (itemType === "reasoning" && item.text) {
      return {
        action: "add",
        message: {
          id: generateUUID(),
          role: "assistant",
          content: [{ type: "thinking", text: item.text }],
          timestamp: new Date().toISOString(),
        },
      };
    }

    if (itemType === "command_execution") {
      const cmd = item.command || "";
      const output = item.output || "";
      return {
        action: "add",
        message: {
          id: item.id || generateUUID(),
          role: "assistant",
          content: [
            { type: "tool_use", id: item.id || "", name: "shell", input: cmd },
            ...(output ? [{ type: "tool_result" as const, toolUseId: item.id || "", content: output, isError: item.exit_code !== 0 && item.exit_code != null }] : []),
          ],
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  // Turn completed — streaming done, report token usage
  if (type === "turn.completed") {
    return { action: "done", usage: data.usage };
  }

  // Turn failed — surface error
  if (type === "turn.failed") {
    return { action: "done", usage: undefined };
  }

  return null;
}

export const useChatStore = create<ChatState>((set, get) => {
  const initialDefaultPane = createChatPaneState();

  return {
    activePaneId: DEFAULT_CHAT_PANE_ID,
    panes: {
      [DEFAULT_CHAT_PANE_ID]: initialDefaultPane,
    },
    ...toLegacyPaneFields(initialDefaultPane),

    availableClis: [],

    modelList: [],
    modelListLoading: false,
    modelListError: null,

    cliConfig: null,
    cliConfigLoading: false,
    cliConfigError: null,
    codexCliConfig: null,
    codexCliConfigLoading: false,
    codexCliConfigError: null,

    claudeApiKeyOverride: localStorage.getItem("chat_claudeApiKey") || "",
    claudeBaseUrlOverride: localStorage.getItem("chat_claudeBaseUrl") || "",
    codexApiKeyOverride: localStorage.getItem("chat_codexApiKey") || "",
    codexBaseUrlOverride: localStorage.getItem("chat_codexBaseUrl") || "",

    skipPermissions: localStorage.getItem("chat_skipPermissions") === "true",
    defaultModel: localStorage.getItem("chat_defaultModel") || "",
    cliPath: localStorage.getItem("chat_cliPath") || "",

  detectCli: async () => {
    try {
      const clis = await api.detectCli();
      set({ availableClis: clis });
    } catch (e) {
      console.error("Failed to detect CLI:", e);
    }
  },

  fetchCliConfig: async () => {
    set({ cliConfigLoading: true, cliConfigError: null });
    try {
      const config = await api.getCliConfig("claude");
      set({ cliConfig: config, cliConfigLoading: false });
    } catch (e) {
      set({
        cliConfigLoading: false,
        cliConfigError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  fetchCodexCliConfig: async () => {
    set({ codexCliConfigLoading: true, codexCliConfigError: null });
    try {
      const config = await api.getCliConfig("codex");
      set({ codexCliConfig: config, codexCliConfigLoading: false });
    } catch (e) {
      set({
        codexCliConfigLoading: false,
        codexCliConfigError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  getPaneState: (paneId = DEFAULT_CHAT_PANE_ID) => {
    const state = get();
    return getOrCreatePaneState(
      state.panes,
      paneId,
      getPaneFallbackFromState(state)
    );
  },

  setActivePane: (paneId) => {
    set((state) => {
      const nextPane = getOrCreatePaneState(
        state.panes,
        paneId,
        getPaneFallbackFromState(state)
      );
      return {
        activePaneId: paneId,
        panes: {
          ...state.panes,
          [paneId]: nextPane,
        },
        ...toLegacyPaneFields(nextPane),
      };
    });
  },

  setPaneState: (paneId, updater) => {
    set((state) => applyPaneStateUpdate(state, paneId, updater));
  },

  clearPane: (paneId) => {
    set((state) => {
      const currentPane = getOrCreatePaneState(
        state.panes,
        paneId,
        getPaneFallbackFromState(state)
      );
      return applyPaneStateUpdate(state, paneId, () =>
        createChatPaneState({
          projectPath: currentPane.projectPath,
          model: currentPane.model || state.defaultModel || state.model,
          source: currentPane.source,
        })
      );
    });
  },

  cancelPane: async (paneId) => {
    const pane = get().getPaneState(paneId);
    if (pane.sessionId) {
      try {
        await api.cancelChat(pane.sessionId);
      } catch (e) {
        console.error("Failed to cancel chat:", e);
      }
    }
    get().setPaneStreaming(paneId, false);
  },

  fetchModelList: async () => {
    const { source, claudeApiKeyOverride, claudeBaseUrlOverride, codexApiKeyOverride, codexBaseUrlOverride } = get();
    const apiKey = source === "codex" ? codexApiKeyOverride : claudeApiKeyOverride;
    const baseUrl = source === "codex" ? codexBaseUrlOverride : claudeBaseUrlOverride;
    set({ modelListLoading: true, modelListError: null });
    try {
      let activeCliConfig = source === "codex" ? get().codexCliConfig : get().cliConfig;
      if (!activeCliConfig) {
        try {
          const config = await api.getCliConfig(source);
          activeCliConfig = config;
          if (source === "codex") {
            set({ codexCliConfig: config, codexCliConfigError: null });
          } else {
            set({ cliConfig: config, cliConfigError: null });
          }
        } catch (configError) {
          const message = configError instanceof Error ? configError.message : String(configError);
          if (source === "codex") {
            set({ codexCliConfigError: message });
          } else {
            set({ cliConfigError: message });
          }
        }
      }

      const models = await api.listModels(source, apiKey, baseUrl);
      const customKey = `chat_customModels_${source}`;
      const customIds: string[] = JSON.parse(localStorage.getItem(customKey) || "[]");
      const existingIds = new Set(models.map((m) => m.id));
      const provider = source === "codex" ? "openai" : "anthropic";
      const customModels: ModelInfo[] = customIds
        .filter((id) => !existingIds.has(id))
        .map((id) => ({ id, name: id, provider, group: "自定义", created: null }));
      const allModels = [...customModels, ...models];
      set({ modelList: allModels, modelListLoading: false });

      // Auto-select first model if current model is empty or not in this source's list
      const state = get();
      const modelIds = new Set(allModels.map((m) => m.id));
      if (!state.model || !modelIds.has(state.model)) {
        const resolve = (name: string): string => {
          if (!name) return "";
          if (modelIds.has(name)) return name;
          const lower = name.toLowerCase();
          return allModels.find((m) => m.id.toLowerCase().includes(lower))?.id || "";
        };
        const candidates = [
          resolve(state.model),
          resolve(state.defaultModel),
          resolve(activeCliConfig?.defaultModel || ""),
        ].filter(Boolean);
        const selected = candidates[0] || (allModels.length > 0 ? allModels[0].id : "");
        if (selected && selected !== state.model) {
          get().setPaneModel(get().activePaneId, selected);
        }
      }
    } catch (e) {
      set({
        modelListLoading: false,
        modelListError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  startNewChatInPane: async (paneId, projectPath, prompt, model) => {
    const state = get();
    const pane = state.getPaneState(paneId);
    const pendingSessionId = generateUUID();
    localStorage.setItem("chat_lastUsedModel", model);
    get().setPaneState(paneId, {
      isActive: true,
      sessionId: pendingSessionId,
      isStreaming: true,
      projectPath,
      model,
      error: null,
      messages: [
        {
          id: generateUUID(),
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: new Date().toISOString(),
        },
      ],
      rawOutput: [],
    });

    try {
      await waitForNextPaint();
      const sessionId = await api.startChat({
        source: pane.source,
        sessionId: pendingSessionId,
        projectPath,
        prompt,
        model,
        skipPermissions: state.skipPermissions,
        cliPath: state.cliPath || undefined,
      });
      if (sessionId !== pendingSessionId) {
        get().setPaneSessionId(paneId, sessionId);
      }
    } catch (e) {
      get().setPaneState(paneId, {
        sessionId: null,
        isStreaming: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  continueExistingChatInPane: async (
    paneId,
    sessionId,
    projectPath,
    prompt,
    model
  ) => {
    const state = get();
    const pane = state.getPaneState(paneId);
    localStorage.setItem("chat_lastUsedModel", model);
    get().setPaneState(paneId, {
      isActive: true,
      isStreaming: true,
      sessionId,
      projectPath,
      model,
      error: null,
      messages: [
        ...pane.messages,
        {
          id: generateUUID(),
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: new Date().toISOString(),
        },
      ],
      rawOutput: [],
    });

    try {
      await api.continueChat({
        source: pane.source,
        sessionId,
        projectPath,
        prompt,
        model,
        skipPermissions: state.skipPermissions,
        cliPath: state.cliPath || undefined,
      });
    } catch (e) {
      get().setPaneState(paneId, {
        isStreaming: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  startNewChat: async (projectPath, prompt, model) => {
    await get().startNewChatInPane(
      DEFAULT_CHAT_PANE_ID,
      projectPath,
      prompt,
      model
    );
  },

  continueExistingChat: async (sessionId, projectPath, prompt, model) => {
    await get().continueExistingChatInPane(
      DEFAULT_CHAT_PANE_ID,
      sessionId,
      projectPath,
      prompt,
      model
    );
  },

  cancelChat: async () => {
    await get().cancelPane(DEFAULT_CHAT_PANE_ID);
  },

  clearChat: () => {
    get().clearPane(DEFAULT_CHAT_PANE_ID);
  },

  setSkipPermissions: (v) => {
    localStorage.setItem("chat_skipPermissions", String(v));
    set({ skipPermissions: v });
  },

  setDefaultModel: (m) => {
    localStorage.setItem("chat_defaultModel", m);
    set({ defaultModel: m });
  },

  setCliPath: (p) => {
    localStorage.setItem("chat_cliPath", p);
    set({ cliPath: p });
  },

  addCustomModel: (modelId, sourceOverride) => {
    const state = get();
    const src = sourceOverride ?? state.source;
    const customKey = `chat_customModels_${src}`;
    const existing: string[] = JSON.parse(localStorage.getItem(customKey) || "[]");
    if (!existing.includes(modelId)) {
      localStorage.setItem(customKey, JSON.stringify([...existing, modelId]));
    }
    // Only update chatStore.modelList if this source matches the active source
    if (src === state.source && !state.modelList.some((m) => m.id === modelId)) {
      set({
        modelList: [
          { id: modelId, name: modelId, provider: src === "codex" ? "openai" : "anthropic", group: "自定义", created: null },
          ...state.modelList,
        ],
      });
    }
  },

  removeCustomModel: (modelId, sourceOverride) => {
    const state = get();
    const src = sourceOverride ?? state.source;
    const customKey = `chat_customModels_${src}`;
    const existing: string[] = JSON.parse(localStorage.getItem(customKey) || "[]");
    localStorage.setItem(customKey, JSON.stringify(existing.filter((id) => id !== modelId)));
    // Only update chatStore.modelList if this source matches the active source
    if (src === state.source) {
      set({ modelList: state.modelList.filter((m) => m.id !== modelId) });
    }
  },

  addStreamLineToPane: (paneId, line) => {
    const pane = get().getPaneState(paneId);

    if (pane.source === "codex") {
      const parsed = parseCodexStreamLine(line);
      if (!parsed) {
        get().setPaneState(paneId, (currentPane) => ({
          ...currentPane,
          rawOutput: [...currentPane.rawOutput, line],
        }));
        return;
      }
      if (parsed.action === "session_id") {
        get().setPaneSessionId(paneId, parsed.id);
      } else if (parsed.action === "add") {
        get().setPaneState(paneId, (currentPane) => ({
          ...currentPane,
          rawOutput: [...currentPane.rawOutput, line],
          messages: [...currentPane.messages, parsed.message],
        }));
      } else if (parsed.action === "done") {
        const usageInfo = parsed.usage;
        if (usageInfo) {
          const parts: string[] = [];
          if (usageInfo.input_tokens) parts.push(`输入: ${usageInfo.input_tokens.toLocaleString()}`);
          if (usageInfo.output_tokens) parts.push(`输出: ${usageInfo.output_tokens.toLocaleString()}`);
          if (usageInfo.cached_input_tokens) parts.push(`缓存命中: ${usageInfo.cached_input_tokens.toLocaleString()}`);
          if (parts.length > 0) {
            get().setPaneState(paneId, (currentPane) => ({
              ...currentPane,
              isStreaming: false,
              rawOutput: [...currentPane.rawOutput, line],
              messages: [
                ...currentPane.messages,
                {
                  id: generateUUID(),
                  role: "system",
                  content: [{ type: "text", text: `完成 [${parts.join(" · ")}]` }],
                  timestamp: new Date().toISOString(),
                },
              ],
            }));
            return;
          }
        }
        get().setPaneState(paneId, (currentPane) => ({
          ...currentPane,
          isStreaming: false,
          rawOutput: [...currentPane.rawOutput, line],
        }));
      }
      return;
    }

    const parsed = parseClaudeStreamLine(line);

    try {
      const data = JSON.parse(line);
      if (data.type === "system" && data.subtype === "init" && data.session_id) {
        get().setPaneSessionId(paneId, data.session_id);
      }
      if (data.type === "result") {
        const extras: Partial<ChatPaneState> = { isStreaming: false };
        if (data.is_error || data.error) {
          extras.error = data.error || data.result || "Unknown error";
        }
        get().setPaneState(paneId, extras);
      }
    } catch {
      // ignore non-JSON
    }

    if (!parsed) {
      get().setPaneState(paneId, (currentPane) => ({
        ...currentPane,
        rawOutput: [...currentPane.rawOutput, line],
      }));
      return;
    }

    get().setPaneState(paneId, (currentPane) => {
      let newMessages = currentPane.messages;

      if (parsed.action === "add") {
        const lastIdx = newMessages.length - 1;
        if (
          parsed.message.role === "assistant" &&
          lastIdx >= 0 &&
          newMessages[lastIdx].role === "assistant"
        ) {
          newMessages = [...newMessages.slice(0, lastIdx), parsed.message];
        } else {
          newMessages = [...newMessages, parsed.message];
        }
      } else if (parsed.action === "block_start") {
        const lastIdx = newMessages.length - 1;
        if (lastIdx >= 0 && newMessages[lastIdx].role === "assistant") {
          const lastMsg = newMessages[lastIdx];
          const newBlock: ChatContentBlock =
            parsed.blockType === "thinking"
              ? { type: "thinking", text: "" }
              : { type: "text", text: "" };
          const updated = {
            ...lastMsg,
            content: [...lastMsg.content, newBlock],
          };
          newMessages = [...newMessages.slice(0, lastIdx), updated];
        }
      } else if (parsed.action === "delta") {
        const lastIdx = newMessages.length - 1;
        if (lastIdx >= 0 && newMessages[lastIdx].role === "assistant") {
          const lastMsg = newMessages[lastIdx];
          const blocks = [...lastMsg.content];
          const bi = parsed.blockIndex;
          if (bi < blocks.length) {
            const block = blocks[bi];
            if (block.type === "text" || block.type === "thinking") {
              blocks[bi] = { ...block, text: block.text + parsed.delta };
            }
          }
          newMessages = [
            ...newMessages.slice(0, lastIdx),
            { ...lastMsg, content: blocks },
          ];
        }
      }

      return {
        ...currentPane,
        rawOutput: [...currentPane.rawOutput, line],
        messages: newMessages,
      };
    });
  },

  addStreamLine: (line) => {
    get().addStreamLineToPane(DEFAULT_CHAT_PANE_ID, line);
  },

  setClaudeApiKeyOverride: (v) => { localStorage.setItem("chat_claudeApiKey", v); set({ claudeApiKeyOverride: v }); },
  setClaudeBaseUrlOverride: (v) => { localStorage.setItem("chat_claudeBaseUrl", v); set({ claudeBaseUrlOverride: v }); },
  setCodexApiKeyOverride: (v) => { localStorage.setItem("chat_codexApiKey", v); set({ codexApiKeyOverride: v }); },
  setCodexBaseUrlOverride: (v) => { localStorage.setItem("chat_codexBaseUrl", v); set({ codexBaseUrlOverride: v }); },

  setPaneStreaming: (paneId, value) => {
    get().setPaneState(paneId, { isStreaming: value });
  },
  setPaneSessionId: (paneId, id) => {
    get().setPaneState(paneId, { sessionId: id });
  },
  setPaneError: (paneId, error) => {
    get().setPaneState(paneId, { error });
  },
  setPaneProjectPath: (paneId, path) => {
    get().setPaneState(paneId, { projectPath: path });
  },
  setPaneModel: (paneId, model) => {
    localStorage.setItem("chat_lastUsedModel", model);
    get().setPaneState(paneId, { model });
  },
  setPaneSource: (paneId, source) => {
    const pane = get().getPaneState(paneId);
    if (pane.source === source) return;
    set((state) => {
      const updates = applyPaneStateUpdate(state, paneId, {
        source,
        model: "",
      });
      if (paneId === state.activePaneId) {
        return {
          ...updates,
          modelList: [],
        };
      }
      return updates;
    });
  },

  setStreaming: (v) => {
    get().setPaneStreaming(DEFAULT_CHAT_PANE_ID, v);
  },
  setSessionId: (id) => {
    get().setPaneSessionId(DEFAULT_CHAT_PANE_ID, id);
  },
  setError: (e) => {
    get().setPaneError(DEFAULT_CHAT_PANE_ID, e);
  },
  setProjectPath: (p) => {
    get().setPaneProjectPath(DEFAULT_CHAT_PANE_ID, p);
  },
  setModel: (m) => {
    get().setPaneModel(DEFAULT_CHAT_PANE_ID, m);
  },
  setSource: (s) => {
    get().setPaneSource(DEFAULT_CHAT_PANE_ID, s);
  },
  };
});

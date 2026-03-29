declare const __IS_TAURI__: boolean;

import type * as TauriApi from "./tauriApi";

type ApiModule = typeof TauriApi;

// Keep the API object synchronous so app startup does not depend on top-level await
// support in the embedded WebView runtime.
const apiModulePromise: Promise<ApiModule> = __IS_TAURI__
  ? import("./tauriApi")
  : import("./webApi");

export const api = new Proxy({} as ApiModule, {
  get(_target, prop) {
    return async (...args: unknown[]) => {
      const apiModule = await apiModulePromise;
      const member = apiModule[prop as keyof ApiModule];

      if (typeof member !== "function") {
        return member;
      }

      return (member as (...innerArgs: unknown[]) => unknown)(...args);
    };
  },
});

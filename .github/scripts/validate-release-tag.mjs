import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateReleaseTag(tag, version) {
  // Only stable releases are published by this workflow (prerelease: false).
  if (typeof tag !== "string" || tag !== tag.trim() || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error("Release tag must use the stable vMAJOR.MINOR.PATCH format");
  }
  if (tag !== `v${version}`) {
    throw new Error("Release tag must match package.json version");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  validateReleaseTag(process.env.RELEASE_TAG, version);
  console.log("Release tag matches package.json");
}

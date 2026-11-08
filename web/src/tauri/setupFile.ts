/**
 * Zero-typing setup for the desktop shell. On startup, when no hub URL or token is stored, the
 * setup file at <appConfigDir>/config.json is applied as if the user had saved Setup. After the
 * hub answers /health the file is rewritten without the token.
 */
import { HubClient, normalizeHubUrl } from "../sync/api";
import { META, setMeta } from "../sync/db";
import { engine } from "../sync/engine";
import { isTauri, readSetupFile, setupFilePath, stripSetupToken } from "./bridge";

export type SetupFileState = "not-desktop" | "missing" | "incomplete" | "applied" | "applied-unverified" | "error";

export interface SetupFileResult {
  path: string;
  state: SetupFileState;
  detail?: string;
  at: string;
}

export async function applySetupFile(): Promise<SetupFileResult> {
  const at = new Date().toISOString();
  if (!isTauri) return { path: "", state: "not-desktop", at };
  let path = "";
  try {
    path = await setupFilePath();
  } catch (e) {
    return { path, state: "error", detail: e instanceof Error ? e.message : String(e), at };
  }
  const done = async (r: Omit<SetupFileResult, "path" | "at">): Promise<SetupFileResult> => {
    const result = { path, at, ...r };
    await setMeta(META.setupFile, result);
    return result;
  };
  let cfg;
  try {
    cfg = await readSetupFile();
  } catch (e) {
    return done({ state: "error", detail: e instanceof Error ? e.message : String(e) });
  }
  if (!cfg) return done({ state: "missing" });
  const hubUrl = normalizeHubUrl(String(cfg.hub_url ?? ""));
  const token = String(cfg.token ?? "").trim();
  if (!hubUrl || !token) return done({ state: "incomplete", detail: "needs hub_url and token" });

  await setMeta(META.hubUrl, hubUrl);
  await setMeta(META.token, token);
  const name = String(cfg.device_name ?? "").trim();
  if (name) await setMeta(META.deviceName, name);
  await engine.restart();

  try {
    const h = await new HubClient({ hubUrl, token }).health();
    await stripSetupToken();
    return done({ state: "applied", detail: `hub ${h.version}, token removed from the file` });
  } catch (e) {
    return done({ state: "applied-unverified", detail: `hub not reachable yet, token left in the file: ${e instanceof Error ? e.message : String(e)}` });
  }
}

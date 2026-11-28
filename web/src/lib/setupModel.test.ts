import { describe, expect, it } from "vitest";
import { modelDownload, noModelCard, pullProgress } from "./setupModel";
import type { PullState, SetupAi } from "../sync/api";

const URL = "http://127.0.0.1:11434";
const ai = (model: string | null, cloud = false): SetupAi => ({
  ollama: model === null ? null : { url: URL, model },
  openai: null,
  anthropic: cloud ? { model: "claude", key_set: true } : null,
});
const view = (model: string | null, ready = false) => ({ ai: ai(model), model_ready: ready });
const servers = (models: string[]) => ({ servers: [{ kind: "ollama" as const, label: "Ollama", url: URL, models }] });
const pull = (p: Partial<PullState>): PullState => ({ model: "qwen3:8b", status: "downloading", completed: 0, total: 0, done: false, error: null, ...p });

describe("the model step's download", () => {
  it("is offered while the chosen model is not on the hub's machine, and not while one runs or it is there", () => {
    expect(modelDownload(view("qwen3:8b"), servers([]), null)).toEqual({ model: "qwen3:8b", label: "Download qwen3:8b" });
    expect(modelDownload(view("qwen3:8b"), servers([]), pull({}))).toBeNull();
    expect(modelDownload(view("qwen3:8b"), servers(["qwen3:8b"]), null)).toBeNull();
    expect(modelDownload(view("qwen3:8b"), servers(["qwen3:8b:latest"]), null)).toBeNull();
    expect(modelDownload(view("qwen3:8b", true), servers([]), null)).toBeNull();
    expect(modelDownload(view(""), servers([]), null)).toBeNull();
    expect(modelDownload(view(null), servers([]), null)).toBeNull();
    expect(modelDownload(null, null, null)).toBeNull();
  });

  it("resumes a download the hub restarted in the middle of, or one that failed part way", () => {
    const cut = pull({ done: true, interrupted: true, error: "the hub restarted before it finished", completed: 400, total: 1000 });
    expect(modelDownload(view("qwen3:8b"), servers([]), cut)).toEqual({ model: "qwen3:8b", label: "Resume download" });
    // Before the page knew of any server (detect still loading), it is offered all the same.
    expect(modelDownload(view("qwen3:8b"), null, cut)?.label).toBe("Resume download");
    expect(modelDownload(view("qwen3:8b"), servers([]), pull({ done: true, error: "connection refused" }))?.label).toBe("Try again");
  });

  it("downloads again a model that finished once and is gone, and the chosen model when the last download was another", () => {
    expect(modelDownload(view("qwen3:8b"), servers([]), pull({ done: true, status: "success" }))?.label).toBe("Download again");
    expect(modelDownload(view("qwen3:4b"), servers([]), pull({ done: true, error: "boom", completed: 5 }))).toEqual({ model: "qwen3:4b", label: "Download qwen3:4b" });
  });

  it("says how far it got", () => {
    expect(pullProgress({ completed: 420, total: 1000, status: "downloading" })).toBe("42%");
    expect(pullProgress({ completed: 0, total: 0, status: "pulling manifest" })).toBe("pulling manifest");
  });
});

describe("the Assistant's model card", () => {
  it("leads to setup when no model is chosen, says the chosen one is not ready, and is gone once one is ready", () => {
    expect(noModelCard(view(null))?.title).toBe("Set up a model first");
    expect(noModelCard(view(""))?.button).toBe("Set up a model");
    const waiting = noModelCard(view("qwen3:8b"));
    expect(waiting?.title).toBe("The model is not ready yet");
    expect(waiting?.text).toContain("qwen3:8b");
    expect(noModelCard(view("qwen3:8b", true))).toBeNull();
    expect(noModelCard({ ai: ai(null, true), model_ready: true })).toBeNull();
    expect(noModelCard(null)).toBeNull();
    for (const c of [noModelCard(view(null)), waiting]) expect(`${c?.title} ${c?.text} ${c?.button}`).not.toMatch(/[\u2013\u2014]|backend/);
  });
});

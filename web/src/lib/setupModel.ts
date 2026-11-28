import type { PullState, SetupDetect, SetupView } from "../sync/api";

const named = (names: string[], model: string) => names.some((n) => n === model || n === `${model}:latest`);

/**
 * The download the model step offers when the chosen Ollama model is not on the hub's machine: after the page was
 * closed and opened again, after a download failed, or after the hub restarted in the middle of one (Ollama keeps what
 * it had, so fetching it again carries on from there). Null while a download runs, when the model is there, or when no
 * Ollama model is chosen.
 */
export function modelDownload(view: Pick<SetupView, "ai" | "model_ready"> | null, detect: Pick<SetupDetect, "servers"> | null, pull: PullState | null): { model: string; label: string } | null {
  const chosen = view?.ai.ollama?.model ?? "";
  if (!view || !chosen || view.model_ready) return null;
  if (pull && !pull.done) return null;
  const server = detect?.servers.find((s) => s.kind === "ollama" && s.url === view.ai.ollama!.url);
  if (server && named(server.models, chosen)) return null;
  const last = pull?.model === chosen ? pull : null;
  if (last?.error) return { model: chosen, label: last.completed > 0 ? "Resume download" : "Try again" };
  if (last) return { model: chosen, label: "Download again" };
  return { model: chosen, label: `Download ${chosen}` };
}

/** How far a download got, in words: "42%", or Ollama's own status before it knows the size. */
export function pullProgress(p: Pick<PullState, "completed" | "total" | "status">): string {
  return p.total ? `${Math.round((p.completed / p.total) * 100)}%` : p.status;
}

/**
 * What the Assistant screen says when no model can answer: none chosen yet (setup's model step was skipped), or a
 * local one chosen that is not on the hub's machine yet (its download stopped, or Ollama is not running). Null when a
 * model is ready.
 */
export function noModelCard(view: Pick<SetupView, "ai" | "model_ready"> | null): { title: string; text: string; button: string } | null {
  if (!view || view.model_ready) return null;
  const local = view.ai.ollama?.model;
  if (local) {
    return {
      title: "The model is not ready yet",
      text: `${local} is not on the hub's computer yet, or Ollama is not running there. Setup shows how its download is going and can start it again.`,
      button: "Open model setup",
    };
  }
  return {
    title: "Set up a model first",
    text: "The assistant needs a model to answer. Setup finds the one that fits the hub's computer and downloads it, with one click.",
    button: "Set up a model",
  };
}

/** The route of setup's model step. */
export const MODEL_STEP = "/welcome?step=model";

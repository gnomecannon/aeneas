import { useEffect } from "react";
import { go } from "./router";

/** True when the keyboard event comes from a field that takes typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

export const ESCAPE_EVENT = "ea:escape";

/**
 * The desktop's one-letter shortcuts, in the order the sidebar and Settings, About list them. `path` opens that screen;
 * c focuses Capture's text (opening Capture first) and / the search field. `module`: listed only while it is on (the
 * key still opens the screen, which then offers to turn the module on).
 */
export const GLOBAL_KEYS: ReadonlyArray<{ key: string; label: string; path?: string; module?: string }> = [
  { key: "t", label: "today", path: "/today" },
  { key: "a", label: "assistant", path: "/assistant" },
  { key: "c", label: "capture" },
  { key: "w", label: "week", path: "/week" },
  { key: "o", label: "tech overview", path: "/ops", module: "homelab" },
  { key: "f", label: "food", path: "/food", module: "food" },
  { key: "p", label: "procedures", path: "/procedures", module: "projects" },
  { key: "l", label: "lists", path: "/lists" },
  { key: "/", label: "search" },
];

/** The letters to list, without those of modules that are off. */
export function listedKeys(on: (module: string | undefined) => boolean): typeof GLOBAL_KEYS {
  return GLOBAL_KEYS.filter((k) => on(k.module));
}

export type KeyAction = { go: string } | { focus: "capture" | "search" } | { escape: true };

/**
 * What a key press anywhere does: Escape always closes whatever is open; a letter from GLOBAL_KEYS acts only on a wide
 * screen, without Ctrl, Cmd or Alt, and never while typing in a field.
 */
export function keyAction(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "target">, wide: boolean): KeyAction | null {
  if (e.key === "Escape") return { escape: true };
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTypingTarget(e.target) || !wide) return null;
  const k = GLOBAL_KEYS.find((x) => x.key === e.key);
  if (!k) return null;
  if (k.path) return { go: k.path };
  return { focus: k.key === "c" ? "capture" : "search" };
}

/** The desktop shortcuts (GLOBAL_KEYS), and Escape, which closes whatever is open on any screen. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = keyAction(e, window.matchMedia("(min-width: 768px)").matches);
      if (!a) return;
      if ("escape" in a) {
        window.dispatchEvent(new CustomEvent(ESCAPE_EVENT));
        return;
      }
      e.preventDefault();
      if ("go" in a) go(a.go);
      else if (a.focus === "capture") focusCapture();
      else document.querySelector<HTMLInputElement>("input[data-search]")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function focusCapture() {
  const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-capture]");
  if (ta && window.location.hash.startsWith("#/capture")) {
    ta.focus();
    return;
  }
  // The Capture view focuses its textarea on mount.
  go("/capture");
}

/** Runs fn when Escape is pressed anywhere. */
export function useEscape(fn: () => void): void {
  useEffect(() => {
    const h = () => fn();
    window.addEventListener(ESCAPE_EVENT, h);
    return () => window.removeEventListener(ESCAPE_EVENT, h);
  }, [fn]);
}

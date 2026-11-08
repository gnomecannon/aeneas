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
 * Desktop shortcuts: t today, w week, c capture, n now, h hosts, o ops, f food, p procedures, l lists, / search, Escape closes whatever is open.
 * Letters are ignored while typing in a field and on narrow screens; Escape always fires.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.dispatchEvent(new CustomEvent(ESCAPE_EVENT));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      if (!window.matchMedia("(min-width: 768px)").matches) return;
      switch (e.key) {
        case "c":
          e.preventDefault();
          focusCapture();
          break;
        case "n":
          e.preventDefault();
          go("/now");
          break;
        case "t":
          e.preventDefault();
          go("/today");
          break;
        case "a":
          e.preventDefault();
          go("/assistant");
          break;
        case "w":
          e.preventDefault();
          go("/week");
          break;
        case "h":
          e.preventDefault();
          go("/hosts");
          break;
        case "o":
          e.preventDefault();
          go("/ops");
          break;
        case "f":
          e.preventDefault();
          go("/food");
          break;
        case "p":
          e.preventDefault();
          go("/procedures");
          break;
        case "l":
          e.preventDefault();
          go("/lists");
          break;
        case "/":
          e.preventDefault();
          document.querySelector<HTMLInputElement>("input[data-search]")?.focus();
          break;
      }
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

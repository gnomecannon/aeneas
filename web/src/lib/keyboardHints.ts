import { isAndroid } from "../tauri/bridge";

/**
 * Whether to mention keyboard shortcuts (Ctrl+Enter sends): not on Android or any touch-only screen (a phone or a
 * tablet in a browser), where there is no keyboard to press them on.
 */
export function showKeyboardHints(): boolean {
  if (isAndroid) return false;
  try { return !window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch { return true; }
}

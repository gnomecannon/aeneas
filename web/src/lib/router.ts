import { useEffect, useState } from "react";

export interface Route {
  path: string;
  parts: string[];
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/now";
  const [p, q = ""] = raw.split("?");
  const path = p.startsWith("/") ? p : "/" + p;
  return { path, parts: path.split("/").filter(Boolean), params: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parse());
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export function go(path: string): void {
  window.location.hash = path;
}

import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

/** `images="link"` for text a model wrote: pictures become links to open, never loaded on their own. */
export function Markdown({ text, images = "show" }: { text: string; images?: "show" | "link" }) {
  const html = useMemo(() => renderMarkdown(text, { images }), [text, images]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

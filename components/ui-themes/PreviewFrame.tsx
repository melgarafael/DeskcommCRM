"use client";
import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

/** An empty document receives React components, not a prototype HTML page. */
const documentTemplate =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main id="theme-preview" data-marca-org></main></body></html>';
export function PreviewFrame({
  children,
  appearance,
  title,
  narrow,
}: {
  children: ReactNode;
  appearance: "light" | "dark";
  title: string;
  narrow: boolean;
}) {
  const [previewDocument, setPreviewDocument] = useState<Document | null>(null);
  function loaded(event: SyntheticEvent<HTMLIFrameElement>) {
    const doc = event.currentTarget.contentDocument;
    if (!doc) return;
    // Use this build's actual design system and organization branding, in a separate document.
    for (const style of document.querySelectorAll('style,link[rel="stylesheet"]')) {
      const clone = style.cloneNode(true) as HTMLElement;
      if (style instanceof HTMLLinkElement) clone.setAttribute("href", style.href);
      doc.head.append(clone);
    }
    doc.documentElement.lang = document.documentElement.lang || "pt-BR";
    doc.documentElement.setAttribute("data-theme", appearance);
    setPreviewDocument(doc);
  }
  useEffect(() => {
    previewDocument?.documentElement.setAttribute("data-theme", appearance);
  }, [previewDocument, appearance]);
  const target = previewDocument?.getElementById("theme-preview");
  return (
    <div className="flex w-full justify-center overflow-hidden rounded-lg border border-border bg-bg">
      <iframe
        title={title}
        srcDoc={documentTemplate}
        sandbox="allow-same-origin"
        onLoad={loaded}
        className="block h-[540px] border-0"
        style={{ width: narrow ? "390px" : "100%", maxWidth: "100%" }}
      />
      {target ? createPortal(children, target) : null}
    </div>
  );
}

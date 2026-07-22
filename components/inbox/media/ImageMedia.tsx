"use client";
import { useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  alt: string;
}

/** Miniatura na bolha + lightbox (Dialog) no clique. Padrão WhatsApp Web. */
export function ImageMedia({ messageId, alt }: Props) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);
  const src = mediaSrc(messageId);

  if (state === "error") return <MediaUnavailable kind="Imagem" />;

  return (
    <>
      <button
        type="button"
        aria-label="Ampliar imagem"
        onClick={() => setOpen(true)}
        className="relative block cursor-zoom-in overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
      >
        {state === "loading" && <Skeleton className="absolute inset-0 h-full w-full" />}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          className={cn(
            "max-h-72 w-auto max-w-full rounded-lg object-cover",
            state === "loading" && "min-h-32 min-w-48 opacity-0",
          )}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl border-none bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img src={src} alt={alt} className="max-h-[85vh] w-full rounded-lg object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

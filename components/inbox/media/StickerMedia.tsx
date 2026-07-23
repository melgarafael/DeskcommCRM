"use client";
import { useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

/** Figurinha: inline, sem bolha — como no WhatsApp. */
export function StickerMedia({ messageId }: { messageId: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  if (state === "error") return <MediaUnavailable kind="Figurinha" className="h-40 w-40" />;
  return (
    <div className="relative h-40 w-40">
      {state === "loading" && <Skeleton className="absolute inset-0 h-full w-full rounded-lg" />}
      <img
        src={mediaSrc(messageId)}
        alt="Figurinha"
        loading="lazy"
        onLoad={() => setState("ready")}
        onError={() => setState("error")}
        className="h-40 w-40 object-contain"
      />
    </div>
  );
}

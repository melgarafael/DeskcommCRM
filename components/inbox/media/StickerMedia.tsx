"use client";
import { useState } from "react";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

/** Figurinha: inline, sem bolha — como no WhatsApp. */
export function StickerMedia({ messageId }: { messageId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaUnavailable kind="Figurinha" />;
  return (
    <img
      src={mediaSrc(messageId)}
      alt="Figurinha"
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-40 w-40 object-contain"
    />
  );
}

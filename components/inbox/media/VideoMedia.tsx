"use client";
import { useState } from "react";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

/** Vídeo inline com controles nativos (padrão WhatsApp Web). */
export function VideoMedia({ messageId }: { messageId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaUnavailable kind="Vídeo" />;
  return (
    <video
      src={mediaSrc(messageId)}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      className="max-h-72 w-full max-w-sm rounded-lg bg-black/5"
    />
  );
}

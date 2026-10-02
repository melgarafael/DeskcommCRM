"use client";
import { useT } from "@/hooks/i18n/useT";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import type { Message } from "@/lib/types/messaging";

import { AudioPlayer } from "./AudioPlayer";
import { DocumentCard } from "./DocumentCard";
import { ImageMedia } from "./ImageMedia";
import { StickerMedia } from "./StickerMedia";
import { VideoMedia } from "./VideoMedia";

/**
 * Dispatcher de mídia por message.type (Onda 1). Tipo com mídia mas sem
 * renderer dedicado (location/contact futuros) cai no DocumentCard —
 * sempre dá pro atendente baixar o arquivo.
 */
export function MediaRenderer({ message }: { message: Message }) {
  const t = useT();
  const isOutbound = message.direction === "outbound";
  switch (message.type) {
    case "image":
      return <ImageMedia messageId={message.id} alt={t("Imagem recebida")} />;
    case "sticker":
      return <StickerMedia messageId={message.id} />;
    case "audio": {
      const pronto = message.media_derived_status === "ready";
      const transcricao = message.media_derived_text?.trim();
      return (
        <div className="flex flex-col gap-2">
          <AudioPlayer messageId={message.id} isOutbound={isOutbound} />
          {pronto && transcricao && transcricao !== MARCADOR_NAO_LIDA ? (
            <p
              data-testid="transcricao-de-audio"
              className="text-sm leading-relaxed opacity-80"
            >
              {transcricao}
            </p>
          ) : null}
        </div>
      );
    }
    case "video":
      return <VideoMedia messageId={message.id} />;
    case "contact":
      return null;
    default:
      return (
        <DocumentCard
          messageId={message.id}
          mime={message.media_mime}
          sizeBytes={message.media_size_bytes}
          storagePath={message.media_storage_path}
          isOutbound={isOutbound}
        />
      );
  }
}

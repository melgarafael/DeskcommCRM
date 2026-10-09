"use client";
import { useT } from "@/hooks/i18n/useT";
import { DERIVACAO_TERMINADA, MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import type { Message } from "@/lib/types/messaging";

import { AudioPlayer } from "./AudioPlayer";
import { DocumentCard } from "./DocumentCard";
import { ImageMedia } from "./ImageMedia";
import { nomeOriginalDoDocumento } from "./media-utils";
import { StickerMedia } from "./StickerMedia";
import { VideoMedia } from "./VideoMedia";

/**
 * Quanto tempo o balão sustenta o "Transcrevendo…" de um áudio ainda sem
 * status. Null não garante que a derivação vá acontecer: ela só é pedida pela
 * ingestão do canal, e o worker pula grupo — o áudio do composer, o de grupo e
 * o antigo ficam null para sempre. Passado o teto, o aviso some mesmo sem texto.
 *
 * NÃO é o teto do drain (120s): aquele mede quanto o CLIENTE espera a resposta,
 * este quanto o aviso continua verdadeiro. Medição do drain.ts: conclusão de
 * transcrição p50/p90 = 14s/407s; 10 min cobre o p90 com folga, e a cauda
 * longa (p99 2538s) é retry após falha, não transcrição em andamento.
 */
const TETO_AVISO_TRANSCREVENDO_MS = 10 * 60_000;

/**
 * Dispatcher de mídia por message.type (Onda 1). Tipo com mídia mas sem
 * renderer dedicado (location/contact futuros) cai no DocumentCard —
 * sempre dá pro atendente baixar o arquivo.
 */
export function MediaRenderer({
  message,
  agora,
}: {
  message: Message;
  /** O relógio do MessageBubble (tick de 60s): é ele que tira o aviso vencido da tela. */
  agora: number;
}) {
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
      const texto =
        pronto && transcricao && transcricao !== MARCADOR_NAO_LIDA ? transcricao : null;
      // O worker não grava "pending": a linha nasce com status null e só o
      // worker muda — terminou quando o status entra em DERIVACAO_TERMINADA
      // (ready/failed/skipped). Null portanto significa "ainda processando",
      // e é o único sinal que o balão tem: sem ele o atendente vê o player e
      // não sabe se vai existir texto (#2133).
      const terminou = DERIVACAO_TERMINADA.has(message.media_derived_status ?? "");
      // Mesmo critério do drain: só a mídia que a ingestão manda derivar
      // (recebida, ou enviada pelo celular), pela idade em `created_at` — nunca
      // `sent_at`, que no inbound é o relógio do aparelho.
      const pendente =
        !terminou &&
        (message.direction === "inbound" || message.sent_via === "external_device") &&
        agora - new Date(message.created_at).getTime() < TETO_AVISO_TRANSCREVENDO_MS;
      return (
        <div className="flex flex-col gap-2">
          <AudioPlayer messageId={message.id} isOutbound={isOutbound} />
          {texto ? (
            <>
              <span
                data-testid="rotulo-transcricao"
                className="text-[10px] uppercase tracking-wide opacity-70"
              >
                {t("Transcrição")}
              </span>
              <p
                data-testid="transcricao-de-audio"
                className="text-sm leading-relaxed opacity-80"
              >
                {texto}
              </p>
            </>
          ) : pendente ? (
            <p
              data-testid="transcricao-de-audio-pendente"
              className="text-sm leading-relaxed opacity-60"
            >
              {t("Transcrevendo…")}
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
          fileName={nomeOriginalDoDocumento(message.metadata)}
        />
      );
  }
}

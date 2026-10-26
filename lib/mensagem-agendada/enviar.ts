/**
 * O envio de UMA parte pelo canal — a costura entre o handler do worker e o
 * `sendMessageHandler`, que é a porta de saída de TODOS os envios do sistema.
 *
 * Passar por lá não é atalho de arquitetura, é o que herda as travas todas:
 * organização operante, contato bloqueado, canal arquivado, janela de 24 h do
 * canal oficial, e — o ponto deste PR — a ANTI-DUPLICATA. O handler grava
 * `messages.id = ctx.internalMessageId`; na repetição, o 23505 relê a linha e,
 * se ela já tem recibo, devolve `already_sent` SEM mandar de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { registrarEnvioNoLedger } from "@/lib/agent-engine/pacing/ledger-supabase";
import { createAdminClient } from "@/lib/supabase/admin";

import type { EnviarParte, ParteDoDisparo, ResultadoDoEnvioDaParte } from "./disparo";

/** Mime → `messages.type`. O mesmo vocabulário que o Composer usa na prévia. */
function tipoDaParte(parte: ParteDoDisparo): "text" | "image" | "video" | "audio" | "document" {
  if (parte.media_storage_path === null) return "text";
  const mime = (parte.media_mime ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * O ator do envio: a PESSOA que agendou, quando existe.
 *
 * `sent_via` decide por autoria (`origemDaMensagem`) — um texto escrito por uma
 * pessoa e disparado pelo relógio do servidor continua sendo dela, e o balão
 * deve dizer isso. Sem autor (pacote criado por token), o ator é a automação:
 * dizer "IA" ali seria mentira no painel e no rótulo.
 */
function atorDoPacote(autor: string | null, pacoteId: string): HandlerCtx["actor"] {
  return autor !== null
    ? { type: "user", id: autor }
    : { type: "webhook_source", id: pacoteId };
}

export interface DepsDoEnviador {
  /** Injetável para teste/canal alternativo; default é o admin do Supabase. */
  admin?: SupabaseClient;
  /** `messages.metadata.request_id` — correlação com o job. */
  requestId?: string;
  /** Carimba a mensagem com um id estável do job, não com o claim. */
  sourceJobId?: string;
}

export function criarEnviadorDeParte(deps: DepsDoEnviador): EnviarParte {
  return async ({ organizationId, conversationId, channelSessionId, autor, parte }): Promise<ResultadoDoEnvioDaParte> => {
    const admin = deps.admin ?? createAdminClient();
    const tipo = tipoDaParte(parte);

    const input = {
      conversation_id: conversationId,
      type: tipo,
      ...(parte.body !== null ? { body: parte.body } : {}),
      ...(parte.media_storage_path !== null
        ? {
            media_storage_path: parte.media_storage_path,
            ...(parte.media_mime !== null ? { media_mime: parte.media_mime } : {}),
            ...(parte.media_size_bytes !== null ? { media_size_bytes: parte.media_size_bytes } : {}),
          }
        : {}),
    } as Parameters<typeof sendMessageHandler>[2];

    try {
      const resultado = (await sendMessageHandler(
        admin,
        {
          organization_id: organizationId,
          actor: atorDoPacote(autor, parte.id),
          requestId: deps.requestId ?? `scheduled_message:${parte.internal_message_id}`,
          internalMessageId: parte.internal_message_id,
          ...(deps.sourceJobId !== undefined ? { sourceJobId: deps.sourceJobId } : {}),
        },
        input,
      )) as { id?: string; status?: string; error_code?: string | null };

      // ⚠️ NÃO embrulhar em `sendWithLedger`: ele inventa um SEGUNDO id de
      // idempotência (a chave do ledger) além do `internal_message_id` da parte,
      // e duas identidades para o mesmo balão divergem na primeira retentativa.
      // A anti-duplicata aqui é UMA só, e é a coluna da parte.
      //
      // O handler já trata o 23505: relê `messages.id = internalMessageId` e
      // devolve a linha. Se ela foi para `failed`, o balão NÃO saiu — devolver
      // `ok` marcaria como enviada uma parte que o canal recusou.
      if (resultado?.status === "failed") {
        return { ok: false, motivo: resultado.error_code ?? "envio_falhou" };
      }
      if (resultado?.id === undefined) {
        return { ok: false, motivo: "envio_sem_recibo" };
      }

      // Contabiliza no teto do número. Falha de gravação é ABERTA por
      // construção: a mensagem JÁ saiu, e derrubar aqui produziria o reenvio que
      // este PR inteiro existe para impedir.
      await registrarEnvioNoLedger(admin, organizationId, channelSessionId);

      return { ok: true, messageId: resultado.id };
    } catch (err) {
      return {
        ok: false,
        motivo: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      };
    }
  };
}

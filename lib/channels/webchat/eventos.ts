/**
 * As respostas da conversa, entregues ao visitante por stream (spec 36, F1, Task 9).
 *
 * A conversa sai do TOKEN de visitante: a organização e a conexão vêm da linha da conexão, e
 * a conversa é a de `channel = 'webchat'`, da conexão, com `provider_conversation_id` igual ao
 * visitante. Nada disso vem de parâmetro do pedido.
 *
 * Entrega só saída de texto que chegou ao estado de envio: `direction = 'outbound'`,
 * `type = 'text'` e estado fora de `failed` e `queued`. Nota interna não entra aqui: ela mora
 * em `conversation_notes`, fora de `messages`. Mensagem `system` tem `type` próprio e fica de
 * fora pelo mesmo filtro.
 *
 * O cursor é opaco e assinado (HMAC, com o prefixo de domínio `deskcomm:webchat-cursor:v1:`):
 * leva `criadoEm` e `id` da última mensagem entregue. Adulterado, ele não lê.
 *
 * O cliente é de service role: toda consulta filtra `organization_id` e `conversation_id` à mão.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";

const PREFIXO_DO_CURSOR = "deskcomm:webchat-cursor:v1:";
const TAMANHO_MAXIMO_DO_CURSOR = 512;
/** Instante como o banco devolve: `2026-11-20T12:00:01.123456+00:00`. Só isto entra no filtro. */
const FORMATO_DO_INSTANTE = /^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})$/;

const DURACAO_DO_STREAM_MS = 60_000;
const INTERVALO_DE_LEITURA_MS = 2_000;
const LIMITE_POR_LEITURA = 50;

/** Estados anteriores a `delivered` que a marcação de entrega aceita. Fila e falha ficam de fora. */
const ESTADOS_ANTERIORES_A_ENTREGUE = ["sending", "sent"];

export interface CursorDeEntrega {
  criadoEm: string;
  id: string;
}

const corpoDoCursorSchema = z
  .object({
    v: z.literal(1),
    criadoEm: z.string().regex(FORMATO_DO_INSTANTE),
    id: z.string().uuid(),
  })
  .strict();

function assinaturaDoCursor(corpo: string): Buffer | null {
  const segredo = process.env.INTERNAL_SECRET;
  if (!segredo?.trim()) return null;
  return createHmac("sha256", segredo).update(`${PREFIXO_DO_CURSOR}${corpo}`).digest();
}

/** O cursor assinado de uma mensagem entregue. Sem `INTERNAL_SECRET` não há como assinar: lança. */
export function assinarCursor(p: CursorDeEntrega): string {
  const corpo = Buffer.from(JSON.stringify({ v: 1, criadoEm: p.criadoEm, id: p.id })).toString("base64url");
  const sig = assinaturaDoCursor(corpo);
  if (!sig) throw new Error("webchat_cursor_secret_missing");
  return `${corpo}.${sig.toString("base64url")}`;
}

/** Lê o cursor. Adulterado, de outro formato ou de outro domínio: `null`. Nunca lança. */
export function lerCursor(valor: string): CursorDeEntrega | null {
  try {
    if (typeof valor !== "string" || valor.length === 0 || valor.length > TAMANHO_MAXIMO_DO_CURSOR) {
      return null;
    }
    const partes = valor.split(".");
    if (partes.length !== 2) return null;
    const [corpo, enviada] = partes;
    if (!corpo || !enviada) return null;

    const esperada = assinaturaDoCursor(corpo);
    if (!esperada) return null;
    const recebida = Buffer.from(enviada, "base64url");
    if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;

    const conteudo: unknown = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
    const lido = corpoDoCursorSchema.safeParse(conteudo);
    if (!lido.success) return null;
    return { criadoEm: lido.data.criadoEm, id: lido.data.id };
  } catch {
    return null;
  }
}

export interface ConversaDoVisitanteParams {
  organizationId: string;
  channelSessionId: string;
  visitanteId: string;
}

/** A conversa deste visitante nesta conexão, ou `null` enquanto ela ainda não existe. */
export async function conversaDoVisitante(
  admin: SupabaseClient,
  p: ConversaDoVisitanteParams,
): Promise<string | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", p.organizationId)
    .eq("channel", "webchat")
    .eq("channel_session_id", p.channelSessionId)
    .eq("provider_conversation_id", p.visitanteId)
    .maybeSingle();
  if (error) throw new Error("webchat_conversa_lookup_failed");
  return (data as { id: string } | null)?.id ?? null;
}

export interface LerSaidasDepoisDeParams {
  organizationId: string;
  conversationId: string;
  cursor: string | null;
  limite: number;
}

export interface SaidaEntregue {
  id: string;
  texto: string;
  em: string;
}

export interface LeituraDeSaidas {
  mensagens: SaidaEntregue[];
  cursor: string | null;
}

/**
 * As mensagens de saída de texto depois do cursor, em ordem de `created_at` e `id`. Sem cursor,
 * desde o começo da conversa. O cursor devolvido é o da última linha lida, ou o próprio cursor
 * recebido quando não há nada novo. Cursor adulterado lança (a rota já o recusou com 400).
 */
export async function lerSaidasDepoisDe(
  admin: SupabaseClient,
  p: LerSaidasDepoisDeParams,
): Promise<LeituraDeSaidas> {
  let consulta = admin
    .from("messages")
    .select("id, body, created_at")
    .eq("organization_id", p.organizationId)
    .eq("conversation_id", p.conversationId)
    .eq("direction", "outbound")
    .eq("type", "text")
    .not("status", "in", "(failed,queued)");

  if (p.cursor !== null) {
    const c = lerCursor(p.cursor);
    if (!c) throw new Error("webchat_cursor_invalido");
    consulta = consulta.or(`created_at.gt.${c.criadoEm},and(created_at.eq.${c.criadoEm},id.gt.${c.id})`);
  }

  const { data, error } = await consulta
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(p.limite);
  if (error) throw new Error("webchat_leitura_de_saidas_falhou");

  const linhas = (data ?? []) as Array<{ id: string; body: string | null; created_at: string }>;
  const mensagens = linhas.map((l) => ({ id: l.id, texto: l.body ?? "", em: l.created_at }));
  const ultima = linhas[linhas.length - 1];
  return {
    mensagens,
    cursor: ultima ? assinarCursor({ criadoEm: ultima.created_at, id: ultima.id }) : p.cursor,
  };
}

export interface MarcarEntreguesParams {
  organizationId: string;
  conversationId: string;
  ids: string[];
  agora: Date;
}

/**
 * Marca como `delivered` o que foi enviado ao visitante. Só grava onde o estado ainda é anterior
 * a `delivered`: uma mensagem já lida, ou que falhou depois, não volta atrás.
 */
export async function marcarEntregues(admin: SupabaseClient, p: MarcarEntreguesParams): Promise<void> {
  if (p.ids.length === 0) return;
  const { error } = await admin
    .from("messages")
    .update({ status: "delivered", delivered_at: p.agora.toISOString() })
    .eq("organization_id", p.organizationId)
    .eq("conversation_id", p.conversationId)
    .in("id", p.ids)
    .in("status", ESTADOS_ANTERIORES_A_ENTREGUE);
  if (error) throw new Error("webchat_marcar_entregue_falhou");
}

export interface AbrirFluxoParams {
  admin: SupabaseClient;
  organizationId: string;
  channelSessionId: string;
  visitanteId: string;
  cursor: string | null;
  sinal?: AbortSignal;
  /** Relógio em milissegundos. Padrão: `Date.now`. Injetável para o teste. */
  relogio?: () => number;
  /** Espera entre leituras. Padrão: `setTimeout`. Injetável para o teste. */
  esperar?: (ms: number) => Promise<void>;
  duracaoMs?: number;
  intervaloMs?: number;
}

/**
 * O stream `text/event-stream` da janela do visitante. Abre com um comentário (força o envio dos
 * cabeçalhos), lê o banco a cada `intervaloMs`, emite cada mensagem como `event: mensagem` e o
 * cursor do lote como `event: cursor`, e marca o que saiu. Fecha ao passar de `duracaoMs`; a
 * janela reabre com o último cursor. Antes de a conversa existir, fica aberto e vazio.
 *
 * Erro de leitura fecha o stream e registra sem detalhe do banco.
 */
export function abrirFluxoDeEventos(p: AbrirFluxoParams): ReadableStream<Uint8Array> {
  const relogio = p.relogio ?? (() => Date.now());
  const duracaoMs = p.duracaoMs ?? DURACAO_DO_STREAM_MS;
  const intervaloMs = p.intervaloMs ?? INTERVALO_DE_LEITURA_MS;
  const esperar =
    p.esperar ?? ((ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms)));
  const codificador = new TextEncoder();
  let parado = false;
  p.sinal?.addEventListener("abort", () => {
    parado = true;
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emitir = (texto: string) => controller.enqueue(codificador.encode(texto));
      const inicio = relogio();
      let cursor = p.cursor;
      let conversaId: string | null = null;

      // Comentário SSE: o cabeçalho sai já, sem esperar a primeira mensagem.
      emitir(": conectado\n\n");
      try {
        while (!parado && relogio() - inicio < duracaoMs) {
          if (conversaId === null) {
            conversaId = await conversaDoVisitante(p.admin, {
              organizationId: p.organizationId,
              channelSessionId: p.channelSessionId,
              visitanteId: p.visitanteId,
            });
          }
          if (conversaId !== null) {
            const leitura = await lerSaidasDepoisDe(p.admin, {
              organizationId: p.organizationId,
              conversationId: conversaId,
              cursor,
              limite: LIMITE_POR_LEITURA,
            });
            if (leitura.mensagens.length > 0 && !parado) {
              for (const m of leitura.mensagens) {
                emitir(`event: mensagem\ndata: ${JSON.stringify({ id: m.id, texto: m.texto, em: m.em })}\n\n`);
              }
              emitir(`event: cursor\ndata: ${JSON.stringify({ cursor: leitura.cursor })}\n\n`);
              cursor = leitura.cursor;
              await marcarEntregues(p.admin, {
                organizationId: p.organizationId,
                conversationId: conversaId,
                ids: leitura.mensagens.map((m) => m.id),
                agora: new Date(relogio()),
              }).catch(() => {
                // Não impede a entrega: o cursor já garante que nada se repete nesta janela.
                logger.error("webchat: não consegui marcar as respostas como entregues", { rota: "eventos" });
              });
            }
          }
          if (parado) break;
          await esperar(intervaloMs);
        }
      } catch {
        logger.error("webchat: falha ao ler as respostas do visitante", { rota: "eventos" });
      }
      try {
        controller.close();
      } catch {
        // Já fechado pelo cancelamento do leitor.
      }
    },
    cancel() {
      parado = true;
    },
  });
}

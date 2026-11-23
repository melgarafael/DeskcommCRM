/**
 * As respostas da conversa, entregues ao visitante por stream (spec 36, F1).
 *
 * A conversa sai do TOKEN de visitante: a organização e a conexão vêm da linha da conexão, e
 * a conversa é a de `channel = 'webchat'`, da conexão, com `provider_conversation_id` igual ao
 * visitante. Nada disso vem de parâmetro do pedido.
 *
 * A entrega é pelo ESTADO da mensagem, sem cursor: a cada leitura saem as mensagens de saída de
 * texto com `status = 'sent'` (ainda não entregues), em ordem de `created_at` e `id`. Depois de
 * escrever cada uma no stream, ela vira `delivered`, e só onde ainda está `sent`. Assim uma
 * mensagem que chega `sent` atrasada, depois de outra mais nova, sai na leitura seguinte, e
 * nada que está `sending` ou `queued` é tocado (é do worker de envio).
 *
 * Nota interna não entra aqui: ela mora em `conversation_notes`, fora de `messages`. Mensagem
 * `system` tem `type` próprio e fica de fora pelo mesmo filtro.
 *
 * O cliente é de service role: toda consulta filtra `organization_id` e `conversation_id` à mão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

const DURACAO_DO_STREAM_MS = 60_000;
const INTERVALO_DE_LEITURA_MS = 2_000;
const LIMITE_POR_LEITURA = 50;

export interface ConversaDoVisitanteParams {
  organizationId: string;
  channelSessionId: string;
  visitanteId: string;
}

/**
 * A conversa deste visitante nesta conexão, ou `null` enquanto ela ainda não existe. Se houver
 * mais de uma (o visitante voltou depois de o contato ser anonimizado, e a ingestão abriu conversa
 * nova), vale a MAIS RECENTE: é a que a ingestão usa para o contato vivo. A leitura é ordenada e
 * cortada em 1, sem `maybeSingle` que quebraria com duas.
 */
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
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("webchat_conversa_lookup_failed");
  const linhas = (data ?? []) as Array<{ id: string }>;
  return linhas[0]?.id ?? null;
}

export interface SaidaParaEntregar {
  id: string;
  texto: string;
  em: string;
}

export interface LerSaidasNovasParams {
  organizationId: string;
  conversationId: string;
  limite: number;
}

/**
 * As saídas de texto ainda não entregues (`status = 'sent'`), em ordem de `created_at` e `id`.
 * Sending e queued ficam de fora: ainda estão com o worker de envio. Delivered também: já saíram.
 */
export async function lerSaidasNovas(
  admin: SupabaseClient,
  p: LerSaidasNovasParams,
): Promise<SaidaParaEntregar[]> {
  const { data, error } = await admin
    .from("messages")
    .select("id, body, created_at")
    .eq("organization_id", p.organizationId)
    .eq("conversation_id", p.conversationId)
    .eq("direction", "outbound")
    .eq("type", "text")
    .eq("status", "sent")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(p.limite);
  if (error) throw new Error("webchat_leitura_de_saidas_falhou");

  const linhas = (data ?? []) as Array<{ id: string; body: string | null; created_at: string }>;
  return linhas.map((l) => ({ id: l.id, texto: l.body ?? "", em: l.created_at }));
}

export interface MarcarEntregueParams {
  organizationId: string;
  conversationId: string;
  id: string;
  agora: Date;
}

/**
 * Marca UMA mensagem como `delivered`, e só se ela ainda está `sent`. Se o worker ou outro
 * processo já a mexeu, o UPDATE não casa e nada muda.
 */
export async function marcarEntregue(admin: SupabaseClient, p: MarcarEntregueParams): Promise<void> {
  const { error } = await admin
    .from("messages")
    .update({ status: "delivered", delivered_at: p.agora.toISOString() })
    .eq("organization_id", p.organizationId)
    .eq("conversation_id", p.conversationId)
    .eq("id", p.id)
    .eq("status", "sent");
  if (error) throw new Error("webchat_marcar_entregue_falhou");
}

export interface AbrirFluxoParams {
  admin: SupabaseClient;
  organizationId: string;
  channelSessionId: string;
  visitanteId: string;
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
 * cabeçalhos), lê o banco a cada `intervaloMs`, emite cada saída `sent` como `event: mensagem` e
 * a marca `delivered` logo depois de escrevê-la. Fecha ao passar de `duracaoMs`; a janela reabre
 * e recebe o que ainda estiver `sent`. Antes de a conversa existir, fica aberto e vazio.
 *
 * Desconexão normal (cancelamento ou aborto) não registra erro. Erro de leitura registra sem
 * detalhe do banco.
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
      // Nada sai depois de encerrado. Um enfileirar que falha aqui é desconexão, não erro.
      const emitir = (texto: string): boolean => {
        if (parado) return false;
        try {
          controller.enqueue(codificador.encode(texto));
          return true;
        } catch {
          parado = true;
          return false;
        }
      };
      const inicio = relogio();
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
            const novas = await lerSaidasNovas(p.admin, {
              organizationId: p.organizationId,
              conversationId: conversaId,
              limite: LIMITE_POR_LEITURA,
            });
            for (const m of novas) {
              if (!emitir(`event: mensagem\ndata: ${JSON.stringify({ id: m.id, texto: m.texto, em: m.em })}\n\n`)) {
                break;
              }
              await marcarEntregue(p.admin, {
                organizationId: p.organizationId,
                conversationId: conversaId,
                id: m.id,
                agora: new Date(relogio()),
              }).catch(() => {
                logger.error("webchat: não consegui marcar a resposta como entregue", { rota: "eventos" });
              });
            }
          }
          if (parado) break;
          await esperar(intervaloMs);
        }
      } catch {
        if (!parado) logger.error("webchat: falha ao ler as respostas do visitante", { rota: "eventos" });
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

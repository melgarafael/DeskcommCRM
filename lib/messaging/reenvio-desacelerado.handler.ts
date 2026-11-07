/**
 * A NOVA TENTATIVA DA MENSAGEM QUE O CANAL MANDOU DESACELERAR — na mesma linha.
 *
 * O porquê de existir está em `./reenvio-desacelerado.ts`: o envio grava `queued`
 * quando o canal pede para ir devagar (`adapter.codes.throttled`), e nada mandava
 * de novo. Este consumidor manda, pelo MESMO caminho do envio
 * (`sendMessageHandler` com `internalMessageId`, o mesmo do `POST
 * /messages/{id}/retry`): a linha `queued` é reaproveitada, todas as guardas do
 * envio rodam de novo — contato bloqueado, canal pausado ou arquivado, modo de
 * teste, janela de 24h para quem não é pessoa — e nenhuma bolha nova nasce.
 *
 * ─── O que impede o envio em dobro ──────────────────────────────────────────
 *
 * 1. Só age enquanto a linha ainda é `queued` COM o motivo do pedido. Quem
 *    reenviou antes (a pessoa pelo botão, que tira o motivo; a própria cadeia)
 *    já mudou isso.
 * 2. A trava é a da rota de reenvio: um UPDATE que tira o motivo e só pega se a
 *    linha estiver exatamente como foi lida (`updated_at`). Dois consumidores,
 *    ou o consumidor e o botão, produzem um envio só — e sem motivo a regra do
 *    botão (`./reenvio.ts`) lê a linha como "em voo".
 * 3. Só para quem não tem outro dono de nova tentativa
 *    (`reenvioDesaceleradoAtende`). A pessoa (`user`) e o agente (`ai`) não
 *    têm. Campanha, automação e integração (`automation`, `system`) têm o
 *    próprio laço — e o envio nem grava `queued` para elas —, e dois donos são
 *    duas mensagens.
 * 4. Mensagem do agente cujo turno ainda está na fila ou rodando espera: o
 *    turno é dono enquanto vive (o livro-razão dele reenvia a mesma linha).
 *
 * ─── O ritmo ────────────────────────────────────────────────────────────────
 *
 * - espera o que o canal pediu (`Retry-After`), entre 30 s e 5 min; sem pedido,
 *   1 min — o limite por destinatário da plataforma é de ~10 por minuto;
 * - mensagens da mesma conversa saem na ORDEM em que foram escritas: a de trás
 *   espera a da frente que também espera o canal — nunca uma presa por outro
 *   motivo, e no máximo `TETO_DA_ESPERA_DA_FILA_MS`;
 * - no máximo `MAX_REENVIOS` tentativas; depois, `failed` com o motivo, e a
 *   falha segue o caminho de toda falha de envio (`message.failed`). Cada nova
 *   desaceleração emite o seu próprio pedido, então a contagem mora na linha.
 *
 * Organização parada: pula — reenviar é falar para fora.
 */
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { emitirFalhaDeEntrega } from "@/lib/messaging/falha-de-entrega";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import type { SendMessageInput } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

import { EVENTO_REENVIO_DESACELERADO, reenvioDesaceleradoAtende } from "./reenvio-desacelerado";

const CONSUMER_KEY = "messages.reenvio_desacelerado";
export const ESPERA_PADRAO_MS = 60_000;
export const ESPERA_MINIMA_MS = 30_000;
export const ESPERA_MAXIMA_MS = 5 * 60_000;
/** Quanto a de trás espera a da frente da mesma conversa. */
export const ESPERA_DA_FILA_MS = 15_000;
/** Quanto a mensagem do agente espera o turno que ainda é dono dela. */
export const ESPERA_DO_TURNO_MS = 30_000;
export const MAX_REENVIOS = 4;
/** A mensagem da frente só segura a de trás se foi escrita há pouco — uma presa há dias não trava a conversa. */
const JANELA_DA_FILA_MS = 30 * 60_000;
/** E a de trás não espera a da frente para sempre: passado isto desde o pedido, segue sozinha. */
export const TETO_DA_ESPERA_DA_FILA_MS = 10 * 60_000;

const TIPOS_DE_MIDIA = new Set(["image", "audio", "video", "document"]);

interface LinhaDaMensagem {
  id: string;
  conversation_id: string;
  contact_id: string | null;
  direction: string;
  status: string;
  type: string;
  body: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  reply_to_message_id: string | null;
  sent_via: string | null;
  sent_by_user_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const COLUNAS =
  "id, conversation_id, contact_id, direction, status, type, body, media_storage_path, media_mime, media_size_bytes, reply_to_message_id, sent_via, sent_by_user_id, metadata, created_at, updated_at";

const resultado = (status: HandlerResult["status"], detail: string, retryAt?: number): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
  ...(retryAt !== undefined ? { retry_at: new Date(retryAt).toISOString() } : {}),
});

/** A espera pedida, dentro da faixa: nem martelar o canal, nem segurar a resposta por meia hora. */
export function esperaDoPedido(esperaMs: unknown): number {
  const pedida = typeof esperaMs === "number" && Number.isFinite(esperaMs) && esperaMs > 0 ? esperaMs : ESPERA_PADRAO_MS;
  return Math.min(ESPERA_MAXIMA_MS, Math.max(ESPERA_MINIMA_MS, pedida));
}

/** O que mandar de novo, lido da própria linha — ou `null` quando não dá para reconstruir. */
function corpoDoReenvio(organizationId: string, m: LinhaDaMensagem): SendMessageInput | null {
  if (m.type === "text") {
    if (!m.body) return null;
    return {
      conversation_id: m.conversation_id,
      type: "text",
      body: m.body,
      ...(m.reply_to_message_id ? { reply_to_message_id: m.reply_to_message_id } : {}),
    } as SendMessageInput;
  }
  // Mídia só da pasta desta conversa — a mesma regra do handler e do botão de
  // reenvio. A de fora seria recusada lá, e a recusa marcaria `failed` uma
  // mensagem que só estava esperando.
  if (
    TIPOS_DE_MIDIA.has(m.type) &&
    m.media_storage_path &&
    isMediaPathOwnedBy(m.media_storage_path, organizationId, m.conversation_id)
  ) {
    return {
      conversation_id: m.conversation_id,
      type: m.type,
      media_storage_path: m.media_storage_path,
      ...(m.media_mime ? { media_mime: m.media_mime } : {}),
      ...(m.media_size_bytes ? { media_size_bytes: m.media_size_bytes } : {}),
      ...(m.body ? { body: m.body } : {}),
      ...(m.reply_to_message_id ? { reply_to_message_id: m.reply_to_message_id } : {}),
    } as SendMessageInput;
  }
  return null;
}

function atorDoReenvio(m: LinhaDaMensagem): Parameters<typeof sendMessageHandler>[1]["actor"] | null {
  if (!reenvioDesaceleradoAtende(m.sent_via)) return null;
  if (m.sent_via === "user") return m.sent_by_user_id ? { type: "user", id: m.sent_by_user_id } : null;
  if (m.sent_via === "ai") {
    // O mesmo id que o envio original gravou (`metadata.ai_actor_id`): é dele que
    // sai a assinatura "por agente", e a nova tentativa não pode trocar quem assina.
    const id = typeof m.metadata?.ai_actor_id === "string" ? m.metadata.ai_actor_id : "agent-engine";
    return { type: "ai_agent", id, role: "manager" };
  }
  return null;
}

async function turnoAindaEDono(admin: SupabaseClient, organizationId: string, messageId: string): Promise<boolean> {
  const { data: livro } = await admin
    .from("send_ledger")
    .select("job_id")
    .eq("organization_id", organizationId)
    .eq("crm_message_id", messageId)
    .limit(1)
    .maybeSingle();
  const jobId = (livro as { job_id?: string } | null)?.job_id;
  if (!jobId) return false;
  const { data: job } = await admin
    .from("job_queue")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("id", jobId)
    .maybeSingle();
  const status = (job as { status?: string } | null)?.status;
  return status === "pending" || status === "running";
}

/**
 * Há, na mesma conversa, uma mensagem escrita ANTES desta que também espera o
 * canal desacelerar (com o motivo, ou travada por outra nova tentativa)?
 *
 * Só essa segura a de trás. Uma `queued` por outro motivo (canal fora, sem
 * credencial) não tem previsão de sair, e esperá-la travaria a conversa.
 */
async function haUmaNaFrente(
  admin: SupabaseClient,
  organizationId: string,
  m: LinhaDaMensagem,
  motivo: string,
): Promise<boolean> {
  const { data } = await admin
    .from("messages")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .eq("conversation_id", m.conversation_id)
    .eq("direction", "outbound")
    .eq("status", "queued")
    .neq("id", m.id)
    .lt("created_at", m.created_at)
    .gt("created_at", new Date(Date.parse(m.created_at) - JANELA_DA_FILA_MS).toISOString())
    .limit(20);
  return ((data as { metadata?: Record<string, unknown> | null }[] | null) ?? []).some(
    (r) => r.metadata?.queued_reason === motivo || typeof r.metadata?.reenvios_automaticos === "number",
  );
}

/** Sem a trava (o motivo já saiu da linha), grava a falha — e só se ninguém mexeu nela depois. */
async function marcarFalha(
  admin: SupabaseClient,
  organizationId: string,
  m: LinhaDaMensagem,
  falha: { codigo: string; mensagem: string },
  travadaEm: string | null,
): Promise<void> {
  let q = admin
    .from("messages")
    .update({ status: "failed", error_code: falha.codigo, error_message: falha.mensagem })
    .eq("organization_id", organizationId)
    .eq("id", m.id)
    .eq("status", "queued");
  if (travadaEm) q = q.eq("updated_at", travadaEm);
  const { data } = await q.select("id");
  if (((data as unknown[] | null) ?? []).length === 0) return;
  await emitirFalhaDeEntrega(admin, {
    organizationId,
    source: "reenvio-desacelerado",
    falha: {
      message_id: m.id,
      conversation_id: m.conversation_id,
      contact_id: m.contact_id,
      contact: null,
      sent_via: m.sent_via,
      erro: { codigo: falha.codigo, titulo: falha.mensagem },
    },
  });
}

export async function tratarReenvioDesacelerado(
  row: EventRow,
  deps: { admin?: SupabaseClient; agora?: () => number; enviar?: typeof sendMessageHandler } = {},
): Promise<HandlerResult> {
  const agora = deps.agora?.() ?? Date.now();
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const messageId = typeof p.message_id === "string" ? p.message_id : null;
  const motivo = typeof p.queued_reason === "string" ? p.queued_reason : null;
  if (!messageId || !motivo) return resultado("skipped", "payload_incompleto");

  // Sem a hora do evento, tenta já: esperar sem relógio seria esperar para sempre.
  const criadoEm = row.created_at ? Date.parse(row.created_at) : agora;
  const quando = criadoEm + esperaDoPedido(p.espera_ms);
  if (agora < quando) return resultado("retry", "esperando_o_canal", quando);

  const admin = deps.admin ?? createAdminClient();
  // ⚠️ Service role: a organização vem do EVENTO, nunca do payload.
  const org = row.organization_id;
  const { data, error } = await admin
    .from("messages")
    .select(COLUNAS)
    .eq("organization_id", org)
    .eq("id", messageId)
    .maybeSingle();
  if (error) return resultado("retry", `leitura da mensagem falhou: ${error.message}`, agora + ESPERA_PADRAO_MS);
  const m = data as LinhaDaMensagem | null;
  if (!m) return resultado("skipped", "mensagem_inexistente");
  if (m.direction !== "outbound" || m.status !== "queued" || m.metadata?.queued_reason !== motivo) {
    return resultado("skipped", "ja_nao_espera");
  }

  const ator = atorDoReenvio(m);
  if (!ator) return resultado("skipped", "tem_outro_dono");
  const corpo = corpoDoReenvio(org, m);
  if (!corpo) return resultado("skipped", "conteudo_nao_reenviavel");

  if (m.sent_via === "ai" && (await turnoAindaEDono(admin, org, m.id))) {
    return resultado("retry", "turno_ainda_e_dono", agora + ESPERA_DO_TURNO_MS);
  }
  if (agora - criadoEm < TETO_DA_ESPERA_DA_FILA_MS && (await haUmaNaFrente(admin, org, m, motivo))) {
    return resultado("retry", "espera_a_da_frente", agora + ESPERA_DA_FILA_MS);
  }

  const tentativas = typeof m.metadata?.reenvios_automaticos === "number" ? m.metadata.reenvios_automaticos : 0;
  if (tentativas >= MAX_REENVIOS) {
    await marcarFalha(
      admin,
      org,
      m,
      {
        codigo: motivo,
        mensagem: "O canal limitou o ritmo de envio e a mensagem não saiu nas novas tentativas automáticas.",
      },
      null,
    );
    return resultado("ok", "desistiu");
  }

  // A TRAVA: tira o motivo (a regra do botão passa a ler "em voo") e conta a
  // tentativa, só se a linha está como foi lida.
  const resto = Object.fromEntries(
    Object.entries(m.metadata ?? {}).filter(([k]) => k !== "queued_reason" && k !== "reenvios_automaticos"),
  );
  const { data: travada } = await admin
    .from("messages")
    .update({ metadata: { ...resto, reenvios_automaticos: tentativas + 1 } })
    .eq("organization_id", org)
    .eq("id", m.id)
    .eq("status", "queued")
    .eq("updated_at", m.updated_at)
    .select("id, updated_at")
    .maybeSingle();
  if (!travada) return resultado("skipped", "outro_reenvio_em_curso");
  const travadaEm = (travada as { updated_at: string }).updated_at;

  const enviar = deps.enviar ?? sendMessageHandler;
  try {
    const enviada = await enviar(
      admin,
      {
        organization_id: org,
        actor: ator,
        requestId: `reenvio-desacelerado:${m.id}:${tentativas + 1}`,
        internalMessageId: m.id,
      },
      corpo,
    );
    // `queued` de novo: o canal desacelerou outra vez, e o envio já emitiu o
    // próximo pedido. `failed`: o envio gravou a falha e o porquê.
    return resultado("ok", `reenvio_${enviada.status}`);
  } catch (err) {
    if (err instanceof ApiError) {
      // Recusa ANTES de tocar o canal (contato bloqueado, canal arquivado, janela
      // fechada…): a mensagem não vai sair, e dizer isso é melhor que deixá-la
      // esperando para sempre sem motivo.
      await marcarFalha(admin, org, m, { codigo: err.code, mensagem: err.message }, travadaEm);
      return resultado("ok", `recusado_${err.code}`);
    }
    // Erro inesperado (rede, banco): devolve o motivo para o próximo tique —
    // e só se ninguém mexeu na linha depois da trava.
    await admin
      .from("messages")
      .update({ metadata: { ...resto, reenvios_automaticos: tentativas + 1, queued_reason: motivo } })
      .eq("organization_id", org)
      .eq("id", m.id)
      .eq("status", "queued")
      .eq("updated_at", travadaEm);
    logger.warn("[reenvio-desacelerado] a nova tentativa lançou", {
      organization_id: org,
      message_id: m.id,
      detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return resultado("retry", "falha_transitoria", agora + ESPERA_PADRAO_MS);
  }
}

export const reenvioDesaceleradoHandler: EventHandler = {
  key: CONSUMER_KEY,
  // Reenviar é falar com o cliente: numa organização parada, não.
  naOrgParada: "pula",
  events: [EVENTO_REENVIO_DESACELERADO],
  handle: (row) => tratarReenvioDesacelerado(row),
};

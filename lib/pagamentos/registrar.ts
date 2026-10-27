/**
 * REGISTRAR O LINK NA CONVERSA (issue #3509, degrau 1 — item 2).
 *
 * ─── O que a atendente faz, e o que o código faz ────────────────────────────
 *
 * Ela cola o link no aplicativo do meio de pagamento, manda para o cliente pelo
 * Inbox (fluxo de envio de sempre) e clica em "registrar pagamento" na mensagem.
 * A partir daí o link é DADO: a conversa mostra valor e estado, e o aviso do
 * provedor sabe qual negócio mover.
 *
 * Nada aqui envia mensagem, e isso não é limitação — é a cadeia anti-banimento
 * do produto: quem envia é uma pessoa, sempre. O registro é posterior ao envio
 * de propósito, e é o que permite a conferência abaixo existir.
 *
 * ─── As três guardas, e por que cada uma ────────────────────────────────────
 *
 * 1. A MENSAGEM É DESTA CONVERSA E DESTA ORGANIZAÇÃO (`organization_id` +
 *    `conversation_id` no filtro): registrar por id alheio gravando no próprio
 *    tenant seria cross-tenant por id — o defeito que a 0036 fecha nas policies.
 * 2. O LINK ESTÁ NO CORPO DA MENSAGEM: sem isso o CRM guardaria um pagamento que
 *    ninguém mandou ao cliente, e o aviso de "pago" chegaria para um link que
 *    nunca saiu daqui.
 * 3. É OUTBOUND: link que o CLIENTE mandou não é cobrança nossa.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *
 * Clicar duas vezes no botão (ou o retry da tela) não pode dar 409 nem duplicar:
 * se a mesma mensagem já tem aquele pagamento, o resultado é o mesmo registro,
 * com `reutilizado: true`. A chave é o índice único
 * `(organization_id, provedor, external_id)` da 9026 — o mesmo que faz o aviso
 * repetido do provedor não criar linha nova.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { MOEDA_PADRAO } from "@/lib/money";

import {
  CHAVE_DO_METADADO,
  idExternoAceitavel,
  lerPagamentoDoMetadado,
  linkAceitavel,
  mensagemContemOLink,
  metadadoDoPagamento,
  type PagamentoNaMensagem,
} from "./link";
import {
  TAMANHO_MAXIMO_DO_ID_EXTERNO,
  VALOR_MAXIMO_CENTS,
  type ProvedorDeRecebimento,
  type SituacaoDoRecebimento,
} from "./vocabulario";

export interface Recebimento {
  id: string;
  organization_id: string;
  conversation_id: string;
  message_id: string | null;
  lead_id: string | null;
  provedor: string;
  external_id: string;
  valor_cents: number;
  moeda: string;
  status: SituacaoDoRecebimento;
  pago_em: string | null;
}

export interface EntradaDoRegistro {
  organizationId: string;
  conversationId: string;
  messageId: string;
  provedor: ProvedorDeRecebimento;
  externalId: string;
  valorCents: number;
  moeda?: string;
  link: string;
}

export type ResultadoDoRegistro =
  | { ok: true; recebimento: Recebimento; pagamento: PagamentoNaMensagem; reutilizado: boolean }
  | {
      ok: false;
      code: "validation_failed" | "not_found" | "state_conflict" | "internal_error";
      message: string;
      status: 400 | 404 | 409 | 422 | 500;
      details?: unknown;
    };

const COLUNAS: string = [
  "id",
  "organization_id",
  "conversation_id",
  "message_id",
  "lead_id",
  "provedor",
  "external_id",
  "valor_cents",
  "moeda",
  "status",
  "pago_em",
].join(", ");

interface MensagemLida {
  id: string;
  conversation_id: string;
  contact_id: string | null;
  direction: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
}

export async function registrarLinkDoPagamento(
  admin: SupabaseClient,
  entrada: EntradaDoRegistro,
): Promise<ResultadoDoRegistro> {
  const link = entrada.link.trim();
  const idExterno = entrada.externalId.trim();
  const moeda = (entrada.moeda ?? MOEDA_PADRAO).toUpperCase();

  if (!linkAceitavel(link)) {
    return recusa("validation_failed", 422, "O link precisa ser um endereço https válido.", {
      campo: "link",
    });
  }
  if (!idExternoAceitavel(idExterno)) {
    return recusa("validation_failed", 422, "O identificador do pagamento no provedor é inválido.", {
      campo: "id_externo",
      limite: TAMANHO_MAXIMO_DO_ID_EXTERNO,
    });
  }
  if (!Number.isInteger(entrada.valorCents) || entrada.valorCents <= 0 || entrada.valorCents > VALOR_MAXIMO_CENTS) {
    return recusa("validation_failed", 422, "O valor precisa ser maior que zero e caber no teto.", {
      campo: "valor_cents",
      limite: VALOR_MAXIMO_CENTS,
    });
  }

  // ── 1. A mensagem, no escopo certo ────────────────────────────────────────
  const { data: mensagemBruta, error: erroDaMensagem } = await admin
    .from("messages")
    .select("id, conversation_id, contact_id, direction, body, metadata")
    .eq("organization_id", entrada.organizationId)
    .eq("conversation_id", entrada.conversationId)
    .eq("id", entrada.messageId)
    .maybeSingle();
  if (erroDaMensagem) {
    logger.error("[pagamentos.registrar] mensagem ilegível", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      codigo: erroDaMensagem.code ?? null,
    });
    return recusa("internal_error", 500, "Não foi possível ler a mensagem.");
  }
  const mensagem = mensagemBruta as MensagemLida | null;
  if (!mensagem) {
    return recusa("not_found", 404, "Mensagem não encontrada nesta conversa.");
  }
  if (mensagem.direction !== "outbound") {
    return recusa("validation_failed", 422, "Só um link ENVIADO por nós pode ser registrado.", {
      campo: "mensagem_id",
    });
  }
  if (!mensagemContemOLink(mensagem.body, link)) {
    return recusa("validation_failed", 422, "O link não está no corpo desta mensagem.", {
      campo: "link",
    });
  }

  // O negócio aberto do CONTATO é o candidato a ser movido quando o pagamento
  // confirmar. Nenhum ou mais de um: `lead_id` fica nulo — escolher sozinho entre
  // dois negócios do mesmo contato é adivinhação (`lib/inbox/
  // negocio-aberto-do-contato.ts` diz o mesmo, e pelo mesmo motivo).
  const leadId = await negocioAbertoUnico(admin, entrada.organizationId, mensagem.contact_id);

  // ── 2. O registro: a verdade ──────────────────────────────────────────────
  const jaNaMensagem = lerPagamentoDoMetadado(mensagem.metadata);
  if (jaNaMensagem && jaNaMensagem.id === idExterno && jaNaMensagem.provedor === entrada.provedor) {
    const existente = await lerRecebimento(admin, entrada.organizationId, mensagem.id);
    if (existente) {
      return { ok: true, recebimento: existente, pagamento: jaNaMensagem, reutilizado: true };
    }
  }

  const { data: inserido, error: erroDoInsert } = await admin
    .from("pagamento_recebimentos")
    .insert({
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      message_id: mensagem.id,
      lead_id: leadId,
      provedor: entrada.provedor,
      external_id: idExterno,
      valor_cents: entrada.valorCents,
      moeda,
      status: "pendente",
    })
    .select(COLUNAS)
    .single();

  let recebimento = inserido as Recebimento | null;
  let reutilizado = false;

  if (erroDoInsert || !recebimento) {
    if (erroDoInsert?.code !== "23505") {
      logger.error("[pagamentos.registrar] recebimento não gravado", {
        organization_id: entrada.organizationId,
        provedor: entrada.provedor,
        codigo: erroDoInsert?.code ?? null,
      });
      return recusa("internal_error", 500, "Não foi possível registrar o pagamento.");
    }
    // 23505 = o índice único. Duas causas, e elas NÃO são a mesma coisa:
    const existente = await lerPorChaveExterna(admin, entrada.organizationId, entrada.provedor, idExterno);
    if (!existente) return recusa("internal_error", 500, "Não foi possível registrar o pagamento.");
    if (existente.message_id && existente.message_id !== mensagem.id) {
      return recusa("state_conflict", 409, "Este pagamento já foi registrado em outra mensagem.", {
        recebimento_id: existente.id,
        conversation_id: existente.conversation_id,
      });
    }
    recebimento = existente;
    reutilizado = true;
  }

  // ── 3. O ponteiro na mensagem: o que a conversa mostra ────────────────────
  const pagamento = metadadoDoPagamento({
    provedor: recebimento.provedor,
    id: recebimento.external_id,
    valor: recebimento.valor_cents,
    moeda: recebimento.moeda,
    status: recebimento.status,
    recebimento_id: recebimento.id,
  });
  const patch = await gravarMetadado(admin, entrada.organizationId, mensagem, pagamento);
  if (!patch.ok) {
    // O registro existe; o ponteiro não. Recusa ALTA para a tela poder repetir —
    // e o retry cai no caminho `reutilizado` acima, que regrava o ponteiro.
    return recusa("internal_error", 500, "Pagamento registrado, mas a conversa não foi atualizada. Repita.");
  }

  return { ok: true, recebimento, pagamento, reutilizado };
}

/**
 * Grava `metadata.pagamento` preservando o resto do metadata.
 *
 * `metadata` é do cliente (o envio aceita metadata livre): sobrescrever o objeto
 * inteiro apagaria `queued_reason`, `sent_on_behalf`, `media` etc. — o balão
 * perderia o que já sabia para ganhar o que acabou de saber.
 */
async function gravarMetadado(
  admin: SupabaseClient,
  organizationId: string,
  mensagem: MensagemLida,
  pagamento: PagamentoNaMensagem,
): Promise<{ ok: boolean }> {
  const metadata = { ...(mensagem.metadata ?? {}), [CHAVE_DO_METADADO]: pagamento };
  const { error } = await admin
    .from("messages")
    .update({ metadata })
    .eq("organization_id", organizationId)
    .eq("id", mensagem.id);
  if (error) {
    logger.error("[pagamentos.registrar] metadata da mensagem não gravado", {
      organization_id: organizationId,
      codigo: error.code ?? null,
    });
    return { ok: false };
  }
  return { ok: true };
}

async function negocioAbertoUnico(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;
  const { data, error } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .limit(2);
  if (error) {
    // Sem o vínculo o registro continua válido: o aviso marca pago e o humano
    // move. Perder a linha toda por causa do vínculo seria pior.
    logger.warn("[pagamentos.registrar] negócio aberto ilegível", {
      organization_id: organizationId,
      codigo: error.code ?? null,
    });
    return null;
  }
  const ids = (data ?? []) as Array<{ id: string }>;
  return ids.length === 1 ? ids[0]!.id : null;
}

async function lerRecebimento(
  admin: SupabaseClient,
  organizationId: string,
  messageId: string,
): Promise<Recebimento | null> {
  const { data } = await admin
    .from("pagamento_recebimentos")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("message_id", messageId)
    .limit(1)
    .maybeSingle();
  return (data as Recebimento | null) ?? null;
}

async function lerPorChaveExterna(
  admin: SupabaseClient,
  organizationId: string,
  provedor: string,
  externalId: string,
): Promise<Recebimento | null> {
  const { data } = await admin
    .from("pagamento_recebimentos")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provedor", provedor)
    .eq("external_id", externalId)
    .maybeSingle();
  return (data as Recebimento | null) ?? null;
}

function recusa(
  code: "validation_failed" | "not_found" | "state_conflict" | "internal_error",
  status: 400 | 404 | 409 | 422 | 500,
  message: string,
  details?: unknown,
): ResultadoDoRegistro {
  return { ok: false, code, message, status, ...(details === undefined ? {} : { details }) };
}

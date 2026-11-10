/**
 * REGISTRAR O RECEBIMENTO NA CONVERSA (issue #3509, degrau 1 — item 2).
 *
 * ─── O que a atendente faz, e o que o código faz ────────────────────────────
 *
 * 1. Na conversa, ela registra o valor a cobrar. O CRM cria o recebimento
 *    (`pendente`) e devolve o ENDEREÇO DE AVISO deste recebimento.
 * 2. No aplicativo do meio de pagamento, ela cria o link e cola esse endereço
 *    como "URL do Webhook". Manda o link ao cliente pelo Inbox, como sempre.
 * 3. Quando o cliente paga, o provedor chama o endereço, e o recebimento vira
 *    `paga` sem ninguém digitar nada (`lib/pagamentos/confirmar.ts`).
 *
 * O registro vem ANTES do link porque é o único jeito de o aviso saber de qual
 * recebimento fala: o id do pagamento que o provedor manda no aviso não existe
 * quando o link é criado (medido na InfinitePay em 31/10 e 03/11/2026), e a URL
 * configurada volta inteira em todo aviso.
 *
 * Nada aqui envia mensagem: quem envia é uma pessoa, sempre (cadeia
 * anti-banimento do produto).
 *
 * ─── A guarda ───────────────────────────────────────────────────────────────
 *
 * A CONVERSA É DESTA ORGANIZAÇÃO (`organization_id` no filtro): registrar por id
 * alheio gravando no próprio tenant seria cross-tenant por id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { MOEDA_PADRAO } from "@/lib/money";

import { novoTokenDoAviso } from "./assinatura";
import { VALOR_MAXIMO_CENTS, type ProvedorDeRecebimento, type SituacaoDoRecebimento } from "./vocabulario";

export interface Recebimento {
  id: string;
  organization_id: string;
  conversation_id: string;
  lead_id: string | null;
  provedor: string;
  external_id: string | null;
  valor_cents: number;
  moeda: string;
  status: SituacaoDoRecebimento;
  pago_em: string | null;
}

export const COLUNAS_DO_RECEBIMENTO: string = [
  "id",
  "organization_id",
  "conversation_id",
  "lead_id",
  "provedor",
  "external_id",
  "valor_cents",
  "moeda",
  "status",
  "pago_em",
].join(", ");

export interface EntradaDoRegistro {
  organizationId: string;
  conversationId: string;
  provedor: ProvedorDeRecebimento;
  valorCents: number;
  moeda?: string;
}

export type ResultadoDoRegistro =
  /** `token` é o texto do segredo: vai na URL entregue AGORA e não é guardado. */
  | { ok: true; recebimento: Recebimento; token: string }
  | {
      ok: false;
      code: "validation_failed" | "not_found" | "internal_error";
      message: string;
      status: 404 | 422 | 500;
      details?: unknown;
    };

export async function registrarRecebimento(
  admin: SupabaseClient,
  entrada: EntradaDoRegistro,
): Promise<ResultadoDoRegistro> {
  const moeda = (entrada.moeda ?? MOEDA_PADRAO).toUpperCase();
  if (!Number.isInteger(entrada.valorCents) || entrada.valorCents <= 0 || entrada.valorCents > VALOR_MAXIMO_CENTS) {
    return recusa("validation_failed", 422, "O valor precisa ser maior que zero e caber no teto.", {
      campo: "valor_cents",
      limite: VALOR_MAXIMO_CENTS,
    });
  }

  const { data: conversaBruta, error: erroDaConversa } = await admin
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", entrada.organizationId)
    .eq("id", entrada.conversationId)
    .maybeSingle();
  if (erroDaConversa) {
    logger.error("[pagamentos.registrar] conversa ilegível", {
      organization_id: entrada.organizationId,
      codigo: erroDaConversa.code ?? null,
    });
    return recusa("internal_error", 500, "Não foi possível ler a conversa.");
  }
  const conversa = conversaBruta as { id: string; contact_id: string | null } | null;
  if (!conversa) return recusa("not_found", 404, "Conversa não encontrada.");

  // O negócio aberto do CONTATO é o candidato a ser movido quando o pagamento
  // confirmar. Nenhum ou mais de um: `lead_id` fica nulo — escolher sozinho entre
  // dois negócios do mesmo contato é adivinhação.
  const leadId = await negocioAbertoUnico(admin, entrada.organizationId, conversa.contact_id);

  const { token, hash } = novoTokenDoAviso();
  const { data: inserido, error: erroDoInsert } = await admin
    .from("pagamento_recebimentos")
    .insert({
      organization_id: entrada.organizationId,
      conversation_id: conversa.id,
      lead_id: leadId,
      provedor: entrada.provedor,
      aviso_token_hash: hash,
      valor_cents: entrada.valorCents,
      moeda,
      status: "pendente",
    })
    .select(COLUNAS_DO_RECEBIMENTO)
    .single();
  if (erroDoInsert || !inserido) {
    logger.error("[pagamentos.registrar] recebimento não gravado", {
      organization_id: entrada.organizationId,
      provedor: entrada.provedor,
      codigo: erroDoInsert?.code ?? null,
    });
    return recusa("internal_error", 500, "Não foi possível registrar o pagamento.");
  }
  return { ok: true, recebimento: inserido as unknown as Recebimento, token };
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

function recusa(
  code: "validation_failed" | "not_found" | "internal_error",
  status: 404 | 422 | 500,
  message: string,
  details?: unknown,
): ResultadoDoRegistro {
  return { ok: false, code, message, status, ...(details === undefined ? {} : { details }) };
}

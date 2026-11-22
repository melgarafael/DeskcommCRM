import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "../phone-variants";

/**
 * "Este número foi apagado a pedido?" — para o LOTE que a agenda do app entrega
 * de uma vez (`smb_app_state_sync` → `state_sync[]`, vários contatos).
 *
 * A pergunta unitária existe desde a 0750 (`fn_titular_apagado_a_pedido`) e é a
 * régua do importador de histórico (`lib/channels/historico/rodada.ts`), porque
 * lá o laço é um número por rodada. Aqui não: um webhook pode trazer dezenas de
 * contatos, e perguntar dentro do laço pagava um round-trip por contato — o
 * N+1 que a 9321 resolve com `fn_titulares_apagados_a_pedido`, que responde o
 * lote inteiro numa consulta só e com a MESMA comparação (variantes do nono
 * dígito, HMAC contra o sal da linha).
 *
 * Nada de PII sai daqui: o que volta é o telefone que o chamador já tinha, e
 * apenas quando ELE está marcado. A leitura da marca continua sendo do servidor.
 */

type Admin = SupabaseClient;

/** Motivo do `ignored` — o mesmo texto que o importador de histórico usa. */
export const MOTIVO_TITULAR_APAGADO = "titular_apagado_a_pedido";

/**
 * Motivo do `ignored` da ficha que JÁ está anonimizada. Não é redundante com o
 * de cima: a marca da 0750 não existe para quem foi anonimizado ANTES dela (não
 * há backfill possível, o telefone já tinha sido zerado), e essa ficha continua
 * sem receber telefone nem nome de volta pela agenda.
 */
export const MOTIVO_CONTATO_ANONIMIZADO = "contato_anonimizado";

/** Telefones canônicos do lote que foram apagados a pedido. */
export type ApagadosNoLote = ReadonlySet<string>;

export interface RespostaDoLote {
  apagados: ApagadosNoLote;
  /**
   * Preenchido quando a pergunta NÃO foi respondida (função ausente, erro de
   * rede, resposta fora do contrato). Quem chama decide o que fazer — o
   * `ingestMetaAppContactSync` cai na pergunta individual, que é falha fechada.
   */
  erro?: string;
}

/** Canônicos, sem repetição e sem vazio: o lote vira uma consulta só. */
export function telefonesDoLote(telefones: readonly string[]): string[] {
  const canon = telefones
    .map((t) => canonicalPhoneBR(t))
    .filter((t) => t.trim().length > 0);
  return [...new Set(canon)];
}

export async function perguntarTitularesApagadosNoLote(
  admin: Admin,
  orgId: string,
  telefones: readonly string[],
): Promise<RespostaDoLote> {
  const canon = telefonesDoLote(telefones);
  // Lote sem telefone não pergunta nada: zero consulta, não uma consulta vazia.
  if (canon.length === 0) return { apagados: new Set() };

  const { data, error } = await admin.rpc(
    "fn_titulares_apagados_a_pedido" as never,
    { p_org: orgId, p_telefones: canon } as never,
  );
  if (error) return { apagados: new Set(), erro: error.message };
  // Resposta que não é lista não é "ninguém apagado": é a pergunta sem resposta,
  // e tratar como "ninguém" recriaria justamente quem pediu para sair.
  if (!Array.isArray(data)) return { apagados: new Set(), erro: "resposta sem lista" };

  const apagados = data.filter((t): t is string => typeof t === "string").map((t) => canonicalPhoneBR(t));
  return { apagados: new Set(apagados) };
}

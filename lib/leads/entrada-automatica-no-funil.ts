/**
 * A CONVERSA NOVA ENTRA NO FUNIL — delegando a `garantirLeadDaConversa`
 * (#3603, fatia 1, reestruturada).
 *
 * A cópia deixa de existir: `abrirNegocioDaConversaNova` só lê a preferência
 * da organização e, quando ela está ligada, DELEGA para `garantirLeadDaConversa`.
 * Contato interno, cliente pela agenda, título e timeline passam a valer por
 * construção. Destino: opção (a) — mesmo destino da entrada (is_default +
 * entrada_do_inbox); a chave nova LIGA o comportamento, não escolhe funil.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { entradaAutomaticaNoFunilDeclarada } from "@/lib/schemas/settings";

import { garantirLeadDaConversa } from "./nascimento-do-lead";

export const ORIGEM_DA_ENTRADA_AUTOMATICA = {
  rotulo: "Inbox",
  source: "inbox_entrada_automatica",
  motivo: "conversa nova entrou no funil automaticamente",
} as const;

export type MotivoSemNegocio =
  | "nao_configurado"
  | "ja_existe"
  | "contato_bloqueado"
  | "contato_pessoal"
  | "contato_interno"
  | "sem_funil_de_entrada"
  | "sem_etapa"
  | "sem_funil"
  | "erro";

export type EntradaNoFunil =
  | { criado: true; leadId: string; pipelineId: string; stageId: string }
  | { criado: false; motivo: MotivoSemNegocio; detalhe?: string };

export interface ConversaNova {
  organizationId: string;
  contactId: string;
  conversationId: string;
  nomeDoContato?: string | null;
}

export async function abrirNegocioDaConversaNova(
  db: SupabaseClient,
  conversa: ConversaNova,
): Promise<EntradaNoFunil> {
  const { organizationId, contactId, conversationId } = conversa;

  const { data: org, error: erroDaOrg } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (erroDaOrg) {
    logger.warn("[entrada-automatica] leitura das configurações falhou", {
      organizationId,
      error: erroDaOrg.message,
    });
    return { criado: false, motivo: "erro", detalhe: erroDaOrg.message.slice(0, 120) };
  }

  const declarada = entradaAutomaticaNoFunilDeclarada(
    (org as { settings?: unknown } | null)?.settings,
  );
  if (!declarada.ativa || !declarada.pipeline_id) {
    return { criado: false, motivo: "nao_configurado" };
  }

  try {
    const resultado = await garantirLeadDaConversa(db, {
      organizationId,
      contactId,
      conversationId,
      nomeDoContato: conversa.nomeDoContato ?? null,
      origem: ORIGEM_DA_ENTRADA_AUTOMATICA,
    });

    if (resultado.criado) {
      return {
        criado: true,
        leadId: resultado.leadId,
        pipelineId: resultado.pipelineId,
        stageId: resultado.stageId,
      };
    }
    return {
      criado: false,
      motivo: resultado.motivo as MotivoSemNegocio,
      detalhe: resultado.detalhe,
    };
  } catch (erro) {
    logger.error("[entrada-automatica] a entrada no funil estourou", {
      organizationId,
      contactId,
      conversationId,
      motivo: erro instanceof Error ? erro.message.slice(0, 120) : String(erro).slice(0, 120),
    });
    return { criado: false, motivo: "erro" };
  }
}
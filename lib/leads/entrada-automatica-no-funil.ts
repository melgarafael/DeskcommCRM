/**
 * A CONVERSA QUE O CRM ABRE ENTRA NO FUNIL — delegando a `garantirLeadDaConversa`
 * (#3603, fatia 1).
 *
 * `abrirNegocioDaConversaNova` só lê o interruptor da organização
 * (`settings.entrada_automatica_no_funil.ativa`) e, ligado, DELEGA. Contato
 * interno e da equipe, cliente pela agenda e pela venda, pós-venda, título e
 * timeline valem por construção, porque a regra é a da conversa que chega.
 *
 * Destino: opção (a) — o MESMO da entrada (funil `is_default` + etapa de
 * `settings.entrada_do_inbox`, ou o funil de clientes quando a regra de cliente
 * vale). A chave LIGA o comportamento; não escolhe funil nem etapa.
 *
 * ⚠️ REABRIR O PERDIDO RECENTE (#4076) também vale aqui. Num funil com
 * `settings.reabrir_perdido_dias` ligado, a conversa aberta pelo CRM — inclusive
 * a de um cron, como o lembrete de agenda ou de tarefa — pode devolver a
 * `aberto` um negócio perdido dentro da janela, em vez de criar outro. É a mesma
 * decisão que a ingestão toma; aqui ela só passa a ter mais uma porta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { entradaAutomaticaNoFunilDeclarada } from "@/lib/schemas/settings";

import { garantirLeadDaConversa, type MotivoSemLead } from "./nascimento-do-lead";

export const ORIGEM_DA_ENTRADA_AUTOMATICA = {
  rotulo: "Inbox",
  source: "inbox_entrada_automatica",
  motivo: "conversa nova entrou no funil automaticamente",
} as const;

/** Os motivos do nascimento, mais o da chave desligada — nenhum escondido. */
export type MotivoSemNegocio = "nao_configurado" | MotivoSemLead;

export type EntradaNoFunil =
  | { criado: true; leadId: string; pipelineId: string; stageId: string }
  /** `leadId` só vem em `motivo: "reaberto"`: o card perdido voltou a aberto. */
  | { criado: false; motivo: MotivoSemNegocio; detalhe?: string; leadId?: string };

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
  if (!declarada.ativa) return { criado: false, motivo: "nao_configurado" };

  try {
    return await garantirLeadDaConversa(db, {
      organizationId,
      contactId,
      conversationId,
      nomeDoContato: conversa.nomeDoContato ?? null,
      origem: ORIGEM_DA_ENTRADA_AUTOMATICA,
    });
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

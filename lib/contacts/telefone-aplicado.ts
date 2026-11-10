import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { telefoneDeFichaVaziaLigado } from "@/lib/schemas/settings";

/**
 * O INTERRUPTOR E O RASTRO do telefone aplicado sozinho (#2593).
 *
 * As duas peças moram juntas porque são as duas metades da MESMA garantia: a
 * exceção da spec 17 §4b (o dado ouvido é proposto, não gravado) só existe onde
 * quem opera LIGA a opção, e onde ele liga tem de poder VER o que entrou. Um
 * interruptor sem rastro é escrita invisível; um rastro sem interruptor é o PR
 * inteiro sem freio.
 */

/**
 * Esta organização liga a escrita automática do telefone? **Desligado por
 * padrão, e falha LÊ COMO DESLIGADO.**
 *
 * É o mesmo desenho de `lerClientePelaAgenda` (`lib/contacts/cliente-pela-agenda.ts`)
 * e pelo mesmo motivo: quem consome isto decide se uma ESCRITA acontece sem
 * decisão humana. Um erro de leitura que "ligasse" gravaria dado que ninguém
 * autorizou; um erro que "desliga" só devolve o comportamento de sempre — a
 * proposta, que é onde a informação continua e onde a pessoa decide. O erro não
 * some: vai para o log com a organização.
 *
 * `organizationId` vem sempre de fonte confiável — o MESMO id que já filtrou a
 * leitura do contato, e com o client de service role que a ferramenta usa.
 */
export async function lerTelefoneDeFichaVazia(
  db: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[telefone-de-ficha-vazia] leitura do interruptor falhou", {
      organization_id: organizationId,
      error: error.message,
    });
    return false;
  }
  if (!data) return false;
  return telefoneDeFichaVaziaLigado((data as { settings?: unknown }).settings);
}

/** O módulo de origem da linha, e o ator quando não há agente identificado. */
const MODULO = "crm.contatos";

/**
 * A LINHA NA TIMELINE DO CONTATO (#2593, item 2 do CR).
 *
 * O único registro de que o número entrou sozinho era a auditoria
 * (`contact.field_auto_applied`), e a auditoria só aparece em `/app/audit`,
 * restrita a gerentes e fora da ficha: quem opera lê a
 * timeline do contato, que lê SÓ `crm_lead_activities`
 * (`app/api/v1/contacts/[id]/timeline/route.ts`). O público da issue é
 * exatamente quem não abre a fila de propostas — sem esta linha, o número
 * apareceria no cadastro sem nada explicando de onde veio, que é o modo de
 * morte que a própria `activity-vocabulary.ts` documenta.
 *
 * ⚠️ `crm_lead_activities.lead_id` é NOT NULL, então a linha só existe com um
 * NEGÓCIO: o roteamento contato→negócio é o `resolveActiveLeadForContact`, o
 * MESMO do resto do motor — sem negócio aberto (ou com dois, empatados) ele NÃO
 * adivinha, e a ausência fica explicada no log. É a limitação declarada do
 * barramento, não uma escolha daqui: contato sem negócio só tem auditoria.
 *
 * ⚠️ NUNCA LANÇA. É rastro, não operação: a timeline não pode derrubar a
 * escrita que ela descreve — o número já entrou na ficha quando esta função
 * roda, e falhar aqui só apagaria a explicação.
 */
export async function registrarTelefoneAplicadoNaTimeline(
  db: SupabaseClient,
  p: {
    organizationId: string;
    contactId: string;
    telefone: string;
    /** Só quando conhecido: a coluna `actor_agent_id` tem FK para `ai_agents`. */
    agentId?: string | null;
    trecho?: string | null;
  },
): Promise<boolean> {
  // O NÚMERO fica legível para quem opera: é ele que o item 2 do CR pede
  // que apareça. A coluna é coberta pela cascata da LGPD
  // (`fn_lgpd_cascade_redact_contact` faz `update` nesta tabela), então
  // telefone aqui não sobrevive a um pedido de esquecimento — e por isso o
  // `trecho` que o cliente escreveu mora AQUI, e não na auditoria.
  return registrarCampoAplicadoNaTimeline(db, {
    organizationId: p.organizationId,
    contactId: p.contactId,
    agentId: p.agentId,
    reason: `Número aplicado na ficha pelo assistente: ${p.telefone}`,
    payload: { campo: "phone_number", telefone: p.telefone, automatico: true, trecho: p.trecho ?? null },
  });
}

/**
 * O NOME que entrou sozinho na ficha vazia (#3784) — a mesma linha, pelo mesmo
 * motivo do telefone. O texto da mensagem NÃO entra: o nome já é ele inteiro
 * (`nomeCorrespondeAMensagem` exige correspondência literal).
 */
export async function registrarNomeAplicadoNaTimeline(
  db: SupabaseClient,
  p: { organizationId: string; contactId: string; nome: string; agentId?: string | null },
): Promise<boolean> {
  return registrarCampoAplicadoNaTimeline(db, {
    organizationId: p.organizationId,
    contactId: p.contactId,
    agentId: p.agentId,
    reason: `Nome aplicado na ficha pelo assistente: ${p.nome}`,
    payload: { campo: "name", nome: p.nome, automatico: true },
  });
}

async function registrarCampoAplicadoNaTimeline(
  db: SupabaseClient,
  p: {
    organizationId: string;
    contactId: string;
    agentId?: string | null;
    reason: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const campo = p.payload.campo;
  try {
    const [{ data: leads }, { data: defaultPipeline }] = await Promise.all([
      db
        .from("crm_leads")
        .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
        .eq("organization_id", p.organizationId)
        .eq("contact_id", p.contactId),
      db
        .from("crm_pipelines")
        .select("id")
        .eq("organization_id", p.organizationId)
        .eq("is_default", true)
        .eq("is_archived", false)
        .limit(1)
        .maybeSingle(),
    ]);

    const alvo = resolveActiveLeadForContact((leads ?? []) as LeadCandidate[], {
      defaultPipelineId: (defaultPipeline as { id: string } | null)?.id ?? null,
    });

    if (!alvo.routed) {
      logger.info("[campo-aplicado] campo aplicado sem negócio para pendurar", {
        campo,
        organization_id: p.organizationId,
        contact_id: p.contactId,
        motivo_sem_rota: alvo.reason,
      });
      return false;
    }

    // Pessoa/agente antes de sistema, pela mesma ordem de
    // `emitAgentActivityForContact`: quem tem nome assina. Sem agente
    // identificado a linha entra como sistema — perder a AUTORIA é ruim,
    // perder a LINHA seria pior.
    const actor: Actor = p.agentId
      ? { type: "ai_agent", id: p.agentId, agent_id: p.agentId, role: "agent" }
      : { type: "webhook_source", id: MODULO };

    const r = await emitLeadActivity(db, {
      organizationId: p.organizationId,
      leadId: alvo.leadId,
      contactId: p.contactId,
      type: "contact_field_auto_applied",
      sourceModule: MODULO,
      actor,
      reason: p.reason,
      payload: p.payload,
    });

    if (!r.ok) {
      logger.warn("[campo-aplicado] atividade do campo aplicado não foi gravada", {
        campo,
        organization_id: p.organizationId,
        contact_id: p.contactId,
        error: r.error,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("[campo-aplicado] atividade do campo aplicado falhou", {
      campo,
      organization_id: p.organizationId,
      contact_id: p.contactId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

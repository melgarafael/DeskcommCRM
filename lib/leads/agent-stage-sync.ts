import { observeServiceOrigin } from "@/lib/atendimento/origem";
import type { RiskBucket } from "@/lib/leads/risk-radar";

/**
 * O funil do AGENTE movendo o card no funil do TENANT (wave 8, cenários 25/26).
 *
 * O agente pensa em sete passos fixos (`lead_state.stage`); o tenant nomeia os
 * dele — "Avaliação" numa clínica, "Aguardando pagamento" num e-commerce. A
 * ponte é `crm_stages.agent_stage_hint` (migration 0084).
 *
 * ⚠️ ESTE ARQUIVO NÃO ADIVINHA NADA. As três respostas possíveis são mover,
 * não mover, ou não ter para onde — e a terceira é um estado legítimo do
 * produto, não um erro a contornar.
 */

/** O que o resolvedor sabe de cada estágio do pipeline. */
export interface EstagioCandidato {
  id: string;
  name: string;
  agent_stage_hint: string | null;
  is_archived: boolean;
}

export type DestinoDoAgente =
  | { move: true; stageId: string; stageName: string }
  /**
   * `sem_mapeamento` — o pipeline não declarou nenhum estágio para este passo.
   *
   * NÃO é erro e NÃO tem fallback: mover para "o mais próximo por posição"
   * inventaria semântica que o tenant não declarou, e o negócio apareceria num
   * lugar que ninguém escolheu. O card fica onde está, e o rastro registra que
   * o agente quis mover.
   */
  | { move: false; motivo: "sem_mapeamento"; passo: string }
  /** O agente está no passo que o negócio já ocupa: nada a fazer, e não é falha. */
  | { move: false; motivo: "ja_esta_la"; passo: string };

/**
 * Para onde o negócio vai quando o agente avança para `passo`.
 *
 * ⚠️ NÃO TRATA AMBIGUIDADE, e isso é deliberado: `uniq_crm_stages_pipeline_hint`
 * (0084) torna dois estágios com o mesmo hint IMPOSSÍVEIS no banco. Tratar aqui
 * seria proteger contra um estado que não pode existir — e, pior, faria alguém
 * acreditar que pode. A recusa mora na CONFIGURAÇÃO, onde chega a quem
 * configurou e ensina; recusa no uso chegaria a um terceiro, meses depois, sem
 * contexto nenhum.
 *
 * Estágio ARQUIVADO não é destino: ele é histórico, e mandar um negócio vivo
 * para lá o esconderia do board.
 */
export function resolveDestinoDoAgente(
  estagios: EstagioCandidato[],
  passo: string,
  estagioAtualId: string,
): DestinoDoAgente {
  const alvo = estagios.find((e) => !e.is_archived && e.agent_stage_hint === passo);
  if (!alvo) return { move: false, motivo: "sem_mapeamento", passo };
  if (alvo.id === estagioAtualId) return { move: false, motivo: "ja_esta_la", passo };
  return { move: true, stageId: alvo.id, stageName: alvo.name };
}

/**
 * O texto que vai para a timeline quando o agente move o negócio.
 *
 * Nomeia os DOIS lados da tradução — o passo do agente e o estágio do tenant —
 * porque quem lê a timeline conhece só o segundo, e quem depura conhece só o
 * primeiro. "Movido para Avaliação" esconde que foi o agente; "avançou para
 * qualifying" é vocabulário que o usuário nunca viu.
 */
export function razaoDaMudancaPeloAgente(stageName: string, passo: string): string {
  return `Movido para ${stageName} pelo assistente (passo "${passo}" do atendimento)`;
}

export type { RiskBucket };

/* ────────────────────────────────────────────────────────────────────────── */

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { resolveActiveLeadForContact } from "@/lib/leads/active-lead";
import { stageChangeReason } from "@/lib/leads/activity-emitter";
import { podeOperarNoFunil } from "./escopo-de-funil";

export interface ResultadoDaSincronizacao {
  moveu: boolean;
  /**
   * ⚠️ NENHUM RÓTULO PODE MENTIR — é o que separa os três grupos:
   *  - estado legítimo do produto: `sem_mapeamento`, `sem_negocio`, `ambiguo`,
   *    `ja_esta_la`, `conflito_humano` (o card não andou, e ninguém errou);
   *  - o banco não respondeu: `indisponivel` (o funil PAROU — alguém precisa saber);
   *  - a escrita falhou: `falha_de_escrita`.
   * Reaproveitar um rótulo do primeiro grupo para os outros dois transformaria
   * indisponibilidade em rotina, que é o defeito que esta função já teve.
   */
  motivo:
    | "movido"
    | "sem_mapeamento"
    | "ja_esta_la"
    | "sem_negocio"
    | "ambiguo"
    | "conflito_humano"
    /**
     * O negócio está num funil que este agente não cuida (spec 17 passo 3).
     *
     * ⚠️ NÃO é o mesmo que `sem_mapeamento`: lá falta configuração de ETAPA (o
     * agente cuidaria, mas não sabe para onde ir); aqui a configuração está
     * COMPLETA e a resposta é não. E não é `falha_de_escrita`: nada falhou — a
     * regra funcionou.
     */
    | "fora_do_escopo"
    | "falha_de_escrita"
    | "indisponivel";
  leadId?: string;
  stageName?: string;
  detalhe?: string;
}

/**
 * O agente avançou o próprio funil — o card acompanha, se houver para onde.
 *
 * ⚠️ REUSA `resolveActiveLeadForContact`, e isso não é economia de código: o
 * funil do agente é por CONTATO e o card é por NEGÓCIO, então um contato com
 * dois negócios abertos exige decidir qual se move. A wave 4 já decidiu isso
 * para a próxima ação, e um SEGUNDO resolvedor de "qual negócio deste contato"
 * seria a doença desta entrega inteira criada de propósito — duas fontes que
 * começam iguais e divergem no primeiro ajuste.
 *
 * Ambíguo NÃO move nenhum, pela mesma razão da wave 4: mover o negócio errado é
 * pior que não mover, porque o usuário vê um card se mexendo sozinho e não tem
 * como saber por quê.
 */
export async function sincronizaEstagioDoAgente(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    passo: string;
    /**
     * Funis que ESTE agente pode escrever (`ai_agent_versions.pipeline_ids`).
     *
     * `undefined` = chamador que ainda não sabe do escopo (caminho legado):
     * segue como antes. Array VAZIO = nenhum funil, e aí nada é movido — a
     * distinção existe porque tratar "não informado" como "vazio" pararia todo
     * caminho que ainda não foi migrado, em silêncio.
     */
    escopoDeFunis?: readonly string[];
  },
): Promise<ResultadoDaSincronizacao> {
  // ⚠️ O erro do SELECT É LIDO, e isso não é zelo: o supabase-js NÃO LANÇA em
  // falha de rede — devolve { data: null, error }. Descartar o erro faria o
  // banco fora virar `candidatos = []` → "sem_negocio", ou seja, uma queda do
  // Supabase indistinguível do estado normal de um contato sem negócio aberto.
  const { data: leadRows, error: erroLeads } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, stage_id, status, created_at, last_activity_at")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId);
  if (erroLeads) {
    return { moveu: false, motivo: "indisponivel", detalhe: erroLeads.message };
  }
  const candidatos = (leadRows ?? []) as Array<{
    id: string;
    organization_id: string;
    pipeline_id: string;
    stage_id: string;
    status: string;
    created_at: string;
    last_activity_at: string | null;
  }>;

  const rota = resolveActiveLeadForContact(
    candidatos.map((c) => ({
      id: c.id,
      organization_id: c.organization_id,
      pipeline_id: c.pipeline_id,
      status: c.status as "open" | "won" | "lost",
      created_at: c.created_at,
      last_activity_at: c.last_activity_at,
    })),
  );
  if (!rota.routed) {
    return { moveu: false, motivo: rota.reason === "no_open_lead" ? "sem_negocio" : "ambiguo" };
  }
  const lead = candidatos.find((c) => c.id === rota.leadId)!;

  // ── ESCOPO DE FUNIL (spec 17 passo 3) ────────────────────────────────────
  //
  // DEPOIS de rotear, e não antes: filtrar os candidatos pelo escopo faria um
  // contato cujo único negócio está fora virar "sem_negocio" — e o dono leria
  // "esse cliente não tem negócio aberto", que é falso e manda procurar no
  // lugar errado. O negócio EXISTE; o que não existe é a permissão.
  if (input.escopoDeFunis !== undefined) {
    const veredito = podeOperarNoFunil(input.escopoDeFunis, lead.pipeline_id);
    if (!veredito.permitido) {
      return {
        moveu: false,
        motivo: "fora_do_escopo",
        leadId: lead.id,
        detalhe:
          veredito.motivo === "escopo_vazio"
            ? "nenhum funil liberado para este assistente"
            : "o negócio está num funil que este assistente não cuida",
      };
    }
  }

  const { data: stageRows, error: erroStages } = await admin
    .from("crm_stages")
    .select("id, name, agent_stage_hint, is_archived")
    .eq("pipeline_id", lead.pipeline_id);
  // Mesmo motivo do SELECT acima: sem esta linha, banco fora = pipeline sem
  // hint nenhum = "sem_mapeamento", e o incidente se disfarça de configuração.
  if (erroStages) {
    return { moveu: false, motivo: "indisponivel", leadId: lead.id, detalhe: erroStages.message };
  }

  const destino = resolveDestinoDoAgente(
    (stageRows ?? []) as EstagioCandidato[],
    input.passo,
    lead.stage_id,
  );
  if (!destino.move) return { moveu: false, motivo: destino.motivo, leadId: lead.id };

  // O erro DESTE select é descartado de propósito — e a diferença para os dois de
  // cima (onde descartar produziu o defeito de tratar banco fora como rotina) é
  // que aqui nenhuma DECISÃO depende do resultado: o nome da origem só enfeita o
  // texto da timeline, que degrada de "Movido de A para X" para "Movido para X".
  // Abortar por causa dele desfaria um movimento que já aconteceu no banco.
  const { data: origem } = await admin
    .from("crm_stages")
    .select("name")
    .eq("id", lead.stage_id)
    .maybeSingle();

  const serviceOrigin = await observeServiceOrigin(admin, input.organizationId, input.contactId);
  const { data: atualizadas, error } = await admin
    .from("crm_leads")
    .update({ stage_id: destino.stageId })
    .eq("id", lead.id)
    // Trava otimista pelo estágio de ORIGEM: se um humano arrastou o card entre
    // a leitura e a escrita, o agente não atropela a decisão dele.
    .eq("stage_id", lead.stage_id)
    // ⚠️ O `.select()` é o que torna a trava OBSERVÁVEL: sem ele, "0 linhas
    // afetadas" não é erro nenhum e o código seguiria emitindo a atividade de
    // um movimento que não aconteceu — história fabricada na timeline do
    // cliente, que é pior que não mover.
    .select("id");
  if (error) {
    return { moveu: false, motivo: "falha_de_escrita", leadId: lead.id, detalhe: error.message };
  }
  if ((atualizadas ?? []).length === 0) {
    // A trava atuou: um humano moveu o card no meio da operação. Não é erro (a
    // decisão dele vence) e NÃO emite atividade — nada aconteceu para contar.
    return { moveu: false, motivo: "conflito_humano", leadId: lead.id };
  }

  // A atividade usa o MESMO `stageChangeReason` do arrasto humano — a timeline
  // não deve ter duas gramáticas para o mesmo acontecimento. Quem moveu está no
  // ATOR, que é onde essa informação pertence.
  const atividade = await emitLeadActivity(admin, {
    organizationId: input.organizationId,
    leadId: lead.id,
    contactId: input.contactId,
    type: "stage_changed",
    sourceModule: "crm",
    sourceId: lead.id,
    actor: { type: "webhook_source", id: "agent-stage-sync" },
    reason: stageChangeReason(
      (origem as { name: string } | null)?.name ?? null,
      destino.stageName,
    ),
    payload: { passo_do_agente: input.passo, de: lead.stage_id, para: destino.stageId },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.organizationId,
      leadId: lead.id,
      tipo: "stage_changed",
      origem: "lib/leads/agent-stage-sync",
      erro: atividade.error,
    });
  }

  // ⚠️ O EVENTO, E NÃO SÓ A ATIVIDADE — E A DIFERENÇA ENTRE OS DOIS É QUEM LÊ.
  //
  // `crm_lead_activities` conta a história na timeline do card: é para humano.
  // `event_log` é o que ACIONA quem reage — `lib/automation/engine.handler.ts`
  // (regras do tenant) e `lib/followup/gatilho-etapa.ts` consomem
  // `lead.stage_changed`, e as três rotas HTTP de movimento
  // (`leads/[id]/move`, `moveLeadHandler`, `leads/bulk`) sempre o emitiram.
  //
  // Enquanto esta emissão não existia, mover pela mão e mover pelo assistente
  // eram acontecimentos DIFERENTES para o sistema: o card andava, a timeline
  // contava, e nenhuma regra rodava — em silêncio, sem erro, sem log. Uma regra
  // que ignora metade dos movimentos é pior que uma regra que dispara demais,
  // porque a primeira é invisível. Mover pelo assistente tem de ser
  // indistinguível de mover pela mão.
  //
  // `entity_kind='crm_lead'` não é decoração: o motor de automação FILTRA por
  // ele (o trigger legado `fn_emit_event_on_lead_change` emite com
  // `entity_kind='lead'`, e o filtro é o que impede a regra de rodar duas vezes
  // pela mesma mudança). Emitir com outro valor aqui seria emitir para ninguém.
  //
  // Fire-and-forget com o erro LIDO, no mesmo espírito do resto do arquivo: a
  // mutação já aconteceu e não se desfaz por causa do rastro, mas rastro
  // perdido vira linha de log, nunca silêncio.
  const { error: erroEvento } = await admin.rpc("emit_event" as never, {
    p_event_type: "lead.stage_changed",
    p_entity_kind: "crm_lead",
    p_entity_id: lead.id,
    p_payload: {
      service_origin: serviceOrigin,
      pipeline_id: lead.pipeline_id,
      from_stage_id: lead.stage_id,
      to_stage_id: destino.stageId,
      status: lead.status,
    },
    // Quem moveu vai no metadata, como nas rotas — lá é `actor_user_id`, aqui é
    // o assistente. Sem isto, um evento sem ator nenhum se parece com um bug de
    // quem for depurar a regra que ele disparou.
    p_metadata: { actor_kind: "ai", source: "agent-stage-sync", passo_do_agente: input.passo },
    p_organization_id: input.organizationId,
  });
  if (erroEvento) {
    logger.error("[agent-stage-sync] emit_event lead.stage_changed falhou", {
      lead_id: lead.id,
      organization_id: input.organizationId,
      error: erroEvento.message,
    });
  }

  return { moveu: true, motivo: "movido", leadId: lead.id, stageName: destino.stageName };
}

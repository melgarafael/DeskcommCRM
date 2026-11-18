/**
 * O NEGÓCIO PERDIDO ONTEM NÃO VIROU CARD VAZIO HOJE (#4076).
 *
 * ═══ O DEFEITO, MEDIDO PELO AUTOR DA ISSUE ═══
 *
 * `garantirLeadDaConversa` cria um negócio novo quando o contato não tem nenhum
 * ABERTO — inclusive quando o último foi marcado perdido minutos antes. Na
 * operação de quem abriu a issue, **5 de 7 negócios perdidos em 9 dias geraram um
 * card novo em até 85 minutos**, e em 3 de 4 contatos o gatilho foi só uma
 * mensagem de despedida. O card novo nasce vazio em "Contato Inicial", e a
 * descrição, os campos e o motivo da perda ficam no card perdido: dois cards do
 * mesmo contato, e o histórico comercial no fantasma.
 *
 * ═══ O QUE ESTA FATIA FAZ ═══
 *
 * Com a opção LIGADA no funil, a mensagem de quem tem um perdido DENTRO DA
 * JANELA **reabre o mesmo card**: mesmo `id`, `status` de volta a `aberto`,
 * descrição/campos/motivo intactos. Nada é copiado, nada é migrado, e nenhum
 * card é fundido — a decisão de escopo da issue. Fora da janela, sem perdido, ou
 * com a opção desligada, o comportamento é EXATAMENTE o de hoje: card novo.
 *
 * ═══ A JANELA EXISTE PARA NÃO ESCONDER ROTATIVIDADE ═══
 *
 * Reabrir um perdido de meses atrás apagaria a leitura de "quantas tentativas até
 * fechar": o card voltaria a `aberto` com a idade da PRIMEIRA tentativa, e o
 * relatório de perdas deixaria de contar a perda que houve. A janela curta é o
 * que separa "o cliente respondeu à despedida" (a demanda nunca morreu) de
 * "o cliente voltou num trimestre seguinte" (demanda nova, com a perda
 * registrada no lugar dela).
 *
 * ═══ ONDE A OPÇÃO MORA, E POR QUE NÃO HÁ MIGRATION ═══
 *
 * `crm_pipelines.settings.reabrir_perdido_dias` — o MESMO jsonb de `fields`,
 * `lost_reasons`, `reabertura` e `ocultar_encerrados_dias`. Chave ausente é a
 * opção DESLIGADA: nenhum funil existente muda de comportamento, e nenhuma
 * coluna nova foi necessária (a opção é dado de configuração, não de negócio).
 *
 * ═══ QUEM MANDA O `status` CONTINUA SENDO O GATILHO ═══
 *
 * A reabertura é UMA escrita: `stage_id` da etapa de onde o negócio saiu
 * (`lost_from_stage_id`, migration 0426). Quem devolve `status = 'open'`, limpa
 * `closed_at` e zera `lost_from_stage_id` é `fn_crm_lead_close_on_stage` (P-02:
 * o gatilho é o único escritor de `status`). Escrever `status` aqui seria a
 * segunda régua, e a primeira coisa a divergir.
 *
 * `lost_reason` NÃO é apagado: é a memória de por que a tentativa anterior
 * morreu, e a timeline registra a etapa de saída e o motivo no payload da
 * atividade `lead_reopened`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { emitLeadActivity } from "./activity-emitter";
import { diasParaReabrirPerdido, perdidoDentroDaJanela } from "./janela-do-perdido";
import { modoDeReabertura } from "./reabertura";

/** O que a reabertura devolve para quem chamou — para o log e para a timeline. */
export interface ReaberturaDoPerdido {
  leadId: string;
  /** Etapa para onde o card voltou. */
  stageId: string;
  /** Janela que autorizou a reabertura, em dias. */
  dias: number;
  /** Etapa de onde o negócio tinha morrido (a do `lost_from_stage_id`). */
  etapaDaPerda: string | null;
  /** Quando ele morreu — vai para a timeline como "quando". */
  perdidoEm: string | null;
}

/** O que a reabertura precisa saber; nomes iguais aos do nascimento. */
export interface DadosDaReabertura {
  organizationId: string;
  contactId: string;
  conversationId: string;
  /** O funil onde o card nasceria — é dele que sai a opção. */
  pipelineId: string;
  /** A etapa de entrada já validada — o destino quando a de origem não vale. */
  stageIdDeEntrada: string;
  /** Injetável para o teste medir a janela sem depender do relógio. */
  agora?: Date;
}

/**
 * Reabre o perdido recente do contato NESTE funil, ou devolve `null`.
 *
 * `null` é "siga como hoje": crie o card novo. Todos os motivos de recusa caem
 * nele — opção desligada, funil que já escolheu `novo_negocio` na retomada,
 * nenhum perdido, perdido fora da janela, etapa de volta indisponível e erro de
 * leitura/escrita. Isso é o desenho, não descuido: a alternativa (lançar) faria
 * a mensagem do cliente não virar card nenhum, que é o modo de morte que
 * `nascimento-do-lead.ts` inteiro existe para curar. Toda recusa com erro vai
 * para o log com a organização.
 *
 * O PERDIDO MAIS RECENTE é o escolhido (`closed_at desc`, `limit 1`). Com dois
 * perdidos do mesmo contato, reabrir os dois seria fundir histórico — e a issue
 * proíbe: o card que voltou é o último que morreu, que é o que a mensagem de
 * hoje está respondendo.
 */
export async function reabrirPerdidoRecente(
  db: SupabaseClient,
  dados: DadosDaReabertura,
): Promise<ReaberturaDoPerdido | null> {
  const { organizationId, contactId, conversationId, pipelineId } = dados;
  const agora = dados.agora ?? new Date();

  // ── 1 · a opção deste funil ────────────────────────────────────────────
  const { data: funil, error: erroDoFunil } = await db
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", organizationId)
    .eq("id", pipelineId)
    .maybeSingle();
  if (erroDoFunil) {
    logger.warn("[reabrir-perdido] leitura da opção do funil falhou — nasce card novo", {
      organization_id: organizationId,
      pipeline_id: pipelineId,
      error: erroDoFunil.message.slice(0, 120),
    });
    return null;
  }

  const settings = (funil as { settings?: Record<string, unknown> } | null)?.settings;
  const dias = diasParaReabrirPerdido(settings);
  if (dias === null) return null;

  // ── 1b · a escolha de RETOMADA vence ───────────────────────────────────
  // `settings.reabertura = "novo_negocio"` é a decisão explícita deste funil
  // sobre "negócio encerrado que volta": nova tentativa, com a perda anterior
  // registrada (#1538). Reabrir o mesmo registro por baixo dessa escolha
  // inverteria a decisão do operador — e é a MESMA pergunta, respondida antes.
  if (modoDeReabertura(settings) === "novo_negocio") return null;

  // ── 2 · o perdido mais recente deste contato NESTE funil ───────────────
  // O filtro de organização não é decoração: sem ele o card de outro tenant
  // seria reaberto para o contato errado (duas empresas podem ter contatos com
  // o mesmo telefone, nunca a mesma linha). O filtro de funil é a régua da
  // issue: o histórico de outro funil não é a demanda que esta mensagem abriu.
  const { data: candidato, error: erroDaBusca } = await db
    .from("crm_leads")
    .select("id, stage_id, lost_from_stage_id, lost_reason, closed_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("pipeline_id", pipelineId)
    .eq("status", "lost")
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroDaBusca) {
    logger.warn("[reabrir-perdido] busca do perdido falhou — nasce card novo", {
      organization_id: organizationId,
      contact_id: contactId,
      pipeline_id: pipelineId,
      error: erroDaBusca.message.slice(0, 120),
    });
    return null;
  }
  if (!candidato) return null;

  const perdido = candidato as {
    id: string;
    stage_id: string;
    lost_from_stage_id: string | null;
    lost_reason: string | null;
    closed_at: string | null;
  };
  if (!perdidoDentroDaJanela(perdido.closed_at, dias, agora)) return null;

  // ── 3 · para QUAL etapa ele volta ──────────────────────────────────────
  // A etapa de onde ele saiu é a resposta certa — é o que a issue pede. Ela
  // pode ter sido arquivada ou apagada desde então; nesse caso a etapa de
  // entrada do funil (já validada por `funilDeEntrada`) recebe o card, em vez
  // de a reabertura falhar e a pessoa virar um card vazio outra vez.
  const etapaDeVolta = await etapaDeVoltaValida(
    db,
    organizationId,
    pipelineId,
    perdido,
    dados.stageIdDeEntrada,
  );

  // ── 4 · a escrita: UMA, e só se ele AINDA está perdido ─────────────────
  // O `.eq("status", "lost")` é a trava de concorrência: duas mensagens
  // simultâneas passam as duas pela busca acima, e só a primeira escreve. A
  // segunda cai em "já está aberto" — sem segundo card, sem segunda linha na
  // timeline, sem segundo evento de etapa.
  const { data: linhas, error: erroDaEscrita } = await db
    .from("crm_leads")
    .update({ stage_id: etapaDeVolta })
    .eq("organization_id", organizationId)
    .eq("id", perdido.id)
    .eq("status", "lost")
    .select("id")
    .maybeSingle();
  if (erroDaEscrita) {
    logger.warn("[reabrir-perdido] reabertura falhou — nasce card novo", {
      organization_id: organizationId,
      lead_id: perdido.id,
      error: erroDaEscrita.message.slice(0, 120),
    });
    return null;
  }
  if (!linhas) {
    // Alguém reabriu entre a busca e a escrita (ou o card deixou de ser
    // perdido). Devolver `null` aqui criaria o card vazio que a issue relata;
    // quem chamou confere o aberto antes de criar — ver `garantirLeadDaConversa`.
    logger.info("[reabrir-perdido] o card deixou de estar perdido durante a escrita", {
      organization_id: organizationId,
      lead_id: perdido.id,
    });
    return null;
  }

  // ── 5 · a timeline: QUEM reabriu e QUANDO ──────────────────────────────
  // Sem esta linha o card voltaria a `aberto` sozinho, e quem abre o dossiê
  // não saberia que foi a mensagem do contato (e não uma pessoa arrastando).
  // `lead_created` NÃO é emitido: nada nasceu — é a mesma demanda de antes, e
  // um evento de criação por card reaberto inflaria a contagem do funil.
  const registro = await emitLeadActivity(db, {
    organizationId,
    leadId: perdido.id,
    contactId,
    type: "lead_reopened",
    // `canal.ingest` pelo mesmo motivo do nascimento: o que importa é o QUE
    // originou (a mensagem do contato), não por onde ela entrou.
    sourceModule: "canal.ingest",
    sourceId: conversationId,
    actor: { type: "webhook_source", id: "canal-inbound" },
    reason: `negócio perdido reaberto pela mensagem do contato (dentro da janela de ${dias} dias)`,
    payload: {
      conversation_id: conversationId,
      // De onde ele saiu, quando morreu e por quê: o gatilho zera
      // `lost_from_stage_id` ao reabrir (0426), então esta linha é a memória
      // da passagem.
      etapa_da_perda: perdido.lost_from_stage_id ?? perdido.stage_id,
      etapa_de_volta: etapaDeVolta,
      perdido_em: perdido.closed_at,
      lost_reason: perdido.lost_reason,
      janela_dias: dias,
    },
  });
  if (!registro.ok) {
    // O card voltou e é o que importa; a linha da timeline falhou. Devolver
    // erro faria quem chamou criar um card novo EM CIMA do reaberto.
    logger.warn("reabrir-perdido: atividade não registrada", {
      organization_id: organizationId,
      lead_id: perdido.id,
      error: registro.error?.slice(0, 120),
    });
  }

  return {
    leadId: perdido.id,
    stageId: etapaDeVolta,
    dias,
    etapaDaPerda: perdido.lost_from_stage_id ?? perdido.stage_id,
    perdidoEm: perdido.closed_at,
  };
}

/**
 * A etapa para onde o card volta: a de origem da perda, se ela ainda recebe
 * card aberto; senão a de entrada do funil.
 *
 * A conferência contra o banco é o que separa "o valor gravado" de "etapa
 * utilizável": `lost_from_stage_id` é `on delete set null`, mas uma etapa
 * ARQUIVADA continua apontada — e reabrir numa etapa arquivada faria o card
 * voltar invisível para o quadro, que é pior que reabrir na entrada.
 */
async function etapaDeVoltaValida(
  db: SupabaseClient,
  organizationId: string,
  pipelineId: string,
  perdido: { lost_from_stage_id: string | null },
  etapaDeEntrada: string,
): Promise<string> {
  if (perdido.lost_from_stage_id) {
    const { data: etapa } = await db
      .from("crm_stages")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("pipeline_id", pipelineId)
      .eq("id", perdido.lost_from_stage_id)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false)
      .maybeSingle();
    if (etapa?.id) return etapa.id as string;
  }
  return etapaDeEntrada;
}

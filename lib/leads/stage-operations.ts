/**
 * As operações de ETAPA de funil — ler o funil, criar, editar e arquivar coluna.
 *
 * ⚠️ POR QUE ISTO SAIU DO `route.ts`. As regras puras já viviam em
 * `lib/leads/stage-editing.ts`, mas a SEQUÊNCIA que as usa (validar antes de
 * escrever, desmarcar a etapa de ganho antiga antes de marcar a nova, mover os
 * negócios antes de arquivar) estava dentro do Route Handler. Agora que o agente
 * de IA também organiza o funil, duas superfícies escreveriam na mesma tabela
 * por caminhos diferentes — e a que ficasse para trás mentiria para quem a usa
 * (BRIEFING §3, Decisão 4). Uma cópia da ordem das escritas divergiria no
 * primeiro ajuste, e o sintoma seria um `23505` cru na cara de quem estivesse do
 * lado errado.
 *
 * O que ficou na rota: transporte (JSON, papel, `Response`). O que veio para cá:
 * tudo que decide.
 *
 * ⚠️ A RECUSA VIAJA COMO `ApiError`, e é isso que permite as duas superfícies
 * compartilharem a MESMA frase. `status`/`code` servem à rota; `message` é o
 * texto escrito para o dono da clínica e vai inteiro para a tela — e para o
 * modelo, que precisa entender por que não pôde.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { buildLeadActivityRow, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  posicaoEntre,
  slugDeNome,
  updatesDeMarcacao,
  validarArquivamento,
  validarMarcacao,
  validarNomeDeEtapa,
  type EtapaEditavel,
  type PatchDeMarcacao,
  type UpdateDeMarcacao,
} from "@/lib/leads/stage-editing";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";

type SB = SupabaseClient;

export interface DepsDeEtapa {
  supabase: SB;
  organizationId: string;
  /** Quem está agindo. NUNCA sai do input — é resolvido de fonte confiável pelo chamador. */
  actor: Actor;
  requestId: string;
}

/** As colunas que a tela e as regras usam. `position` entra: a reordenação calcula em cima dela. */
const COLUNAS =
  "id, name, slug, position, is_won, is_lost, is_archived, win_probability, agent_stage_hint, last_change_actor_kind, last_change_at";

/** A etapa como sai para quem lê — inclui a autoria da última mudança de configuração. */
export interface EtapaVisivel {
  id: string;
  name: string;
  slug: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  /**
   * Probabilidade de GANHO desta etapa, 0–100 (migration 0426). `null` = etapa
   * sem calibração, e a previsão a reporta à parte em vez de somar zero.
   *
   * `is_won` e `is_lost` valem 100 e 0 NA REGRA (`lib/leads/previsao.ts`),
   * não aqui: gravar seria um segundo lugar para a mesma verdade divergir.
   */
  win_probability: number | null;
  /** `user` | `ai` | `system` — `null` nas etapas anteriores a esta coluna. */
  last_change_actor_kind: string | null;
  last_change_at: string | null;
}

type EtapaLida = EtapaEditavel & {
  last_change_actor_kind: string | null;
  last_change_at: string | null;
};

/**
 * O funil como as regras precisam dele, ou `null` quando não é desta organização.
 *
 * `null` cobre os dois casos de propósito — funil inexistente e funil de outro
 * tenant respondem a MESMA coisa (404): dizer "existe, mas não é seu" já vaza a
 * existência.
 *
 * Vem com as ARQUIVADAS. As regras de `stage-editing` dependem disso —
 * `uniq_crm_stages_pipeline_slug` não é parcial (arquivada continua ocupando o
 * slug), enquanto os índices de ganho/perda são.
 */
export async function lerFunil(
  supabase: SB,
  orgId: string,
  pipelineId: string,
): Promise<EtapaLida[] | null> {
  const { data: pipeline, error: pipeErr } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pipeErr) throw new Error(pipeErr.message);
  if (!pipeline) return null;

  const { data, error } = await supabase
    .from("crm_stages")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []) as unknown as EtapaLida[];
}

/** O que a tela recebe de volta: o funil vivo, na ordem das colunas. */
export function corpo(etapas: EtapaLida[]): { etapas: EtapaVisivel[] } {
  return {
    etapas: etapas
      .filter((e) => !e.is_archived)
      .map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        position: e.position,
        is_won: e.is_won,
        is_lost: e.is_lost,
        win_probability: e.win_probability ?? null,
        last_change_actor_kind: e.last_change_actor_kind ?? null,
        last_change_at: e.last_change_at ?? null,
      })),
  };
}

/**
 * Recusa do banco traduzida — ou `null` se o erro não é de conflito.
 *
 * ⚠️ ESCOPO EXATO, porque o contrário já foi escrito aqui e era falso: isto
 * cobre `23505` e `23514`, os dois conflitos que um funil editado em duas abas
 * produz. Eles viram texto de tela em português porque "duplicate key value
 * violates unique constraint uniq_crm_stages_pipeline_won" não ensina nada ao
 * dono da clínica.
 *
 * O QUE NÃO É COBERTO: qualquer outro erro sai como `internal_error`, e o
 * `message` dele é técnico por convenção do repo. A regra que vale para as DUAS
 * classes é a de composição — texto de banco nunca entra COLADO numa frase
 * escrita para leigo; quando é preciso dizer algo ao usuário sobre uma falha
 * técnica, o texto do Postgres vai em `details`.
 */
export function conflitoDoBanco(
  erro: { code?: string } | null | undefined,
  nomeDaEtapa: string,
  requestId: string,
): ApiError | null {
  const motivo: Record<string, string> = {
    "23505": `Outra etapa deste funil já ocupa esse lugar — «${nomeDaEtapa}» não pôde ser gravada.`,
    "23514": `«${nomeDaEtapa}» mudou de papel neste funil (ganho ou perda) enquanto você editava.`,
  };
  const texto = motivo[erro?.code ?? ""];
  if (!texto) return null;
  return new ApiError(
    409,
    "state_conflict",
    undefined,
    requestId,
    `${texto} Recarregue a página e tente de novo.`,
  );
}

/** O erro de banco que não é conflito conhecido, com o texto do Postgres preservado. */
function erroDeBanco(
  erro: { code?: string; message: string },
  nomeDaEtapa: string,
  requestId: string,
): ApiError {
  return (
    conflitoDoBanco(erro, nomeDaEtapa, requestId) ??
    new ApiError(500, "internal_error", undefined, requestId, erro.message)
  );
}

/** O funil, ou a recusa de 404 — o passo que TODA operação de etapa faz primeiro. */
async function funilOuNadaFeito(deps: DepsDeEtapa, pipelineId: string): Promise<EtapaLida[]> {
  let etapas: EtapaLida[] | null;
  try {
    etapas = await lerFunil(deps.supabase, deps.organizationId, pipelineId);
  } catch (err) {
    throw new ApiError(500, "internal_error", undefined, deps.requestId, (err as Error).message);
  }
  // Funil de outra org morre AQUI, antes de qualquer escrita: responder 404
  // depois de gravar seria pior do que responder 200.
  if (!etapas) {
    throw new ApiError(404, "not_found", undefined, deps.requestId, "Funil não encontrado.");
  }
  return etapas;
}

/** Relê em vez de espelhar o que foi pedido: quem chama mostra o que o banco tem. */
async function funilDepois(
  deps: DepsDeEtapa,
  pipelineId: string,
): Promise<{ etapas: EtapaVisivel[] }> {
  const depois = await funilOuNadaFeito(deps, pipelineId);
  return corpo(depois);
}

/** `actorUserId` do audit — `null` quando quem agiu não é uma pessoa. */
function autorDoAudit(actor: Actor): { actorUserId: string | null; metadata: Record<string, unknown> } {
  if (actor.type === "user") return { actorUserId: actor.id, metadata: { actor_type: "user" } };
  return { actorUserId: null, metadata: { actor_type: actor.type, actor_id: actor.id } };
}

// ---------------------------------------------------------------------------
// criar
// ---------------------------------------------------------------------------

export interface EtapaCriada {
  stageId: string;
  funil: { etapas: EtapaVisivel[] };
}

/**
 * Cria uma etapa no FIM do funil.
 *
 * Etapa nova aparecendo no meio das colunas seria a operação decidindo por quem
 * pediu. A conta usa a última posição do funil INTEIRO e não a última ativa —
 * arquivada não aparece no quadro, então passar por cima dela não muda nada para
 * quem olha, e filtrar seria uma segunda régua de posição para sustentar de graça.
 */
export async function criarEtapa(
  deps: DepsDeEtapa,
  input: { pipelineId: string; nome: string },
): Promise<EtapaCriada> {
  const name = input.nome.trim();
  const etapas = await funilOuNadaFeito(deps, input.pipelineId);

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO. As constraints são a rede de segurança,
  // não a primeira linha: um 23505 cru não diz QUAL etapa está errada.
  const veredito = validarNomeDeEtapa(name, etapas, null);
  if (!veredito.ok) {
    throw new ApiError(422, "unprocessable_entity", undefined, deps.requestId, veredito.erro);
  }

  const autoria = autoriaDaMudanca(deps.actor);
  const row = {
    organization_id: deps.organizationId,
    pipeline_id: input.pipelineId,
    name,
    // Slug nasce com a etapa e nunca muda (renomear não o toca). Arquivadas
    // entram na conta: `uniq_crm_stages_pipeline_slug` não é parcial.
    slug: slugDeNome(name, etapas.map((e) => e.slug)),
    position: posicaoEntre(etapas[etapas.length - 1]?.position ?? null, null),
    ...autoria,
  };

  const { data: criada, error } = await deps.supabase
    .from("crm_stages")
    .insert(row)
    .select("id")
    .single();
  if (error) throw erroDeBanco(error as { code?: string; message: string }, name, deps.requestId);

  const autor = autorDoAudit(deps.actor);
  const stageId = (criada as { id: string }).id;
  void audit({
    action: "pipeline.stage_created",
    actorUserId: autor.actorUserId,
    organizationId: deps.organizationId,
    resourceType: "crm_stage",
    resourceId: stageId,
    requestId: deps.requestId,
    metadata: { ...autor.metadata, pipeline_id: input.pipelineId, name, slug: row.slug },
  });

  return { stageId, funil: await funilDepois(deps, input.pipelineId) };
}

// ---------------------------------------------------------------------------
// atualizar
// ---------------------------------------------------------------------------

export interface PedidoDeEdicao {
  name?: string;
  is_won?: boolean;
  is_lost?: boolean;
  /**
   * Probabilidade de ganho da etapa, 0–100 (migration 0426). `null` limpa a
   * calibração — e a previsão volta a reportar a etapa no balde "sem
   * probabilidade". Ganho e perda NÃO aceitam número: valem 100 e 0 na regra,
   * nunca gravado.
   */
  win_probability?: number | null;
  /**
   * O vizinho da ESQUERDA (`null` = primeira coluna), não um número de posição:
   * quem arrasta a coluna sabe onde ela caiu, não qual fração de `position` isso
   * vira. Mandar o número duplicaria a conta que `posicaoEntre` já faz — e as
   * duas divergiriam no primeiro ajuste.
   */
  depois_de?: string | null;
}

export async function atualizarEtapa(
  deps: DepsDeEtapa,
  input: { pipelineId: string; stageId: string; pedido: PedidoDeEdicao },
): Promise<{ funil: { etapas: EtapaVisivel[] }; updates: UpdateDeMarcacao[] }> {
  const { pipelineId, stageId, pedido } = input;
  const etapas = await funilOuNadaFeito(deps, pipelineId);

  // Etapa de outra org já não está nesta lista (`lerFunil` filtra por
  // organização), e a resposta é a mesma de uma etapa inexistente.
  const alvo = etapas.find((e) => e.id === stageId);
  if (!alvo) {
    throw new ApiError(404, "not_found", undefined, deps.requestId, "Etapa não encontrada.");
  }

  // ⚠️ ARQUIVADA NÃO SE EDITA — e este é o caso perigoso, não um detalhe de
  // higiene. `lerFunil` devolve as arquivadas de propósito (elas ainda ocupam
  // slug e disputam nome), e `uniq_crm_stages_pipeline_won` é PARCIAL
  // (`where is_won and is_archived = false`): marcar uma arquivada como etapa de
  // ganho passa pelo índice, libera a etapa de ganho de verdade e deixa o funil
  // com o ganho numa coluna que sumiu do quadro. `/leads/[id]/win` busca
  // `.eq("is_won", true)` SEM filtrar arquivada — o negócio fechado iria parar
  // lá. Alcançável sem má-fé: uma aba aberta antes de a etapa ser arquivada.
  if (alvo.is_archived) {
    throw new ApiError(
      409,
      "state_conflict",
      undefined,
      deps.requestId,
      `A etapa «${alvo.name}» foi arquivada e não está mais no quadro. Recarregue a página.`,
    );
  }

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO — as constraints são rede de segurança.
  if (pedido.name !== undefined) {
    const veredito = validarNomeDeEtapa(pedido.name, etapas, stageId);
    if (!veredito.ok) {
      throw new ApiError(422, "unprocessable_entity", undefined, deps.requestId, veredito.erro);
    }
  }

  if (pedido.win_probability !== undefined && pedido.win_probability !== null) {
    const p = pedido.win_probability;
    if (!Number.isInteger(p) || p < 0 || p > 100) {
      throw new ApiError(
        422,
        "unprocessable_entity",
        undefined,
        deps.requestId,
        "A probabilidade de ganho de uma etapa vai de 0 a 100.",
      );
    }
  }

  const temMarcacao = pedido.is_won !== undefined || pedido.is_lost !== undefined;
  if (temMarcacao) {
    const veredito = validarMarcacao(etapas, stageId, pedido);
    if (!veredito.ok) {
      throw new ApiError(422, "unprocessable_entity", undefined, deps.requestId, veredito.erro);
    }
  }

  const patchDoAlvo: PatchDeMarcacao & {
    name?: string;
    position?: number;
    win_probability?: number | null;
  } = {};
  if (pedido.name !== undefined) patchDoAlvo.name = pedido.name.trim();
  // `undefined` não viaja; `null` limpa a calibração de propósito.
  if (pedido.win_probability !== undefined) patchDoAlvo.win_probability = pedido.win_probability;

  if (pedido.depois_de !== undefined) {
    // Só as ativas compõem a régua: arquivada não ocupa lugar no quadro.
    const ativas = etapas.filter((e) => !e.is_archived && e.id !== stageId);
    const i = pedido.depois_de === null ? -1 : ativas.findIndex((e) => e.id === pedido.depois_de);
    if (pedido.depois_de !== null && i < 0) {
      throw new ApiError(
        422,
        "unprocessable_entity",
        undefined,
        deps.requestId,
        "A etapa que você escolheu como vizinha não está mais no funil. Recarregue a página.",
      );
    }
    const posicao = posicaoEntre(ativas[i]?.position ?? null, ativas[i + 1]?.position ?? null);
    // `posicaoEntre` devolve NaN com vizinhas de MESMA posição (funil que
    // precisa de rebalanceamento). NaN vira `null` no JSON e a coluna é NOT NULL:
    // seria um 23502 cru. Recusar aqui é a diferença entre "tente de novo" e
    // "null value in column position violates not-null constraint".
    if (!Number.isFinite(posicao)) {
      throw new ApiError(
        409,
        "state_conflict",
        undefined,
        deps.requestId,
        "As colunas deste funil estão empatadas na ordenação. Recarregue a página e mova a etapa para outro lugar.",
      );
    }
    patchDoAlvo.position = posicao;
  }

  // A marcação pode exigir DOIS updates (liberar a antiga, ocupar a nova); nome
  // e posição viajam junto com o update do alvo, nunca num terceiro.
  const updates: UpdateDeMarcacao[] = temMarcacao ? updatesDeMarcacao(etapas, stageId, pedido) : [];
  if (Object.keys(patchDoAlvo).length > 0) {
    const i = updates.findIndex((u) => u.stageId === stageId);
    if (i >= 0) updates[i] = { stageId, patch: { ...updates[i]!.patch, ...patchDoAlvo } };
    else updates.push({ stageId, patch: patchDoAlvo });
  }

  const autoria = autoriaDaMudanca(deps.actor);

  // ⚠️ EM SEQUÊNCIA, NA ORDEM QUE `updatesDeMarcacao` DEVOLVE.
  // `uniq_crm_stages_pipeline_won` e `_lost` são imediatos (não deferíveis):
  // marcar a nova antes de liberar a antiga é 23505 na cara do usuário.
  // Disparar em paralelo desfaz exatamente essa proteção.
  //
  // Ceiling conhecido: não há transação — se o segundo update falhar, o primeiro
  // fica. É recuperável porque a liberação sozinha só deixa o funil SEM etapa de
  // ganho (estado que a própria tela mostra e permite corrigir), e a resposta de
  // erro não mente sobre isso; a saída definitiva seria uma função SQL, que só
  // vale a pena se isto deixar de ser uma configuração ocasional.
  for (const u of updates) {
    const { error } = await deps.supabase
      .from("crm_stages")
      .update({ ...u.patch, ...autoria })
      .eq("id", u.stageId)
      .eq("organization_id", deps.organizationId)
      .eq("pipeline_id", pipelineId);
    if (!error) continue;

    const nome = etapas.find((e) => e.id === u.stageId)?.name ?? "escolhida";
    throw erroDeBanco(error as { code?: string; message: string }, nome, deps.requestId);
  }

  if (updates.length > 0) {
    const autor = autorDoAudit(deps.actor);
    void audit({
      action: "pipeline.stage_updated",
      actorUserId: autor.actorUserId,
      organizationId: deps.organizationId,
      resourceType: "crm_stage",
      resourceId: stageId,
      requestId: deps.requestId,
      metadata: { ...autor.metadata, pipeline_id: pipelineId, pedido, updates },
    });
  }

  return { funil: await funilDepois(deps, pipelineId), updates };
}

// ---------------------------------------------------------------------------
// arquivar
// ---------------------------------------------------------------------------

export interface EtapaArquivada {
  funil: { etapas: EtapaVisivel[] };
  /** Quantos negócios mudaram de coluna por causa do arquivamento. */
  negociosMovidos: number;
}

/**
 * ⚠️ ARQUIVA, NÃO APAGA. `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT`:
 * etapa com negócio não pode ser apagada — e não deveria mesmo, porque o
 * histórico dos negócios aponta para ela. Por isso arquivar exige destino para
 * os negócios.
 */
export async function arquivarEtapa(
  deps: DepsDeEtapa,
  input: { pipelineId: string; stageId: string; destinoId: string | null },
): Promise<EtapaArquivada> {
  const { pipelineId, stageId, destinoId } = input;
  const etapas = await funilOuNadaFeito(deps, pipelineId);
  const alvo = etapas.find((e) => e.id === stageId);
  if (!alvo) {
    throw new ApiError(404, "not_found", undefined, deps.requestId, "Etapa não encontrada.");
  }

  // Os negócios da etapa, com a contagem EXATA do banco no mesmo round-trip: a
  // contagem vai inteira para a mensagem de recusa ("escolha para onde vão os 2
  // negócios" sem dizer quantos são não ajuda ninguém a decidir), e as linhas
  // são o que a timeline de cada card precisa depois da mudança.
  const {
    data: negociosDaEtapa,
    count,
    error: contErr,
  } = await deps.supabase
    .from("crm_leads")
    .select("id, contact_id", { count: "exact" })
    .eq("organization_id", deps.organizationId)
    .eq("stage_id", stageId);
  if (contErr) {
    throw new ApiError(500, "internal_error", undefined, deps.requestId, contErr.message);
  }
  const negocios = count ?? 0;

  const veredito = validarArquivamento(etapas, stageId, { negocios, destinoId });
  // A CONTAGEM VAI EM `details`, não só dentro da frase. A tela pergunta "N
  // negócios estão nesta etapa, para onde eles vão?" e precisa do NÚMERO;
  // extraí-lo da mensagem com regex seria uma segunda régua que quebra na
  // primeira vez que alguém melhorar o texto.
  if (!veredito.ok) {
    throw new ApiError(
      422,
      "unprocessable_entity",
      // `precisa_destino` diz QUAL regra recusou. Sem ele a tela teria de
      // re-derivar o motivo ("tem negócio e não é de ganho/perda") e engoliria
      // qualquer recusa nova sobre uma etapa comum com negócios.
      { negocios, precisa_destino: veredito.precisaDestino === true },
      deps.requestId,
      veredito.erro,
    );
  }

  // ── POR QUE A RÉGUA DE CAMPOS OBRIGATÓRIOS (#1536) NÃO ENTRA AQUI ───────────
  //
  // Este UPDATE move N negócios de uma vez e é a ÚNICA porta de saída de uma
  // etapa que está sendo arquivada (`validarArquivamento` recusa arquivar com
  // negócio e sem destino). Aplicar `validaCamposExigidos` aqui seria decidir
  // por N fichas diferentes, e a recusa não teria saída nenhuma: a tela de
  // arquivamento não coleta campo de ficha, então o dono ficaria SEM COMO tirar
  // a coluna do quadro — nem saberia qual dos cards travou a operação. Bloquear
  // uma ação de CONFIGURAÇÃO por dado de ficha é decisão de produto nova, não
  // conserto do buraco do #1536, e por isso fica registrado aqui em vez de
  // imposto em silêncio (o CR do mantenedor aceita as duas saídas).
  //
  // O buraco em si fecha pelas portas de ENTRADA em etapa: arrasto, lote,
  // botão ganhar/perder, MCP, agente, handoff e agendamento passam todos pela
  // mesma régua, então o PRÓXIMO movimento destes cards — para uma etapa que
  // exige — é coberto. A comparação "mesma etapa passa" também não vira buraco
  // aqui: o destino deste UPDATE é SEMPRE outra etapa.
  //
  // ⚠️ OS NEGÓCIOS ANDAM PRIMEIRO. Arquivar antes de mover deixaria os cards
  // apontando para uma coluna fora do quadro se a segunda escrita falhasse —
  // sumiço silencioso, o pior desfecho possível aqui.
  if (negocios > 0 && destinoId) {
    const { error } = await deps.supabase
      .from("crm_leads")
      .update({ stage_id: destinoId })
      .eq("organization_id", deps.organizationId)
      .eq("stage_id", stageId);
    if (error) {
      // O texto do Postgres vai em `details`, não colado na frase: a mensagem é
      // o que a tela mostra ao dono da clínica.
      throw new ApiError(
        500,
        "internal_error",
        { erro: error.message },
        deps.requestId,
        `Não consegui mover os negócios de «${alvo.name}». A etapa continua no quadro — tente de novo.`,
      );
    }
  }

  const autoria = autoriaDaMudanca(deps.actor);
  const { error } = await deps.supabase
    .from("crm_stages")
    .update({ is_archived: true, ...autoria })
    .eq("id", stageId)
    .eq("organization_id", deps.organizationId)
    .eq("pipeline_id", pipelineId);
  if (error) {
    throw erroDeBanco(error as { code?: string; message: string }, alvo.name, deps.requestId);
  }

  // ⚠️ O CARD MUDOU DE COLUNA — A LINHA DO TEMPO DELE TEM QUE DIZER POR QUÊ.
  // O `api_audit_log` registra a ação de configuração, mas nenhuma tela de lead
  // o lê: sem isto o cliente vê o card noutra coluna e a timeline não explica
  // nada (doutrina do sistema vivo, §3). É UM insert multi-linha: uma ida ao
  // banco, tantas linhas quantos cards de fato se moveram.
  const movidos = destinoId ? (negociosDaEtapa ?? []) : [];
  if (movidos.length > 0) {
    const destinoNome = etapas.find((e) => e.id === destinoId)?.name ?? null;
    const { error: ativErr } = await deps.supabase.from("crm_lead_activities").insert(
      (movidos as Array<Record<string, unknown>>).map((lead) =>
        buildLeadActivityRow({
          organizationId: deps.organizationId,
          leadId: lead.id as string,
          contactId: (lead.contact_id as string | null) ?? null,
          type: "stage_changed",
          sourceModule: "crm",
          sourceId: stageId,
          actor: deps.actor,
          reason: `${stageChangeReason(alvo.name, destinoNome)} (a etapa «${alvo.name}» foi arquivada)`,
          payload: {
            from_stage_id: stageId,
            to_stage_id: destinoId,
            pipeline_id: pipelineId,
            stage_archived: true,
          },
        }),
      ),
    );
    // Falha BAIXO: os cards já se moveram e a operação não pode ser desfeita por
    // causa do rastro — mas falhar baixo é escolher não bloquear, não escolher
    // não contar (`registraFalhaDeAtividade` avisa em `event_log`).
    if (ativErr) {
      await registraFalhaDeAtividade(deps.supabase, {
        organizationId: deps.organizationId,
        leadId: (movidos[0] as Record<string, unknown>).id as string,
        tipo: "stage_changed",
        origem: `pipelines/${pipelineId}/stages/${stageId} arquivar (${movidos.length} negócios)`,
        erro: ativErr.message,
        requestId: deps.requestId,
      });
    }
  }

  const autor = autorDoAudit(deps.actor);
  void audit({
    action: "pipeline.stage_archived",
    actorUserId: autor.actorUserId,
    organizationId: deps.organizationId,
    resourceType: "crm_stage",
    resourceId: stageId,
    requestId: deps.requestId,
    metadata: {
      ...autor.metadata,
      pipeline_id: pipelineId,
      name: alvo.name,
      destino_id: destinoId,
      negocios_movidos: destinoId ? negocios : 0,
    },
  });

  return {
    funil: await funilDepois(deps, pipelineId),
    negociosMovidos: destinoId ? negocios : 0,
  };
}

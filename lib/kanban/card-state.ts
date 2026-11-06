import type { ScoreBand } from "@/lib/kanban/score-band";
import { resolveLeadOwner, type OwnerDisplay } from "@/lib/kanban/owner";
import type { Lead } from "@/lib/types/leads";

/**
 * O que o card do Kanban precisa saber — e SÓ isso.
 *
 * Explicitamente não é `Lead`: o card responde quatro perguntas (quanto vale ·
 * vai fechar · o que fazer agora · quem está tocando), e receber a linha inteira
 * do banco é o convite para uma quinta. Quem monta este objeto é o board, que
 * tem o estágio, a janela de esfriamento e o dono resolvidos.
 */
export interface CardInput {
  id: string;
  title: string;
  valueCents: number | null;
  /**
   * A mensalidade do negócio (fatia 1 da #3602) — e `null` quando não há.
   * É campo PRÓPRIO, e não uma soma com `valueCents`: o card mostra as duas
   * parcelas lado a lado, e quem monta o card não decide número nenhum.
   */
  recurringValueCents?: number | null;
  /** Periodicidade da recorrência (`monthly` na v1). */
  recurringPeriod?: string | null;
  currency: string | null;
  owner: OwnerDisplay;
  /** Nome do estágio atual — o "3d em Negociação" do rodapé. */
  stageName: string;
  /** Horas paradas no estágio (board calcula; null = sem sinal). */
  hoursInStage: number | null;
  /**
   * Esfriou pela janela DO ESTÁGIO. Quem classifica é o board, via
   * `resolveStageWindow` (lib/leads/risk-radar.ts) — o card não classifica nada:
   * um segundo classificador de esfriamento seria a doença que esta entrega cura.
   */
  isCooling: boolean;
  /** Wave 4 — próxima ação proposta pelo agente, aguardando decisão humana. */
  nextAction?: { label: string } | null;
  /**
   * Wave 7 — proposta de retomada VIVA, com o prazo dela.
   *
   * Só chega aqui se `status = 'pending'`: proposta decidida ou vencida é
   * histórico e não pode ocupar a faixa, senão o card ofereceria um botão para
   * algo que já acabou.
   */
  reactivation?: { proposalId: string; expiresAt: string };
  /**
   * Wave 5 — probabilidade 0-100 com evidência.
   *
   * `null` e `0` são COISAS DIFERENTES: null é "sinal insuficiente" (cenário
   * 17) e 0 é "calculei e deu zero". Quem trocar isto por `probability || …`
   * some com o zero legítimo; quem usar `?? 0` inventa score onde não há.
   */
  probability?: number | null;
  /**
   * A faixa PERSISTIDA, nunca derivada aqui.
   *
   * Recalcular a faixa a partir do número ignoraria a histerese e devolveria o
   * card piscando na fronteira — no único lugar onde o CHECK de coerência do
   * banco não alcança.
   */
  band?: ScoreBand | null;
  /** Até três, e só as que existem: cota se preenche, e lastro inventado passa na constraint. */
  scoreFactors?: Array<{ pontos: number; frase: string; ancora?: { kind: string; id: string } }>;
  scoreReason?: string | null;
  /** Uma tag canônica do pipeline vira ponto ao lado do título; o resto sai do card. */
  canonicalTag?: string | null;
  /** Todas as tags — fora do card, acessíveis no hover. */
  tags: string[];
}

/**
 * Monta o CardInput a partir do que o board tem em mãos. Pura e testável: é
 * aqui que se decide o que o card VÊ, e é o único lugar onde a linha do banco
 * encosta no card.
 */
export function buildCardInput(
  lead: Pick<
    Lead,
    | "id"
    | "title"
    | "value_cents"
    | "recurring_value_cents"
    | "recurring_period"
    | "currency"
    | "tags"
    | "stage_changed_at"
    | "created_at"
    | "owner_kind"
    | "owner_user_id"
    | "owner_agent_id"
    | "owner_agent"
    | "next_action"
    | "score"
  >,
  opts: {
    stageName: string;
    ownerNames: Map<string, string | null> | undefined;
    /** ids que o radar (fonte única) classificou como esfriando. */
    coolingIds?: Set<string>;
    /** Propostas de retomada VIVAS, por lead — só as `pending` chegam aqui. */
    reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
    /** `crm_pipelines.settings.canonical_tags` — só a primeira que o lead tiver. */
    canonicalTags?: string[];
    now?: Date;
  },
): CardInput {
  const reference = lead.stage_changed_at ?? lead.created_at;
  const now = opts.now ?? new Date();
  // "tempo no estágio" é medido pela ENTRADA no estágio, e a coluna que sabe
  // disso é `crm_leads.stage_changed_at` (carimbada por trigger na 0071). O
  // conserto anterior usava `last_activity_at` com um "ponytail" de que a Wave 3
  // tornaria aquilo exato — mas a Wave 3 nunca veio, e a promessa não se
  // comprou: atividade é tempo SEM RESPOSTA, não tempo na etapa. Qualquer nota
  // escrita na conversa zerava o rodapé de um negócio parado há semanas, e o
  // número mentia justamente para quem mais olhava o card.
  //
  // O `created_at` fica de reserva para o lead sem carimbo (dado legado): é a
  // única data honesta que existe nesse caso — inventar entrada no estágio a
  // partir da última mensagem seria o mesmo defeito com o sinal trocado.
  const hoursInStage = reference
    ? Math.max(0, (now.getTime() - new Date(reference).getTime()) / 3_600_000)
    : null;

  return {
    id: lead.id,
    title: lead.title,
    valueCents: lead.value_cents,
    // Sem `?? 0`: "não tem mensalidade" e "mensalidade zero" são estados
    // diferentes, e o card só desenha o segundo trecho quando o primeiro não é.
    recurringValueCents: lead.recurring_value_cents ?? null,
    recurringPeriod: lead.recurring_period ?? null,
    currency: lead.currency,
    owner: resolveLeadOwner(lead, opts.ownerNames),
    stageName: opts.stageName,
    hoursInStage,
    isCooling: opts.coolingIds?.has(lead.id) ?? false,
    // Proposta viva do negócio, se houver. `undefined` e não `null` porque a
    // ausência aqui é "não há proposta", não "há uma proposta vazia".
    reactivation: opts.reactivations?.get(lead.id),
    // Score ausente vira `null` explícito, não `undefined` por omissão: a
    // diferença entre "não tem" e "esqueci de passar" é a que o cenário 17 mede.
    probability: lead.score ? lead.score.probability : null,
    band: lead.score ? lead.score.band : null,
    scoreReason: lead.score?.reason ?? null,
    scoreFactors: lead.score?.factors ?? [],
    // Sem proposta o campo fica NULO, não vazio: `resolveCardState` já trata
    // "não tem" como estado normal, e um label em branco produziria o slot vazio
    // que o §5 proíbe (dado sem propósito ocupando linha).
    nextAction: lead.next_action ? { label: lead.next_action.label } : null,
    canonicalTag: (opts.canonicalTags ?? []).find((t) => lead.tags.includes(t)) ?? null,
    tags: lead.tags,
  };
}

/** O conteúdo da faixa ③ — um por vez, nunca acumulado. */
export type CardSlot =
  | { type: "awaiting"; label: string }
  | { type: "cooling"; label: string }
  | { type: "reactivation"; proposalId: string; expiresAt: string }
  | {
      type: "meter";
      probability: number;
      band: ScoreBand;
      reason: string;
      /** ATÉ três — as que existem, nunca preenchidas para fechar conta. */
      factors: Array<{ pontos: number; frase: string; ancora?: { kind: string; id: string } }>;
    }
  | { type: "idle" };

export interface CardState {
  kind: "awaiting" | "cooling" | "normal";
  /** Cor da borda de estado — a ÚNICA cor do card (Lei C). */
  border: "accent" | "warning" | "neutral";
  slot: CardSlot;
  /**
   * O rodapé mostra o número de horas/dias, ou só o nome do estágio.
   *
   * UM relógio por card: hoje "sem resposta há 6 dias" e "6d em Proposta
   * enviada" saem os dois de `last_activity_at`, então mostrar os dois é o
   * mesmo número duas vezes — ruído com cara de informação. Quando o slot já
   * conta o tempo, o rodapé fica só com o lugar ("em Proposta enviada").
   */
  showStageAge: boolean;
}

/**
 * Precedência estrita da faixa ③ (contrato de UI §5).
 *
 * Um lead pode estar em todos os estados ao mesmo tempo; o card mostra **só o
 * que exige decisão agora**. Empilhar os três é o que mata o Kanban — o card
 * não ganha informação, ganha estado.
 *
 * Função pura e única: card, radar e testes leem daqui. Precedência
 * reimplementada dentro de componente é rejeição de review.
 */
export function resolveCardState(
  input: CardInput,
  t: (texto: string) => string = (texto) => texto,
): CardState {
  if (input.nextAction?.label) {
    return {
      kind: "awaiting",
      border: "accent",
      slot: { type: "awaiting", label: input.nextAction.label },
      showStageAge: true,
    };
  }

  // A PROPOSTA DE RETOMADA SUBSTITUI O "ESFRIANDO", e a razão é a diferença
  // entre informar e permitir agir: `cooling` diz "este negócio parou";
  // `reactivation` diz "parou E aqui está o que fazer a respeito". Mostrar
  // "parado há 3 dias" quando existe uma proposta viva ESCONDE a decisão — e o
  // card cujo propósito é provocar decisão passaria a só descrever o problema.
  //
  // Continua PERDENDO para `awaiting`, por coerência com o cenário 24 já
  // decidido: quando há proposta do agente E o negócio está frio, o card mostra
  // só "Aguardando você". Duas decisões pendentes no mesmo card é a pilha que o
  // §5 proíbe.
  if (input.reactivation) {
    return {
      kind: "cooling",
      border: "warning",
      slot: {
        type: "reactivation",
        proposalId: input.reactivation.proposalId,
        expiresAt: input.reactivation.expiresAt,
      },
      // O prazo já ocupa a faixa; a idade no rodapé seria o mesmo dado por
      // outro caminho, e o prazo é o que decide se a pessoa age agora.
      showStageAge: false,
    };
  }

  if (input.isCooling) {
    return {
      kind: "cooling",
      border: "warning",
      slot: { type: "cooling", label: coolingLabel(input.hoursInStage, t) },
      // O slot já contou o tempo; repetir no rodapé é o mesmo dado duas vezes.
      showStageAge: false,
    };
  }

  // `typeof === "number"` e NÃO truthiness: score 0 é um resultado, não a
  // ausência dele. `if (input.probability)` esconderia o zero legítimo.
  if (typeof input.probability === "number" && input.band) {
    return {
      kind: "normal",
      border: "neutral",
      slot: {
        type: "meter",
        probability: clampPercent(input.probability),
        band: input.band,
        reason: input.scoreReason ?? "",
        factors: (input.scoreFactors ?? []).slice(0, MAX_EVIDENCIAS),
      },
      showStageAge: true,
    };
  }

  // Sem sinal de IA ainda (waves 4 e 5 preenchem): a faixa continua existindo e
  // ocupando a mesma altura — o card não pode crescer quando o dado chegar.
  return { kind: "normal", border: "neutral", slot: { type: "idle" }, showStageAge: true };
}

/** Teto de evidências na tela. TETO, não cota — ver §7.55. */
const MAX_EVIDENCIAS = 3;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** "Sem resposta há 6 dias" — dias quando passa de 48h, senão horas. */
export function coolingLabel(
  hoursInStage: number | null,
  t: (texto: string) => string = (texto) => texto,
): string {
  if (hoursInStage == null) return t("Sem resposta");
  const hours = Math.max(0, Math.floor(hoursInStage));
  if (hours >= 48) return `${t("Sem resposta há")} ${Math.floor(hours / 24)} ${t("dias")}`;
  if (hours >= 1) return `${t("Sem resposta há")} ${hours}h`;
  return t("Sem resposta");
}

/** "3d" / "5h" / "agora" — o tempo parado no estágio, no rodapé do card. */
export function stageAgeLabel(
  hoursInStage: number | null,
  t: (texto: string) => string = (texto) => texto,
): string {
  if (hoursInStage == null) return "";
  const hours = Math.floor(hoursInStage);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h`;
  return t("agora");
}

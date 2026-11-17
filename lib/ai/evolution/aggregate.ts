/**
 * Agregador puro do Painel de Evolução (Fase 4 do épico do Harness).
 *
 * Recebe linhas cruas das seis fontes que as fases 0-3 depositaram e devolve o
 * payload que a tela consome. Sem efeito colateral, sem acesso a banco — a
 * rota busca, isto raciocina, e o teste não precisa de Postgres.
 *
 * A doutrina do sistema vivo pede que TODO número leve a uma ação. Por isso o
 * payload separa `activity` (o que aconteceu) de `gaps` (o que está travando):
 * o segundo bloco é o que o dono do negócio pode ir consertar hoje.
 */
import { daysBetween, toUtcDay } from '@/lib/ai/usage/aggregate';
import { LEAD_STAGES } from '@/lib/agent-engine/agent/lead-state';

export interface EvolutionInput {
  range: { from: Date; to: Date };
  memoryEntries: Array<{ created_at: string; title: string }>;
  proposalsApplied: Array<{ applied_at: string; type: string; content: string }>;
  /**
   * `skill_pointers` NÃO tem `created_at` — só `updated_at`, e ele é exatamente o
   * momento em que o ponteiro se moveu, isto é, quando a skill foi instalada ou
   * atualizada. É o que a spec chama de "skills instaladas/atualizadas".
   */
  skillInstalls: Array<{ updated_at: string; name: string }>;
  skillActivations: Array<{ created_at: string; skill_name: string }>;
  /**
   * `router_id` nulo é o turno de um NÚMERO SEM ROTEADOR (#4340): a linha existe
   * para deixar rastro, não é decisão de roteador nenhum, e não entra em nenhuma
   * conta deste painel — ver `decisoesDeRoteador` abaixo.
   */
  routerDecisions: Array<{
    created_at: string;
    outcome: string;
    intent_name: string | null;
    router_id?: string | null;
  }>;
  knowledgeSearches: Array<{
    created_at: string;
    hits: number;
    top_score: number | null;
    threshold: number;
    /**
     * `'human'` = o atendente perguntou pela caixa "Acervo" da conversa (0484).
     * Ausente conta como `'ai'`: é o default da coluna e o que toda linha
     * anterior à 0484 foi.
     */
    author_kind?: string | null;
  }>;
  stageTransitions: Array<{ created_at: string; to_stage: string }>;
  costCents: number;
  inboundCount: number;
  handoffCount: number;
  pipelines: Array<{ name: string; hints: Array<string | null> }>;
}

export interface TimelineItem {
  day: string;
  kind: 'memory' | 'proposal' | 'skill';
  title: string;
}

export interface EvolutionPayload {
  range: { from: string; to: string };
  learned: {
    memory_entries: number;
    proposals_applied: number;
    skills_installed: number;
    timeline: TimelineItem[];
  };
  activity: {
    series: {
      skill_activations: Array<{ day: string; value: number }>;
      router_decisions: Array<{ day: string; value: number }>;
      /** Só as buscas do AGENTE — é delas que os `gaps` de acervo falam. */
      knowledge_searches: Array<{ day: string; value: number }>;
      /** Buscas da EQUIPE pela caixa "Acervo" da conversa: série própria, nunca somada à do agente. */
      knowledge_searches_equipe: Array<{ day: string; value: number }>;
    };
    by_skill: Record<string, number>;
    by_intent: Record<string, number>;
  };
  outcome: {
    stage_transitions: number;
    won: number;
    lost: number;
    handoff_rate: number;
    cost_cents: number;
    /**
     * Mensagens recebidas de clientes na janela — o denominador de `handoff_rate`,
     * e o único campo do payload que responde "houve atendimento?".
     *
     * `cost_cents` NÃO responde: `llm_calls` inclui propósitos que não são
     * atendimento na janela — `connection_test` (script de ops) e os do flywheel,
     * cujo cron julga turnos PASSADOS e carimba o custo no dia em que rodou. Um
     * período sem nenhum atendimento teria custo > 0 e a tela concluiria que houve.
     */
    messages_received: number;
  };
  gaps: {
    unmapped_agent_steps: Array<{ pipeline_name: string; steps: string[] }>;
    /**
     * Quantos funis foram EXAMINADOS para produzir `unmapped_agent_steps`.
     * Sem isto, lista vazia é ambígua: pode ser "todo passo tem etapa" ou
     * "não existe funil nenhum" — e a segunda é o estado de instalação fresca
     * (não há provisionamento de pipeline padrão no install). A tela usaria a
     * ausência de lacuna como elogio a funis que não existem.
     */
    pipelines_evaluated: number;
    knowledge_near_misses: number;
    knowledge_empty: number;
    router_no_match: number;
    router_failed: number;
  };
}

/** Série diária densa: dia sem evento vale 0, nunca some do eixo. */
function serie(days: string[], rows: Array<{ created_at: string }>): Array<{ day: string; value: number }> {
  const contagem = new Map<string, number>();
  for (const r of rows) {
    const d = r.created_at.slice(0, 10);
    contagem.set(d, (contagem.get(d) ?? 0) + 1);
  }
  return days.map((day) => ({ day, value: contagem.get(day) ?? 0 }));
}

function contaPor<T>(rows: T[], chave: (r: T) => string | null): Record<string, number> {
  // ⚠️ SEM PROTÓTIPO, de propósito. As chaves aqui são nome de skill e nome de
  // intenção — texto do cliente (skill vem de .zip enviado; intenção é digitada
  // na config do roteador), e `skill_pointers.name` só exige `length > 0`. Num
  // objeto literal, `out['__proto__'] = (out['__proto__'] ?? 0) + 1` NÃO cria
  // propriedade própria: o setter de `__proto__` descarta o não-objeto e a
  // contagem some sem erro nenhum. `Object.create(null)` faz a chave virar dado
  // comum. Medido em node, não deduzido.
  const out: Record<string, number> = Object.create(null);
  for (const r of rows) {
    const k = chave(r);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function aggregateEvolution(input: EvolutionInput): EvolutionPayload {
  const days = daysBetween(input.range.from, input.range.to);

  // Ordena pelo timestamp CRU e só depois trunca para o dia. Ordenar por `day`
  // desempata pelo bloco de origem (memória → proposta → skill), não pela hora:
  // uma proposta aplicada às 23h apareceria ABAIXO de uma skill instalada às 8h
  // do mesmo dia. Como o payload descarta a hora, a tela não teria como
  // consertar — a ordem tem que nascer certa aqui. `Date.parse` em vez de
  // comparação de texto porque as três fontes podem serializar o fuso diferente
  // ('…Z' vs '…+00:00'), e aí a ordem lexicográfica mente.
  const timeline: TimelineItem[] = [
    ...input.memoryEntries.map((m) => ({ at: m.created_at, kind: 'memory' as const, title: m.title })),
    ...input.proposalsApplied.map((p) => ({
      at: p.applied_at,
      kind: 'proposal' as const,
      title: p.content.slice(0, 120),
    })),
    ...input.skillInstalls.map((s) => ({ at: s.updated_at, kind: 'skill' as const, title: s.name })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map(({ at, kind, title }) => ({ day: at.slice(0, 10), kind, title }));

  // "Quase acertou" é a busca que NÃO trouxe nada e cujo melhor candidato ficou
  // logo abaixo do limiar. É o sinal que separa "a base não tem isso" de "a base
  // tem e o corte está apertado demais" — dois problemas com consertos opostos.
  const PERTO = 0.1;
  // A busca do ATENDENTE não entra aqui: a tela lê `knowledge_empty` como
  // "pergunta de cliente que o agente não soube responder", e a pergunta
  // exploratória de quem opera não é nenhuma das duas coisas.
  const buscasDoAgente = input.knowledgeSearches.filter((k) => k.author_kind !== 'human');
  const buscasDaEquipe = input.knowledgeSearches.filter((k) => k.author_kind === 'human');
  let nearMisses = 0;
  let empty = 0;
  for (const k of buscasDoAgente) {
    if (k.hits > 0) continue;
    empty += 1;
    // ⚠️ COERÇÃO OBRIGATÓRIA. `top_score` e `threshold` são `numeric` no Postgres,
    // e `numeric` não tem parser default no node-postgres — chega como STRING
    // ('0.910667'). A comparação string×string não lança e não erra sempre:
    // `'0.144' >= '0.62'` dá false pelo motivo errado, e `'0.9' >= '0.72'` dá
    // true também pelo motivo errado. O tipo declarado aqui é `number`, então o
    // TypeScript não pega — é o pior formato de defeito, o que acerta por acaso.
    // Medido na prova real da Task 2, contra o banco.
    // `?? NaN` porque `Number(null)` é **0**, não NaN. Sem ele, um limiar ausente
    // vira corte zero e TODA busca vazia conta como "quase acertou" — a tela diria
    // ao dono do negócio "seu corte está apertado demais" sobre uma base que
    // simplesmente não tem o conteúdo. Conselho errado com cara de diagnóstico.
    // O `not null` da 0086 torna isso inalcançável pela produção; o guarda existe
    // pela assimetria do custo, não pela probabilidade.
    const nota = Number(k.top_score ?? NaN);
    const limiar = Number(k.threshold ?? NaN);
    // `nota < limiar` é a metade "abaixo do limiar" da regra. Hoje o único emissor
    // (`search-knowledge.ts`) garante `hits === 0 ⇒ top_score < threshold`, mas essa
    // é invariante de OUTRO arquivo: sem os 4 caracteres, este código depende dela
    // em silêncio e passa a contar acerto como quase-acerto no dia em que ela mudar.
    if (Number.isFinite(nota) && Number.isFinite(limiar) && nota < limiar && nota >= limiar - PERTO) {
      nearMisses += 1;
    }
  }

  const unmapped = input.pipelines
    .map((p) => {
      const declarados = new Set(p.hints.filter((h): h is string => h !== null));
      return {
        pipeline_name: p.name,
        steps: LEAD_STAGES.filter((s) => !declarados.has(s)),
      };
    })
    .filter((p) => p.steps.length > 0);

  // O número sem roteador grava uma linha `no_match` com `router_id` nulo a
  // cada turno (#4340) — e esse é o estado NORMAL de quem nunca criou roteador.
  // Contá-la aqui viraria "o roteador não entendeu N conversas" numa instalação
  // que não tem roteador: lacuna falsa. Só decisão de roteador de verdade entra.
  const decisoesDeRoteador = input.routerDecisions.filter((r) => r.router_id !== null);

  return {
    range: { from: toUtcDay(input.range.from), to: toUtcDay(input.range.to) },
    learned: {
      memory_entries: input.memoryEntries.length,
      proposals_applied: input.proposalsApplied.length,
      skills_installed: input.skillInstalls.length,
      timeline,
    },
    activity: {
      series: {
        skill_activations: serie(days, input.skillActivations),
        router_decisions: serie(days, decisoesDeRoteador),
        knowledge_searches: serie(days, buscasDoAgente),
        knowledge_searches_equipe: serie(days, buscasDaEquipe),
      },
      by_skill: contaPor(input.skillActivations, (r) => r.skill_name),
      by_intent: contaPor(
        // Só estes três outcomes carregam `intent_name` não-nulo (ver
        // `resolve-turn-agent.ts`); os demais já cairiam no filtro de null.
        // Nomear a lista deixa a regra explícita em vez de acidental.
        decisoesDeRoteador.filter((r) => r.outcome === 'classified' || r.outcome === 'sticky' || r.outcome === 'reclassified'),
        (r) => r.intent_name,
      ),
    },
    outcome: {
      stage_transitions: input.stageTransitions.length,
      won: input.stageTransitions.filter((t) => t.to_stage === 'won').length,
      lost: input.stageTransitions.filter((t) => t.to_stage === 'lost').length,
      handoff_rate: input.inboundCount > 0 ? input.handoffCount / input.inboundCount : 0,
      cost_cents: input.costCents,
      messages_received: input.inboundCount,
    },
    gaps: {
      unmapped_agent_steps: unmapped,
      pipelines_evaluated: input.pipelines.length,
      knowledge_near_misses: nearMisses,
      knowledge_empty: empty,
      router_no_match: decisoesDeRoteador.filter((r) => r.outcome === 'no_match').length,
      router_failed: decisoesDeRoteador.filter((r) => r.outcome === 'classifier_failed').length,
    },
  };
}

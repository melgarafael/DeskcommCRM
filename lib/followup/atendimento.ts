/**
 * Fluxo de ATENDIMENTO (surface `atendimento`) — checklist linear em tempo real.
 *
 * Diferente do follow-up (retomada, conduzido pelo RELÓGIO), este fluxo é
 * conduzido pelo TURNO: a cada mensagem o executor olha o grafo pinado, calcula
 * quais perguntas (`collect`) ainda faltam e injeta isso no contexto do agente.
 * Quando os obrigatórios estão preenchidos — ou esgotaram as tentativas — o fluxo
 * conclui e as perguntas param.
 *
 * Regras que o dono pediu e que moram aqui:
 *  - o dado guardado é o NORMALIZADO (o agente interpreta e grava o sentido);
 *  - o cliente pode dar vários dados de uma vez (o agente preenche o que couber,
 *    mesmo antes de a pergunta ter sido feita);
 *  - o cliente pode CORRIGIR um dado, quando o campo permite;
 *  - uma pergunta não respondida é repetida até `max_tentativas_pergunta`; depois
 *    disso é encerrada como não respondida e não bloqueia a conclusão.
 *
 * ## Por que "checklist linear" nesta versão
 *
 * O grafo completo tem condições, classificação por IA, esperas e laços — isso é
 * do motor de follow-up. Para o atendimento, a peça que resolve o problema é a
 * SEQUÊNCIA de perguntas. Esta versão suporta `trigger → collect/skill → end` por
 * arestas `always`, e REPORTA erro claro quando o grafo ramifica.
 */
import type pg from "pg";

import { logger } from "@/lib/logger";

import {
  flowGraphSchema,
  type EndFinish,
  type FlowGraph,
  type FlowNode,
} from "./graph-schema";
import type { ContactFlowEventKind } from "./contact-flow-data";
import { classificarInbound, type CampoPendenteParaCaptura } from "./captura-do-fluxo";

export type PassoDeAtendimento =
  | { kind: "collect"; node: Extract<FlowNode, { type: "collect" }> }
  | { kind: "skill"; node: Extract<FlowNode, { type: "skill" }> };

export interface ChecklistDeAtendimento {
  passos: PassoDeAtendimento[];
  fim: Extract<FlowNode, { type: "end" }>;
}

export type ResultadoDoChecklist =
  | { ok: true; checklist: ChecklistDeAtendimento }
  | { ok: false; erro: string };

const MAX_PASSOS = 100;
const MAX_TENTATIVAS_PADRAO = 3;

/**
 * Lê a sequência de perguntas/skills do grafo, do gatilho até o Fim, seguindo
 * arestas `always`. Recusa ramificação e nós fora do vocabulário do atendimento
 * com motivo escrito.
 */
export function mapearChecklist(graph: FlowGraph): ResultadoDoChecklist {
  const gatilhos = graph.nodes.filter((n) => n.type === "trigger");
  if (gatilhos.length !== 1) {
    return { ok: false, erro: "o fluxo precisa de exatamente um nó de início" };
  }

  const porId = new Map(graph.nodes.map((n) => [n.id, n]));
  const saidas = new Map<string, typeof graph.edges>();
  for (const e of graph.edges) {
    const lista = saidas.get(e.source) ?? [];
    lista.push(e);
    saidas.set(e.source, lista);
  }

  const passos: PassoDeAtendimento[] = [];
  const visitados = new Set<string>();
  let atual: FlowNode | undefined = gatilhos[0];

  while (atual !== undefined) {
    if (visitados.has(atual.id)) return { ok: false, erro: "o fluxo tem um ciclo" };
    visitados.add(atual.id);
    if (visitados.size > MAX_PASSOS) return { ok: false, erro: "o fluxo é longo demais" };

    if (atual.type === "collect") {
      passos.push({ kind: "collect", node: atual });
    } else if (atual.type === "skill") {
      passos.push({ kind: "skill", node: atual });
    } else if (atual.type === "end") {
      return { ok: true, checklist: { passos, fim: atual } };
    } else if (atual.type !== "trigger") {
      return {
        ok: false,
        erro: `o nó "${atual.label}" (${atual.type}) não é do atendimento — use perguntas, skills e o fim`,
      };
    }

    const arestas = saidas.get(atual.id) ?? [];
    if (arestas.length === 0) return { ok: false, erro: `o nó "${atual.label}" não tem saída` };
    if (arestas.length > 1) {
      return { ok: false, erro: "ramificação não é suportada no fluxo de atendimento nesta versão" };
    }
    const aresta = arestas[0]!;
    if (aresta.condition.type !== "always") {
      return { ok: false, erro: "no atendimento, as etapas são ligadas direto (sem condição)" };
    }
    atual = porId.get(aresta.target);
  }

  return { ok: false, erro: "o fluxo não termina em um nó Fim" };
}

export interface SituacaoDoChecklist {
  /** Perguntas sem valor e ainda com tentativas disponíveis — o que perguntar. */
  pendentes: Array<Extract<FlowNode, { type: "collect" }>>;
  /** Só as obrigatórias nessa condição — o que impede a conclusão. */
  obrigatoriosPendentes: Array<Extract<FlowNode, { type: "collect" }>>;
  /** Perguntas encerradas por não resposta (atingiram o teto de tentativas). */
  esgotadas: Array<Extract<FlowNode, { type: "collect" }>>;
  /** Nomes das skills que o fluxo puxa em paralelo. */
  skills: string[];
  /** true = não falta nenhum obrigatório (preenchido ou esgotado). */
  completo: boolean;
}

export function situacaoDoChecklist(
  checklist: ChecklistDeAtendimento,
  valores: ReadonlySet<string>,
  opts: { tentativas?: Record<string, number>; maxTentativas?: number } = {},
): SituacaoDoChecklist {
  const tentativas = opts.tentativas ?? {};
  const maxTentativas = opts.maxTentativas ?? MAX_TENTATIVAS_PADRAO;
  const pendentes: SituacaoDoChecklist["pendentes"] = [];
  const obrigatoriosPendentes: SituacaoDoChecklist["obrigatoriosPendentes"] = [];
  const esgotadas: SituacaoDoChecklist["esgotadas"] = [];
  const skills: string[] = [];

  for (const passo of checklist.passos) {
    if (passo.kind === "skill") {
      skills.push(passo.node.config.skill_name);
      continue;
    }
    const key = passo.node.config.key;
    if (valores.has(key)) continue;
    if ((tentativas[key] ?? 0) >= maxTentativas) {
      esgotadas.push(passo.node);
      continue;
    }
    pendentes.push(passo.node);
    if (passo.node.config.required) obrigatoriosPendentes.push(passo.node);
  }

  return {
    pendentes,
    obrigatoriosPendentes,
    esgotadas,
    skills,
    // O fluxo percorre TODOS os passos, inclusive os opcionais: `completo` só
    // quando não há mais nada a perguntar. Antes era
    // `obrigatoriosPendentes.length === 0`, e o efeito medido (2026-09-18) foi
    // que os passos OPCIONAIS nunca eram perguntados — o fluxo concluía assim
    // que os obrigatórios preenchiam, e "estado de conservação"/"documentação"
    // ficavam em branco. "Opcional" significa que pode ser ESGOTADO sem travar
    // (o teto de tentativas o tira de `pendentes`), não que pode ser pulado.
    completo: pendentes.length === 0,
  };
}
/** O nó `collect` de uma chave, ou `null` se a chave não pertence ao fluxo. */
export function campoPorChave(
  checklist: ChecklistDeAtendimento,
  key: string,
): Extract<FlowNode, { type: "collect" }> | null {
  for (const passo of checklist.passos) {
    if (passo.kind === "collect" && passo.node.config.key === key) return passo.node;
  }
  return null;
}

function normalizarTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export interface FluxoComGatilhos {
  id: string;
  nome: string;
  gatilhos: string[];
}

/**
 * Qual fluxo LIGA por palavra-gatilho (entrada pelo motor, sem modelo). Ganha o
 * que tiver MAIS gatilhos presentes na mensagem; empate/zero ⇒ `null`.
 * Puro, para testar sem banco.
 */
export function melhorFluxoPorGatilho(
  fluxos: readonly FluxoComGatilhos[],
  texto: string,
): FluxoComGatilhos | null {
  const alvo = normalizarTexto(texto);
  if (alvo === "") return null;
  let melhor: FluxoComGatilhos | null = null;
  let melhorHits = 0;
  for (const f of fluxos) {
    const hits = f.gatilhos.filter((g) => {
      const ng = normalizarTexto(g);
      return ng !== "" && alvo.includes(ng);
    }).length;
    if (hits > melhorHits) {
      melhor = f;
      melhorHits = hits;
    }
  }
  return melhor;
}

/**
 * Bloco injetado no contexto do turno. Só existe quando o fluxo foi ACIONADO
 * (enrollment ativo) — sem fluxo, nada disto é enviado à IA.
 */
export function renderBlocoDeAtendimento(
  estado: EstadoDeAtendimento,
  finalizacao?: EndFinish,
): string {
  // O "passa-bastão" do fluxo ANTERIOR (quando este foi encadeado): o que já foi
  // respondido não se repergunta, e o próximo passo da venda começa daqui.
  const contexto =
    estado.notaAnterior !== undefined && estado.notaAnterior.length > 0
      ? `Contexto do atendimento anterior: ${estado.notaAnterior}\n\n`
      : "";

  if (estado.situacao.pendentes.length === 0) {
    const nota =
      finalizacao?.tipo === "skill"
        ? `O fluxo foi concluído. Puxe agora a skill ${finalizacao.skill_name}.`
        : finalizacao?.tipo === "ia"
          ? "O fluxo foi concluído — siga o atendimento normalmente."
          : "O fluxo foi concluído — siga o atendimento normalmente.";
    return `${contexto}## Fluxo de atendimento — ${estado.nomeDoFluxo}\n${nota}`;
  }

  const linhas = estado.situacao.pendentes.map((n) => {
    const cfg = n.config;
    const obrig = cfg.required ? "obrigatória" : "opcional";
    const opcoes =
      cfg.type === "select" && (cfg.options?.length ?? 0) > 0
        ? ` Opções: ${cfg.options!.join(", ")}.`
        : "";
    const sugerida = cfg.question ? ` Pergunta sugerida: "${cfg.question}".` : "";
    const corrige = cfg.permite_correcao ? "" : " Não aceite correção depois de preenchida.";
    return `- ${cfg.label} (campo: ${cfg.key}, tipo ${cfg.type}, ${obrig}).${opcoes}${sugerida}${corrige}`;
  });

  return [
    `${contexto}## Fluxo de atendimento ativo — ${estado.nomeDoFluxo}`,
    "Este fluxo foi acionado e precisa ser concluído. Atenda o cliente PRIMEIRO; encaixe no máximo UMA pergunta por resposta, quando houver abertura.",
    "Se o cliente já informar um dado pendente — mesmo sem você ter perguntado —, registre com flow_collect: não pergunte o que ele já disse.",
    "Guarde o valor NORMALIZADO (o sentido do que ele disse), em `valor`: sim/não vira true/false; número só com dígitos; data em AAAA-MM-DD; escolha vira uma das opções; texto livre é o sentido resumido. Mande o texto cru do cliente em `bruto`.",
    "Se o cliente corrigir um dado já preenchido, o sistema registra a correção — não chame flow_collect para isso; apenas reconheça a mudança na conversa.",
    `Pergunta sem resposta pode ser repetida no máximo ${estado.maxTentativas} vez(es); depois disso, pare de perguntá-la.`,
    "Perguntas pendentes:",
    ...linhas,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Banco
// ─────────────────────────────────────────────────────────────────────────────

export interface EnrollmentDeAtendimento {
  id: string;
  pointer_id: string;
  version_id: string;
  contact_id: string;
  current_node_id: string;
  status: string;
}

export interface EstadoDeAtendimento {
  enrollment: EnrollmentDeAtendimento;
  nomeDoFluxo: string;
  checklist: ChecklistDeAtendimento;
  valores: Record<string, string>;
  tentativas: Record<string, number>;
  maxTentativas: number;
  situacao: SituacaoDoChecklist;
  /**
   * Síntese do fluxo ANTERIOR do mesmo contato (`completion_note` do último
   * enrollment de atendimento concluído). É o "passa-bastão" do encadeamento:
   * entra no bloco do turno para o próximo passo não reperguntar nem recomeçar.
   */
  notaAnterior?: string;
}

/**
 * Fluxo de atendimento ATIVO de um contato: o enrollment mais recente ligado a um
 * pointer `surface='atendimento'`. Os valores são lidos por CONTATO+FLUXO (não por
 * enrollment): o que o cliente já respondeu uma vez não é perguntado de novo numa
 * nova execução. `null` quando não há fluxo ou o grafo é irrecuperável.
 */
export async function carregarEstadoDeAtendimento(
  db: pg.Pool,
  args: { organizationId: string; contactId: string },
): Promise<EstadoDeAtendimento | null> {
  const { rows } = await db.query<{
    id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    current_node_id: string;
    status: string;
    nome: string;
    graph: unknown;
  }>(
    `select e.id, e.pointer_id, e.version_id, e.contact_id, e.current_node_id, e.status,
            p.name as nome, v.graph
       from followup_enrollments e
       join followup_flow_pointers p on p.id = e.pointer_id
       join followup_flow_versions v on v.id = e.version_id
      where e.organization_id = $1
        and e.contact_id = $2
        and p.surface = 'atendimento'
        -- Fluxo DESATIVADO para de guiar na hora: sem este filtro, desativar um
        -- fluxo na tela não interrompia a execução em voo, e o bot seguia
        -- perguntando (achado da auditoria). O enrollment órfão não roda e, se o
        -- fluxo voltar a 'active', retoma.
        and p.status = 'active'
        and e.status in ('active', 'waiting_reply')
      order by e.updated_at desc
      limit 1`,
    [args.organizationId, args.contactId],
  );
  const row = rows[0];
  if (!row) return null;

  const parsed = flowGraphSchema.safeParse(row.graph);
  if (!parsed.success) return null;
  const checklist = mapearChecklist(parsed.data);
  if (!checklist.ok) return null;

  const dados = await db.query<{ field_key: string; value: string | null; attempts: number }>(
    `select field_key, value, attempts from contact_flow_data
      where organization_id = $1 and contact_id = $2 and flow_pointer_id = $3`,
    [args.organizationId, args.contactId, row.pointer_id],
  );
  const valores: Record<string, string> = {};
  const tentativas: Record<string, number> = {};
  for (const v of dados.rows) {
    if (v.value !== null) valores[v.field_key] = v.value;
    tentativas[v.field_key] = v.attempts;
  }
  const maxTentativas =
    parsed.data.settings?.max_tentativas_pergunta ?? MAX_TENTATIVAS_PADRAO;

  // "Passa-bastão": a síntese do último fluxo CONCLUÍDO deste contato. Ausente
  // quando é o primeiro fluxo (ou quando a síntese não chegou a ser gravada).
  const anterior = await db.query<{ completion_note: string | null }>(
    `select e.completion_note
       from followup_enrollments e
       join followup_flow_pointers p on p.id = e.pointer_id
      where e.organization_id = $1
        and e.contact_id = $2
        and p.surface = 'atendimento'
        and e.status = 'completed'
        and e.completion_note is not null
      order by e.completed_at desc nulls last
      limit 1`,
    [args.organizationId, args.contactId],
  );
  const notaAnterior = anterior.rows[0]?.completion_note ?? undefined;

  return {
    enrollment: {
      id: row.id,
      pointer_id: row.pointer_id,
      version_id: row.version_id,
      contact_id: row.contact_id,
      current_node_id: row.current_node_id,
      status: row.status,
    },
    nomeDoFluxo: row.nome,
    checklist: checklist.checklist,
    valores,
    tentativas,
    maxTentativas,
    situacao: situacaoDoChecklist(checklist.checklist, new Set(Object.keys(valores)), {
      tentativas,
      maxTentativas,
    }),
    ...(notaAnterior !== undefined ? { notaAnterior } : {}),
  };
}

/**
 * Grava uma resposta (upsert por org+contato+fluxo+campo). `value` guarda o texto
 * CRU e `valueJson` o NORMALIZADO — é o normalizado que o sistema usa.
 */
export async function registrarDadoDoFluxo(
  db: pg.Pool,
  args: {
    organizationId: string;
    contactId: string;
    flowPointerId: string;
    enrollmentId: string;
    fieldKey: string;
    value: string;
    valueJson?: unknown;
    source: "client" | "agent" | "deterministic";
  },
): Promise<void> {
  await db.query(
    `insert into contact_flow_data
        (organization_id, contact_id, flow_pointer_id, enrollment_id, field_key, value, value_json, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (organization_id, contact_id, flow_pointer_id, field_key)
     do update set value = excluded.value,
                   value_json = excluded.value_json,
                   source = excluded.source,
                   enrollment_id = excluded.enrollment_id,
                   updated_at = now()`,
    [
      args.organizationId,
      args.contactId,
      args.flowPointerId,
      args.enrollmentId,
      args.fieldKey,
      args.value,
      args.valueJson ?? null,
      args.source,
    ],
  );
}

/**
 * Registra um evento na trilha da execução (`contact_flow_events`). Best-effort:
 * falha de telemetria NUNCA derruba o turno — quem chama envolve em try/catch.
 */
export async function registrarEventoDoFluxo(
  db: pg.Pool,
  args: {
    organizationId: string;
    enrollmentId: string;
    flowPointerId: string;
    contactId: string;
    kind: ContactFlowEventKind;
    messageId?: string | null;
    fieldKey?: string | null;
    payload?: unknown;
  },
): Promise<void> {
  await db.query(
    `insert into contact_flow_events
        (organization_id, enrollment_id, flow_pointer_id, contact_id, kind, message_id, field_key, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      args.organizationId,
      args.enrollmentId,
      args.flowPointerId,
      args.contactId,
      args.kind,
      args.messageId ?? null,
      args.fieldKey ?? null,
      args.payload ?? {},
    ],
  );
}

/** Soma 1 tentativa na pergunta (ela vai ser feita neste turno). */export async function incrementarTentativa(
  db: pg.Pool,
  args: {
    organizationId: string;
    contactId: string;
    flowPointerId: string;
    enrollmentId: string;
    fieldKey: string;
  },
): Promise<void> {
  await db.query(
    `insert into contact_flow_data
        (organization_id, contact_id, flow_pointer_id, enrollment_id, field_key, attempts)
     values ($1, $2, $3, $4, $5, 1)
     on conflict (organization_id, contact_id, flow_pointer_id, field_key)
     do update set attempts = contact_flow_data.attempts + 1,
                   enrollment_id = excluded.enrollment_id,
                   updated_at = now()`,
    [
      args.organizationId,
      args.contactId,
      args.flowPointerId,
      args.enrollmentId,
      args.fieldKey,
    ],
  );
}

/**
 * Marca o turno: incrementa a tentativa da PRÓXIMA pergunta pendente e, se com
 * isso ela esgotou (ou se não havia pendente), recalcula a situação. Devolve o
 * estado atualizado e se o fluxo CONCLUIU por esgotamento (sem novo valor).
 */
export async function registrarTentativaDoTurno(
  db: pg.Pool,
  args: { organizationId: string; estado: EstadoDeAtendimento },
): Promise<{ estado: EstadoDeAtendimento; concluiu: boolean }> {
  const { estado } = args;
  const primeira = estado.situacao.pendentes[0];
  if (!primeira) return { estado, concluiu: estado.situacao.completo };

  await incrementarTentativa(db, {
    organizationId: args.organizationId,
    contactId: estado.enrollment.contact_id,
    flowPointerId: estado.enrollment.pointer_id,
    enrollmentId: estado.enrollment.id,
    fieldKey: primeira.config.key,
  });

  const tentativas = {
    ...estado.tentativas,
    [primeira.config.key]: (estado.tentativas[primeira.config.key] ?? 0) + 1,
  };
  const situacao = situacaoDoChecklist(estado.checklist, new Set(Object.keys(estado.valores)), {
    tentativas,
    maxTentativas: estado.maxTentativas,
  });
  const atualizado = { ...estado, tentativas, situacao };

  if (situacao.completo) {
    await finalizarFluxoDeAtendimento(db, {
      organizationId: args.organizationId,
      estado: atualizado,
      kind: "esgotado",
      payload: { esgotadas: situacao.esgotadas.map((n) => n.config.key) },
    });
    return { estado: atualizado, concluiu: true };
  }
  return { estado: atualizado, concluiu: false };
}

/** Recalcula a situação do checklist preservando o resto do estado. */
function recomputarSituacao(
  estado: EstadoDeAtendimento,
  valores: ReadonlySet<string>,
  tentativas: Record<string, number> = estado.tentativas,
): EstadoDeAtendimento {
  return {
    ...estado,
    situacao: situacaoDoChecklist(estado.checklist, valores, {
      tentativas,
      maxTentativas: estado.maxTentativas,
    }),
  };
}

/** O campo pendente como a captura determinística o enxerga. */
function comoCampoParaCaptura(
  no: Extract<FlowNode, { type: "collect" }>,
): CampoPendenteParaCaptura {
  return {
    key: no.config.key,
    label: no.config.label,
    type: no.config.type,
    ...(no.config.options !== undefined ? { options: no.config.options } : {}),
    ...(no.config.question !== undefined ? { question: no.config.question } : {}),
  };
}

export interface ResultadoDoInbound {
  estado: EstadoDeAtendimento;
  /** true = o fluxo concluiu neste processamento (resposta capturada ou esgotamento). */
  concluiu: boolean;
  /** Ação de finalização, quando concluiu. */
  finalizacao?: EndFinish;
}

/**
 * Processa o INBOUND contra a PRIMEIRA pergunta pendente antes de o modelo rodar:
 *
 *   - `respondeu`  → grava o valor normalizado (fonte `deterministic`) e conclui
 *                    se era o último obrigatório. NÃO conta tentativa.
 *   - `desviou`    → registra `fora_do_fluxo`; a pergunta continua pendente e a
 *                    tentativa NÃO conta (decisão 7 do plano robusto).
 *   - `ignorou`/`nao_identificado` → conta tentativa (a pergunta foi feita e não
 *                    veio resposta capturável); ao teto, esgota e conclui.
 *
 * Best-effort na gravação (falha não derruba o turno); a telemetria nunca conta
 * como bloqueio.
 */
export async function processarInboundDoFluxo(
  db: pg.Pool,
  args: {
    organizationId: string;
    estado: EstadoDeAtendimento;
    texto: string | null;
    messageId?: string | null;
    /**
     * Leitura do VALIDADOR (agente dedicado, ponto `flow_validate`), quando o
     * chamador conseguiu rodá-lo. Tem PRECEDÊNCIA sobre a captura determinística
     * porque ele vê o CONTEXTO da conversa — é o que evita gravar "ok"/2019 no
     * campo errado. Ausente = comportamento de antes (só o classificador puro).
     * Pode trazer VÁRIOS campos (respostas e/ou correções), em qualquer ordem —
     * o cliente costuma responder a mais de uma pergunta na mesma mensagem.
     */
    validacoes?: ReadonlyArray<{ campo: string; valor: string }> | undefined;
  },
): Promise<ResultadoDoInbound> {
  const { estado } = args;

  // IDEMPOTÊNCIA: um job de inbound RE-EXECUTADO (retry de fila) reprocessava a
  // MESMA mensagem contra o estado JÁ AVANÇADO do fluxo — e a abertura virava
  // resposta do campo seguinte (medido ao vivo, 2026-09-19: "quero dar minha
  // moto na troca" foi gravada em `troca_ano` no 2º processamento). Se a
  // mensagem já gerou `resposta`/`fora_do_fluxo` neste enrollment, não processa
  // de novo. Os eventos são a trilha que torna a operação idempotente.
  if (args.messageId !== undefined && args.messageId !== null) {
    try {
      const ja = await db.query<{ n: number }>(
        `select count(*)::int as n from contact_flow_events
          where organization_id = $1 and enrollment_id = $2
            and message_id = $3 and kind in ('resposta','fora_do_fluxo')`,
        [args.organizationId, estado.enrollment.id, args.messageId],
      );
      if ((ja.rows[0]?.n ?? 0) > 0) return { estado, concluiu: false };
    } catch {
      // best-effort: sem a checagem, o pior caso é o comportamento anterior.
    }
  }

  // MÚLTIPLAS validações do validador (respostas e correções), em QUALQUER ordem.
  // O cliente costuma responder a VÁRIAS perguntas na mesma mensagem ("é uma CG
  // 125 2015, 120 mil km, tá boa, doc em dia"); aplicamos TODAS de uma vez, para
  // nada ser reperguntado. Cada campo precisa ser uma pendente (resposta) ou um
  // já preenchido que permite correção.
  if (args.validacoes !== undefined && args.validacoes.length > 0) {
    const valoresNovos: Record<string, string> = { ...estado.valores };
    let aplicou = false;
    for (const v of args.validacoes) {
      const node = campoPorChave(estado.checklist, v.campo);
      if (node === null) continue;
      // Pendente = QUALQUER campo ainda não preenchido (não só o primeiro): o
      // cliente pode responder a todos de uma vez, em qualquer ordem.
      const ehPendente = estado.situacao.pendentes.some((n) => n.config.key === v.campo);
      const ehCorrecao =
        !ehPendente && node.config.permite_correcao && estado.valores[v.campo] !== undefined;
      if (!ehPendente && !ehCorrecao) continue;
      // NO-OP: o valor não mudou (turno atrasado/reprocessado) — não é ruído novo.
      if (v.valor === "" || v.valor === (valoresNovos[v.campo] ?? "")) continue;
      try {
        await registrarDadoDoFluxo(db, {
          organizationId: args.organizationId,
          contactId: estado.enrollment.contact_id,
          flowPointerId: estado.enrollment.pointer_id,
          enrollmentId: estado.enrollment.id,
          fieldKey: v.campo,
          value: v.valor,
          valueJson: {
            normalizado: v.valor,
            tipo: node.config.type,
            deterministico: true,
            ...(ehCorrecao ? { correcao: true } : {}),
          },
          source: "deterministic",
        });
      } catch {
        continue;
      }
      void registrarEventoDoFluxo(db, {
        organizationId: args.organizationId,
        enrollmentId: estado.enrollment.id,
        flowPointerId: estado.enrollment.pointer_id,
        contactId: estado.enrollment.contact_id,
        kind: "resposta",
        messageId: args.messageId ?? null,
        fieldKey: v.campo,
        payload: {
          normalizado: v.valor,
          deterministico: true,
          ...(ehCorrecao ? { correcao: true } : {}),
        },
      }).catch(() => {});
      valoresNovos[v.campo] = v.valor;
      aplicou = true;
    }
    if (!aplicou) return { estado, concluiu: false };

    const comValor = { ...estado, valores: valoresNovos };
    const atualizado = recomputarSituacao(comValor, new Set(Object.keys(valoresNovos)));
    if (!atualizado.situacao.completo) return { estado: atualizado, concluiu: false };
    const { finalizacao } = await finalizarFluxoDeAtendimento(db, {
      organizationId: args.organizationId,
      estado: atualizado,
      messageId: args.messageId ?? null,
      kind: "concluido",
    });
    return {
      estado: atualizado,
      concluiu: true,
      ...(finalizacao !== undefined ? { finalizacao } : {}),
    };
  }

  const primeiro = estado.situacao.pendentes[0];
  // Nada pendente COM todos os obrigatórios preenchidos = o fluxo JÁ concluiu
  // (os valores chegaram por outra via — `flow_collect` do modelo, captura
  // anterior). Fechar e encadear aqui é o que faz a venda continuar; antes,
  // este caminho devolvia sem concluir e o enrollment ficava `active` para
  // sempre (medido no teste ao vivo de 2026-09-18).
  if (primeiro === undefined) {
    if (estado.situacao.completo) {
      const { finalizacao } = await finalizarFluxoDeAtendimento(db, {
        organizationId: args.organizationId,
        estado,
        messageId: args.messageId ?? null,
        kind: "concluido",
      });
      return {
        estado,
        concluiu: true,
        ...(finalizacao !== undefined ? { finalizacao } : {}),
      };
    }
    return { estado, concluiu: false };
  }

  // O VALIDADOR decide, quando disponível: `respondeu` com valor → grava (abaixo);
  // `nao_respondeu` → aplica o classificador puro para decidir ENTRE desvio
  // (não conta tentativa) e aceno/silêncio (CONTA tentativa). Sem esta distinção,
  // "ok"/emoji repetidos viravam `fora_do_fluxo` e o teto de tentativas nunca
  // disparava — `max_tentativas_pergunta` ficava inerte (achado da auditoria,
  // 2026-09-19). Sem validação → classificador puro direto.
  // Chegou aqui = SEM validação do validador (ou nenhum campo aplicável): decide
  // pelo classificador puro (desvio x aceno/silêncio). As respostas e correções
  // do validador foram aplicadas no bloco acima.
  const leitura = classificarInbound(comoCampoParaCaptura(primeiro), args.texto);

  if (leitura.resultado === "desviou") {
    await registrarEventoDoFluxo(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      flowPointerId: estado.enrollment.pointer_id,
      contactId: estado.enrollment.contact_id,
      kind: "fora_do_fluxo",
      messageId: args.messageId ?? null,
      fieldKey: primeiro.config.key,
    }).catch(() => {});
    return { estado, concluiu: false };
  }

  if (leitura.resultado === "respondeu") {
    let gravou = false;
    try {
      await registrarDadoDoFluxo(db, {
        organizationId: args.organizationId,
        contactId: estado.enrollment.contact_id,
        flowPointerId: estado.enrollment.pointer_id,
        enrollmentId: estado.enrollment.id,
        fieldKey: primeiro.config.key,
        value: leitura.captura.bruto,
        valueJson: {
          normalizado: leitura.captura.valor,
          tipo: primeiro.config.type,
          deterministico: true,
        },
        source: "deterministic",
      });
      gravou = true;
    } catch {
      // best-effort: sem gravar, o campo segue pendente e o modelo pode registrar.
    }
    if (!gravou) return { estado, concluiu: false };

    void registrarEventoDoFluxo(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      flowPointerId: estado.enrollment.pointer_id,
      contactId: estado.enrollment.contact_id,
      kind: "resposta",
      messageId: args.messageId ?? null,
      fieldKey: primeiro.config.key,
      payload: { normalizado: leitura.captura.valor, tipo: primeiro.config.type, deterministico: true },
    }).catch(() => {});

    const valores = new Set(Object.keys(estado.valores));
    valores.add(primeiro.config.key);
    // O valor recém-capturado entra no estado ANTES de finalizar: é ele que a
    // síntese (`montarNotaDeConclusao`) precisa enxergar.
    const comValor = {
      ...estado,
      valores: { ...estado.valores, [primeiro.config.key]: leitura.captura.valor },
    };
    const atualizado = recomputarSituacao(comValor, valores);
    if (!atualizado.situacao.completo) return { estado: atualizado, concluiu: false };

    const { finalizacao } = await finalizarFluxoDeAtendimento(db, {
      organizationId: args.organizationId,
      estado: atualizado,
      messageId: args.messageId ?? null,
      kind: "concluido",
    });
    return {
      estado: atualizado,
      concluiu: true,
      ...(finalizacao !== undefined ? { finalizacao } : {}),
    };
  }

  // `ignorou` ou `nao_identificado`: a pergunta segue pendente e o turno conta
  // como tentativa (o teto é o freio contra a pergunta infinita).
  const r = await registrarTentativaDoTurno(db, { organizationId: args.organizationId, estado });
  return r.concluiu
    ? { estado: r.estado, concluiu: true, finalizacao: r.estado.checklist.fim.config.ao_finalizar }
    : { estado: r.estado, concluiu: false };
}

/**
 * Marca o enrollment de atendimento como concluído (as perguntas param).
 * `completionNote` é a SÍNTESE do fluxo (passa-bastão para a continuação);
 * quando ausente, a coluna fica como está (não apaga uma nota anterior).
 */
export async function concluirEnrollmentDeAtendimento(
  db: pg.Pool,
  args: { organizationId: string; enrollmentId: string; outcome: string; completionNote?: string },
): Promise<void> {
  await db.query(
    `update followup_enrollments
        set status = 'completed',
            outcome = $3,
            completed_at = now(),
            updated_at = now(),
            completion_note = coalesce($4, completion_note)
      where organization_id = $1 and id = $2 and status in ('active', 'waiting_reply')`,
    [args.organizationId, args.enrollmentId, args.outcome, args.completionNote ?? null],
  );
}

/**
 * SÍNTESE DETERMINÍSTICA do fluxo concluído — o "passa-bastão" para a
 * continuação. Robusta por construção (não depende de modelo): percorre os
 * passos na ordem e usa o valor NORMALIZADO guardado. Campos não respondidos
 * (esgotados) aparecem marcados, para o próximo fluxo/IA saber o que ficou em
 * aberto em vez de reperguntar.
 */
export function montarNotaDeConclusao(estado: EstadoDeAtendimento): string {
  const linhas = estado.checklist.passos
    .filter((p): p is Extract<PassoDeAtendimento, { kind: "collect" }> => p.kind === "collect")
    .map((p) => {
      const { key, label } = p.node.config;
      return `${label}: ${estado.valores[key] ?? "(não respondido)"}`;
    });
  const nota = `Fluxo "${estado.nomeDoFluxo}" — ${linhas.join("; ")}`;
  return nota.slice(0, 2000);
}

/**
 * Fecha um fluxo de atendimento: grava a síntese (`completion_note`), emite o
 * evento final e — se o nó Fim pedir `ao_finalizar: proximo_fluxo` — inicia o
 * PRÓXIMO fluxo da corrente (decisão 5: terminou o fluxo, continua a venda).
 *
 * Best-effort: toda falha é engolida para não derrubar o turno que já respondeu
 * ao cliente; a conclusão se repete no próximo turno se algo falhar aqui.
 */
export async function finalizarFluxoDeAtendimento(
  db: pg.Pool,
  args: {
    organizationId: string;
    estado: EstadoDeAtendimento;
    messageId?: string | null;
    /** `concluido` (completou) ou `esgotado` (teto de tentativas). */
    kind?: "concluido" | "esgotado";
    payload?: unknown;
  },
): Promise<{ finalizacao?: EndFinish; proximoEnrollmentId: string | null }> {
  const { estado } = args;
  const fim = estado.checklist.fim.config.ao_finalizar;
  const nota = montarNotaDeConclusao(estado);

  try {
    await concluirEnrollmentDeAtendimento(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      outcome: estado.checklist.fim.config.outcome,
      completionNote: nota,
    });
  } catch {
    // best-effort: a conclusão se repete no próximo turno.
  }
  void registrarEventoDoFluxo(db, {
    organizationId: args.organizationId,
    enrollmentId: estado.enrollment.id,
    flowPointerId: estado.enrollment.pointer_id,
    contactId: estado.enrollment.contact_id,
    kind: args.kind ?? "concluido",
    messageId: args.messageId ?? null,
    payload: args.payload ?? { nota },
  }).catch(() => {});

  // Síntese NATURAL (modelo) do que foi coletado. O motor garante a nota
  // determinística acima; o job `flow_summary` a enriquece quando o modelo
  // responde (e só então sobrescreve). Best-effort e DEDUPLICADO: não enfileira
  // um segundo job enquanto houver um vivo para esta execução.
  try {
    await db.query(
      `insert into job_queue (organization_id, contact_id, kind, payload)
       select $1, $2, 'flow_summary', $3::jsonb
        where not exists (
          select 1 from job_queue
           where organization_id = $1
             and kind = 'flow_summary'
             and status in ('pending', 'running')
             and payload->>'enrollment_id' = $4
        )`,
      [
        args.organizationId,
        estado.enrollment.contact_id,
        JSON.stringify({ enrollment_id: estado.enrollment.id }),
        estado.enrollment.id,
      ],
    );
  } catch (err) {
    // best-effort: sem o job, a nota determinística já cobre a continuação.
    logger.warn("[fluxo] enfileirar flow_summary falhou — o turno segue", {
      enrollment_id: estado.enrollment.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  let proximoEnrollmentId: string | null = null;
  // Autoencadeamento (fluxo → ele mesmo) é ignorado: seria um laço sem fim. Um
  // vínculo A→B→A é configuração do dono e só avança um passo por turno.
  if (fim?.tipo === "proximo_fluxo" && fim.fluxo !== estado.enrollment.pointer_id) {
    try {
      proximoEnrollmentId = await iniciarFluxoDeAtendimento(db, {
        organizationId: args.organizationId,
        contactId: estado.enrollment.contact_id,
        flowPointerId: fim.fluxo,
      });
      if (proximoEnrollmentId !== null) {
        void registrarEventoDoFluxo(db, {
          organizationId: args.organizationId,
          enrollmentId: estado.enrollment.id,
          flowPointerId: estado.enrollment.pointer_id,
          contactId: estado.enrollment.contact_id,
          kind: "encadeou",
          messageId: args.messageId ?? null,
          payload: { proximo_fluxo: fim.fluxo, proximo_enrollment_id: proximoEnrollmentId },
        }).catch(() => {});
      }
    } catch (err) {
      // best-effort: sem encadear, o fluxo apenas termina (não trava o turno).
      // Loga porque o desfecho silencioso é o defeito: o fluxo termina, o
      // próximo não começa, e nada na tela explica (auditoria 2026-09-19).
      logger.warn("[fluxo] encadear o próximo fluxo falhou — o fluxo só terminou", {
        enrollment_id: estado.enrollment.id,
        proximo_fluxo: fim.fluxo,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  return {
    ...(fim !== undefined ? { finalizacao: fim } : {}),
    proximoEnrollmentId,
  };
}

/**
 * ENTRADA POR GATILHO (motor): entre os fluxos ativos, qual LIGA pela mensagem
 * do cliente (palavra-gatilho). Independe do modelo e do roteador.
 */
export async function escolherFluxoPeloGatilho(
  db: pg.Pool,
  args: { organizationId: string; texto: string | null },
): Promise<{ id: string; nome: string } | null> {
  if (!args.texto) return null;
  const { rows } = await db.query<{ id: string; nome: string; graph: unknown }>(
    `select p.id, p.name as nome, v.graph
       from followup_flow_pointers p
       join followup_flow_versions v on v.id = p.active_version_id
      where p.organization_id = $1
        and p.surface = 'atendimento'
        and p.status = 'active'`,
    [args.organizationId],
  );
  const fluxos: FluxoComGatilhos[] = [];
  for (const row of rows) {
    const parsed = flowGraphSchema.safeParse(row.graph);
    if (!parsed.success) continue;
    const gatilhos = parsed.data.settings?.gatilhos ?? [];
    if (gatilhos.length > 0) fluxos.push({ id: row.id, nome: row.nome, gatilhos });
  }
  const melhor = melhorFluxoPorGatilho(fluxos, args.texto);
  return melhor === null ? null : { id: melhor.id, nome: melhor.nome };
}

/**
 * Fluxos de atendimento ATIVOS da organização (com versão publicada). É o que a
 * ferramenta `flow_start` oferece ao agente — o prompt/skill decide QUAL iniciar.
 */
export async function listarFluxosDeAtendimentoAtivos(
  db: pg.Pool,
  organizationId: string,
): Promise<Array<{ id: string; nome: string }>> {
  const { rows } = await db.query<{ id: string; nome: string }>(
    `select id, name as nome
       from followup_flow_pointers
      where organization_id = $1
        and surface = 'atendimento'
        and status = 'active'
        and active_version_id is not null
      order by name`,
    [organizationId],
  );
  return rows;
}

/**
 * Começa um fluxo de atendimento para o contato. Devolve o id do enrollment
 * criado, ou `null` quando não é para começar (pointer inativo, sem versão, grafo
 * inválido, ou já existir um enrollment vivo — o índice "1 vivo por contato").
 *
 * `next_eval_at` fica num FUTURO distante de propósito: o CHECK
 * `followup_enrollments_relogio_coerente` exige `next_eval_at` quando o status é
 * `active`, e o motor de RELÓGIO do follow-up só reivindica `next_eval_at <= now()`
 * — então um fluxo de atendimento nunca é consumido pelo tick. (NULL violaria o
 * CHECK; um futuro distante satisfaz os dois.)
 */
export async function iniciarFluxoDeAtendimento(
  db: pg.Pool,
  args: { organizationId: string; contactId: string; flowPointerId: string },
): Promise<string | null> {
  const { rows } = await db.query<{
    active_version_id: string | null;
    graph: unknown;
  }>(
    `select p.active_version_id, v.graph
       from followup_flow_pointers p
       join followup_flow_versions v on v.id = p.active_version_id
      where p.organization_id = $1
        and p.id = $2
        and p.status = 'active'
        and p.surface = 'atendimento'`,
    [args.organizationId, args.flowPointerId],
  );
  const row = rows[0];
  if (!row || row.active_version_id === null) return null;

  const parsed = flowGraphSchema.safeParse(row.graph);
  if (!parsed.success) return null;
  const checklist = mapearChecklist(parsed.data);
  if (!checklist.ok) return null;

  const gatilho = parsed.data.nodes.find((n) => n.type === "trigger");
  const inicio = gatilho?.id ?? checklist.checklist.passos[0]?.node.id;
  if (inicio === undefined) return null;

  try {
    const { rows: created } = await db.query<{ id: string }>(
      `insert into followup_enrollments
          (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
       values ($1, $2, $3, $4, $5, 'active', '2999-12-31T00:00:00Z')
       returning id`,
      [args.organizationId, args.flowPointerId, row.active_version_id, args.contactId, inicio],
    );
    const enrollmentId = created[0]?.id ?? null;
    if (enrollmentId !== null) {
      await registrarEventoDoFluxo(db, {
        organizationId: args.organizationId,
        enrollmentId,
        flowPointerId: args.flowPointerId,
        contactId: args.contactId,
        kind: 'iniciado',
      }).catch(() => {});
    }
    return enrollmentId;
  } catch (err) {
    // 23505 = índice "um enrollment vivo por contato" — o contato já está em
    // outro fluxo (ou neste). Não é erro do turno.
    if ((err as { code?: string }).code === "23505") return null;
    throw err;
  }
}

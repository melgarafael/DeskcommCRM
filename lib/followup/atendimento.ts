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

import { flowGraphSchema, type FlowGraph, type FlowNode } from "./graph-schema";
import type { EndFinish } from "./graph-schema";

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
    completo: obrigatoriosPendentes.length === 0,
  };
}

/** O nó `collect` de uma chave, ou `null` se a chave não pertence ao fluxo. */
export function campoPorChave(  checklist: ChecklistDeAtendimento,
  key: string,
): Extract<FlowNode, { type: "collect" }> | null {
  for (const passo of checklist.passos) {
    if (passo.kind === "collect" && passo.node.config.key === key) return passo.node;
  }
  return null;
}

/**
 * Bloco injetado no contexto do turno. Só existe quando o fluxo foi ACIONADO
 * (enrollment ativo) — sem fluxo, nada disto é enviado à IA.
 */
export function renderBlocoDeAtendimento(
  estado: EstadoDeAtendimento,
  finalizacao?: EndFinish,
): string {
  if (estado.situacao.pendentes.length === 0) {
    const nota =
      finalizacao?.tipo === "skill"
        ? `O fluxo foi concluído. Puxe agora a skill ${finalizacao.skill_name}.`
        : finalizacao?.tipo === "ia"
          ? "O fluxo foi concluído — siga o atendimento normalmente."
          : "O fluxo foi concluído — siga o atendimento normalmente.";
    return `## Fluxo de atendimento — ${estado.nomeDoFluxo}\n${nota}`;
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
    `## Fluxo de atendimento ativo — ${estado.nomeDoFluxo}`,
    "Este fluxo foi acionado e precisa ser concluído. Atenda o cliente PRIMEIRO; encaixe no máximo UMA pergunta por resposta, quando houver abertura.",
    "Se o cliente já informar um dado pendente — mesmo sem você ter perguntado —, registre com flow_collect: não pergunte o que ele já disse.",
    "Guarde o valor NORMALIZADO (o sentido do que ele disse), em `valor`: sim/não vira true/false; número só com dígitos; data em AAAA-MM-DD; escolha vira uma das opções; texto livre é o sentido resumido. Mande o texto cru do cliente em `bruto`.",
    "Se o cliente corrigir um dado já preenchido, chame flow_collect de novo com o novo valor (quando o campo permitir correção).",
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

/** Soma 1 tentativa na pergunta (ela vai ser feita neste turno). */
export async function incrementarTentativa(
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
    await concluirEnrollmentDeAtendimento(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      outcome: estado.checklist.fim.config.outcome,
    });
    return { estado: atualizado, concluiu: true };
  }
  return { estado: atualizado, concluiu: false };
}

/** Marca o enrollment de atendimento como concluído (as perguntas param). */
export async function concluirEnrollmentDeAtendimento(
  db: pg.Pool,
  args: { organizationId: string; enrollmentId: string; outcome: string },
): Promise<void> {
  await db.query(
    `update followup_enrollments
        set status = 'completed',
            outcome = $3,
            completed_at = now(),
            updated_at = now()
      where organization_id = $1 and id = $2 and status in ('active', 'waiting_reply')`,
    [args.organizationId, args.enrollmentId, args.outcome],
  );
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
    return created[0]?.id ?? null;
  } catch (err) {
    // 23505 = índice "um enrollment vivo por contato" — o contato já está em
    // outro fluxo (ou neste). Não é erro do turno.
    if ((err as { code?: string }).code === "23505") return null;
    throw err;
  }
}

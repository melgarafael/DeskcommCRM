/**
 * Fluxo de ATENDIMENTO (surface `atendimento`) — checklist linear em tempo real.
 *
 * Diferente do follow-up (retomada, conduzida pelo RELÓGIO), este fluxo é
 * conduzido pelo TURNO: a cada mensagem o executor olha o grafo pinado, calcula
 * quais perguntas (`collect`) ainda faltam e injeta isso no contexto do agente.
 * Quando os obrigatórios estão preenchidos, o fluxo conclui e as perguntas
 * param.
 *
 * ## Por que "checklist linear" nesta versão
 *
 * O grafo completo tem condições, classificação por IA, esperas e laços — tudo
 * isso é do motor de follow-up. Para o atendimento, a peça que resolve o
 * problema do dono ("perguntas em ordem; para quando completar") é a SEQUÊNCIA
 * de perguntas. Esta versão suporta `trigger → collect/skill → end` por arestas
 * `always`, e REPORTA erro claro quando o grafo ramifica — em vez de executar
 * pela metade. Condições no atendimento entram quando houver caso real.
 *
 * O módulo é separado em puro (grafo × valores → situação) e acesso a banco, para
 * a decisão ser testável sem Postgres.
 */
import type pg from "pg";

import { flowGraphSchema, type FlowGraph, type FlowNode } from "./graph-schema";

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

/**
 * Lê a sequência de perguntas/skills do grafo, do gatilho até o Fim, seguindo
 * arestas `always`. Recusa ramificação e nós fora do vocabulário do atendimento
 * com motivo escrito (o publish também valida; aqui é a defesa em runtime).
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
    if (arestas.length === 0) {
      return { ok: false, erro: `o nó "${atual.label}" não tem saída` };
    }
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
  /** Perguntas sem valor (inclui as opcionais) — o que ainda dá para perguntar. */
  pendentes: Array<Extract<FlowNode, { type: "collect" }>>;
  /** Só as obrigatórias sem valor — o que impede a conclusão. */
  obrigatoriosPendentes: Array<Extract<FlowNode, { type: "collect" }>>;
  /** Nomes das skills que o fluxo puxa em paralelo. */
  skills: string[];
  /** true = não falta nenhum obrigatório; o fluxo pode concluir. */
  completo: boolean;
}

export function situacaoDoChecklist(
  checklist: ChecklistDeAtendimento,
  valores: ReadonlySet<string>,
): SituacaoDoChecklist {
  const pendentes: SituacaoDoChecklist["pendentes"] = [];
  const obrigatoriosPendentes: SituacaoDoChecklist["obrigatoriosPendentes"] = [];
  const skills: string[] = [];

  for (const passo of checklist.passos) {
    if (passo.kind === "skill") {
      skills.push(passo.node.config.skill_name);
      continue;
    }
    if (valores.has(passo.node.config.key)) continue;
    pendentes.push(passo.node);
    if (passo.node.config.required) obrigatoriosPendentes.push(passo.node);
  }

  return { pendentes, obrigatoriosPendentes, skills, completo: obrigatoriosPendentes.length === 0 };
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

/**
 * Bloco injetado no contexto do turno para o agente saber o que perguntar.
 * Substitui (para o atendimento) o antigo bloco PENDENTES fixo: as perguntas
 * agora vêm do fluxo cadastrado, e somem quando o cliente completa.
 */
export function renderBlocoDeAtendimento(estado: EstadoDeAtendimento): string {
  const linhas = estado.situacao.pendentes.map((n) => {
    const obrig = n.config.required ? "obrigatória" : "opcional";
    const sugerida = n.config.question ? ` Pergunta sugerida: "${n.config.question}".` : "";
    return `- ${n.config.label} (campo: ${n.config.key}, ${obrig}).${sugerida}`;
  });
  return [
    `## Fluxo de atendimento ativo — ${estado.nomeDoFluxo}`,
    "Atenda o cliente PRIMEIRO. Encaixe no máximo UMA pergunta por resposta, quando houver abertura natural; não pare o assunto para preencher formulário.",
    "Assim que o cliente informar um dado pendente, chame flow_collect(campo, valor). Não pergunte de novo o que já foi preenchido.",
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
  situacao: SituacaoDoChecklist;
}

/**
 * Fluxo de atendimento ATIVO de um contato: o enrollment mais recente, ligado a
 * um pointer `surface='atendimento'`. Devolve o grafo pinado, os valores já
 * coletados e a situação (pendentes/skills). `null` quando não há fluxo.
 *
 * Grafo inválido (checklist irrecuperável) devolve `null` em vez de lançar: o
 * atendimento não pode cair por causa de um rascunho malformado.
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

  const valoresRows = await db.query<{ field_key: string; value: string | null }>(
    `select field_key, value from contact_flow_data
      where organization_id = $1 and enrollment_id = $2`,
    [args.organizationId, row.id],
  );
  const valores: Record<string, string> = {};
  for (const v of valoresRows.rows) {
    if (v.value !== null) valores[v.field_key] = v.value;
  }

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
    situacao: situacaoDoChecklist(checklist.checklist, new Set(Object.keys(valores))),
  };
}

/**
 * Grava uma resposta do fluxo (upsert por org+contato+fluxo+campo). O enrollment
 * é atualizado para o corrente — se a execução antiga foi limpa, o dado fica.
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
    source: "client" | "agent" | "deterministic";
  },
): Promise<void> {
  await db.query(
    `insert into contact_flow_data
        (organization_id, contact_id, flow_pointer_id, enrollment_id, field_key, value, source)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, contact_id, flow_pointer_id, field_key)
     do update set value = excluded.value,
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
      args.source,
    ],
  );
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
 * Começa um fluxo de atendimento para o contato (chamado quando o roteador casa
 * a intenção com um fluxo). Devolve o id do enrollment criado, ou `null` quando
 * não é para começar: pointer inexistente/inativo, sem versão publicada, grafo
 * inválido, ou já existir um enrollment vivo para o contato.
 *
 * `next_eval_at` fica NULL de propósito: o motor de RELÓGIO do follow-up só pega
 * enrollments com `next_eval_at <= now()`, então um fluxo de ATENDIMENTO nunca é
 * consumido pelo tick — quem o conduz é o turno.
 *
 * Best-effort contra a corrida do índice "1 enrollment vivo por contato": se a
 * inserção colidir (23505), devolve `null` em vez de estourar o turno.
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
       values ($1, $2, $3, $4, $5, 'active', null)
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

import { ROTULO_RECOMPRA, type SituacaoRecompra } from "@/lib/comercial/radar-compras";
import { comoMoeda } from "@/lib/format/moeda";

/**
 * NEXUS INTELLIGENCE — grafo funcional sobre dados reais.
 *
 * Cada nó representa entidade, métrica ou insight derivado de leitura real
 * (radar-compras, leads/at-risk, knowledge, memory, evolution). Nada é
 * decorativo: o painel de contexto consome estes mesmos nós.
 *
 * Regra de honestidade: aresta/nó derivado de regra leva `inferred: true` e
 * o texto cita os números que o geraram. O que é fato (`inferred: false`)
 * espelha o campo da API.
 */

export type NexusNodeKind =
  | "cliente"
  | "regiao"
  | "situacao"
  | "risco"
  | "insight"
  | "conhecimento"
  | "aprendizado"
  | "metrica";

export interface NexusGraphNode {
  id: string;
  kind: NexusNodeKind;
  label: string;
  detail?: string;
  /** Rota interna para "abrir" (ex.: `/app/contacts/<id>`). Ausente = sem destino. */
  href?: string;
  contactId?: string;
  /** true = derivado por regra a partir de fatos (texto sempre cita a fonte). */
  inferred: boolean;
  meta?: Record<string, string | number | null>;
}

export interface NexusGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  inferred: boolean;
}

export interface NexusRadarRow {
  contact_id: string;
  nome: string;
  cidade: string | null;
  uf: string | null;
  situacao: SituacaoRecompra;
  dias_sem_compra: number;
  atraso_dias: number;
  ultima_compra: string;
  faturamento_cents: number;
  ticket_medio_cents: number;
  intervalo_mediano_dias: number | null;
  qtd_pedidos: number;
}

export interface NexusRiskRow {
  id: string;
  title: string;
  contact_id: string | null;
  contact_name: string | null;
  risk: string;
  hours_since_activity: number | null;
}

export interface NexusKnowledgeRow {
  id: string;
  name: string;
  status: string | null;
  chunks_count: number | null;
}

export interface NexusMemoryRow {
  id: string;
  title: string;
  source: string;
  status: string;
}

export interface NexusEvolutionTotals {
  cost_cents: number;
  messages_received: number;
  handoff_rate: number;
  proposals_applied: number;
}

export interface NexusIntelligenceInput {
  radar: NexusRadarRow[];
  risks: NexusRiskRow[];
  knowledge: NexusKnowledgeRow[];
  memory: NexusMemoryRow[];
  evolution: NexusEvolutionTotals | null;
}

/**
 * Textos de interface nascem aqui em PT e saem por `t` — o grafo é tela, e
 * tela segue quem lê (doutrina i18n). `t` vem do chamador (hook com `useT`);
 * nos testes, identidade.
 */
export type NexusT = (texto: string) => string;

export interface NexusGraph {
  nodes: NexusGraphNode[];
  edges: NexusGraphEdge[];
}

const LIMITE_CLIENTES = 30;
const LIMITE_REGIOES = 8;
const LIMITE_RISCOS = 8;

const PRIORIDADE_SITUACAO: Record<SituacaoRecompra, number> = {
  em_risco: 0,
  recompra_atrasada: 1,
  em_voo: 2,
  cancelado_sem_nova: 3,
  oportunidade_aberta: 4,
  primeira_compra: 5,
  novo_sem_compras: 6,
  ok: 7,
};

export const REGIAO_NAO_INFORMADA_KEY = "Região não informada";

function regiaoDe(r: NexusRadarRow, t: NexusT): string {
  if (r.cidade && r.uf) return `${r.cidade}/${r.uf}`;
  return r.cidade ?? r.uf ?? t(REGIAO_NAO_INFORMADA_KEY);
}

/** Clientes que importam primeiro: pior situação, depois maior atraso. */
export function priorizarClientes(radar: NexusRadarRow[]): NexusRadarRow[] {
  return [...radar].sort(
    (a, b) =>
      PRIORIDADE_SITUACAO[a.situacao] - PRIORIDADE_SITUACAO[b.situacao] ||
      b.atraso_dias - a.atraso_dias,
  );
}

export function buildIntelligenceGraph(input: NexusIntelligenceInput, t: NexusT): NexusGraph {
  const nodes: NexusGraphNode[] = [];
  const edges: NexusGraphEdge[] = [];

  const clientes = priorizarClientes(input.radar.filter((r) => r.situacao !== "ok")).slice(
    0,
    LIMITE_CLIENTES,
  );
  const porSituacao = new Map<SituacaoRecompra, NexusRadarRow[]>();
  const porRegiao = new Map<string, NexusRadarRow[]>();
  for (const c of clientes) {
    const s = porSituacao.get(c.situacao) ?? [];
    s.push(c);
    porSituacao.set(c.situacao, s);
    const regiao = regiaoDe(c, t);
    const g = porRegiao.get(regiao) ?? [];
    g.push(c);
    porRegiao.set(regiao, g);
  }

  // Coluna 1 — situações presentes (fato: classificação do radar).
  const situacoes = [...porSituacao.keys()].sort(
    (a, b) => PRIORIDADE_SITUACAO[a] - PRIORIDADE_SITUACAO[b],
  );
  for (const s of situacoes) {
    const lista = porSituacao.get(s) ?? [];
    const soma = lista.reduce((acc, c) => acc + c.faturamento_cents, 0);
    nodes.push({
      id: `situacao:${s}`,
      kind: "situacao",
      label: ROTULO_RECOMPRA[s],
      detail: `${lista.length} ${t("cliente(s)")} · ${comoMoeda(soma, "BRL")} ${t("acumulado")}`,
      inferred: false,
      meta: { qtd: lista.length, faturamento_cents: soma, situacao: s },
    });
  }

  // Coluna 2 — clientes (fato) + arestas para situação e região.
  for (const c of clientes) {
    nodes.push({
      id: `cliente:${c.contact_id}`,
      kind: "cliente",
      label: c.nome,
      detail: `${ROTULO_RECOMPRA[c.situacao]} · ${t("há")} ${c.dias_sem_compra}d ${t("sem comprar")}`,
      href: `/app/contacts/${c.contact_id}`,
      contactId: c.contact_id,
      inferred: false,
      meta: {
        situacao: c.situacao,
        dias_sem_compra: c.dias_sem_compra,
        atraso_dias: c.atraso_dias,
        ultima_compra: c.ultima_compra,
        faturamento_cents: c.faturamento_cents,
        ticket_medio_cents: c.ticket_medio_cents,
        intervalo_mediano_dias: c.intervalo_mediano_dias,
        qtd_pedidos: c.qtd_pedidos,
        regiao: regiaoDe(c, t),
      },
    });
    edges.push({
      id: `e:cliente:${c.contact_id}:situacao`,
      source: `cliente:${c.contact_id}`,
      target: `situacao:${c.situacao}`,
      label: "está",
      inferred: false,
    });
  }

  // Coluna 3 — regiões (fato agregado: soma de quem aparece no grafo).
  const regioes = [...porRegiao.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, LIMITE_REGIOES);
  for (const [regiao, lista] of regioes) {
    nodes.push({
      id: `regiao:${regiao}`,
      kind: "regiao",
      label: regiao,
      detail: `${lista.length} ${t("cliente(s)")} ${t("no contexto")}`,
      inferred: false,
      meta: { qtd: lista.length },
    });
    for (const c of lista) {
      edges.push({
        id: `e:cliente:${c.contact_id}:regiao`,
        source: `cliente:${c.contact_id}`,
        target: `regiao:${regiao}`,
        label: "em",
        inferred: false,
      });
    }
  }

  // Coluna 4 — riscos do funil (fato) ligados ao cliente quando há match.
  const idsClientes = new Set(clientes.map((c) => c.contact_id));
  const riscos = input.risks.slice(0, LIMITE_RISCOS);
  for (const r of riscos) {
    nodes.push({
      id: `risco:${r.id}`,
      kind: "risco",
      label: r.title,
      detail:
        r.hours_since_activity != null ? `${t("parado há")} ${r.hours_since_activity}h` : undefined,
      href: r.contact_id ? `/app/contacts/${r.contact_id}` : undefined,
      contactId: r.contact_id ?? undefined,
      inferred: false,
      meta: { risk: r.risk, hours_since_activity: r.hours_since_activity },
    });
    if (r.contact_id && idsClientes.has(r.contact_id)) {
      edges.push({
        id: `e:risco:${r.id}:cliente`,
        source: `risco:${r.id}`,
        target: `cliente:${r.contact_id}`,
        label: "mesmo cliente",
        inferred: false,
      });
    }
  }

  // Insights derivados (regra explícita, sempre com fonte citada).
  // Recompra provável: passou do intervalo mediano de compra.
  const atrasados = clientes.filter(
    (c) => c.intervalo_mediano_dias != null && c.dias_sem_compra > c.intervalo_mediano_dias,
  );
  if (atrasados.length > 0) {
    const soma = atrasados.reduce((acc, c) => acc + c.faturamento_cents, 0);
    nodes.push({
      id: "insight:recompra",
      kind: "insight",
      label: t("Recompra provável"),
      detail: `${atrasados.length} ${t("cliente(s)")} ${t("passaram do intervalo mediano")} · ${comoMoeda(soma, "BRL")} ${t("acumulado")}`,
      inferred: true,
      meta: { qtd: atrasados.length, faturamento_cents: soma },
    });
    for (const c of atrasados.slice(0, 10)) {
      edges.push({
        id: `e:insight:recompra:${c.contact_id}`,
        source: `cliente:${c.contact_id}`,
        target: "insight:recompra",
        label: `${t("há")} ${c.dias_sem_compra}d (${t("mediana")} ${c.intervalo_mediano_dias}d)`,
        inferred: true,
      });
    }
  }

  // Conhecimento que alimenta a IA (fato: fontes ativas).
  for (const f of input.knowledge) {
    nodes.push({
      id: `conhecimento:${f.id}`,
      kind: "conhecimento",
      label: f.name,
      detail: `${f.chunks_count ?? 0} ${t("trecho(s)")} · ${f.status ?? "—"}`,
      href: "/app/ai/knowledge/sources",
      inferred: false,
      meta: { chunks: f.chunks_count, status: f.status },
    });
  }

  // Aprendizado acumulado (fato agregado: memórias ativas).
  const aprendizados = input.memory.filter((m) => m.status === "active");
  if (aprendizados.length > 0 || input.memory.length > 0) {
    nodes.push({
      id: "aprendizado:memoria",
      kind: "aprendizado",
      label: t("Memória da IA"),
      detail: `${aprendizados.length} ${t("aprendizado(s) ativo(s) de")} ${input.memory.length}`,
      href: "/app/ai/memory",
      inferred: false,
      meta: { ativos: aprendizados.length, total: input.memory.length },
    });
  }

  // Métricas do período (fato: evolution).
  if (input.evolution) {
    const e = input.evolution;
    nodes.push({
      id: "metrica:custo",
      kind: "metrica",
      label: t("Custo de IA"),
      detail: comoMoeda(e.cost_cents, "BRL"),
      href: "/app/ai/usage",
      inferred: false,
      meta: { cost_cents: e.cost_cents },
    });
    nodes.push({
      id: "metrica:mensagens",
      kind: "metrica",
      label: t("Mensagens"),
      detail: `${e.messages_received} ${t("recebidas")} · handoff ${Math.round(e.handoff_rate * 100)}%`,
      href: "/app/ai/evolution",
      inferred: false,
      meta: { messages: e.messages_received, handoff_rate: e.handoff_rate },
    });
  }

  return { nodes, edges };
}

/** Contexto estruturado a partir da seleção visual — vira filtro, tarefa ou prompt. */
export interface NexusSelectionContext {
  clientes: { id: string; nome: string }[];
  regioes: string[];
  situacoes: SituacaoRecompra[];
  /** Nós não-clientes selecionados (insights, riscos, métricas...). */
  outros: { id: string; kind: NexusNodeKind; label: string }[];
  resumo: string;
}

export function buildSelectionContext(
  selecionados: NexusGraphNode[],
  t: NexusT,
): NexusSelectionContext {
  const clientes = selecionados
    .filter((n) => n.kind === "cliente" && n.contactId)
    .map((n) => ({ id: n.contactId as string, nome: n.label }));
  const regioes = selecionados.filter((n) => n.kind === "regiao").map((n) => n.label);
  const situacoes = selecionados
    .filter((n) => n.kind === "situacao")
    .map((n) => (n.meta?.["situacao"] as SituacaoRecompra | undefined) ?? null)
    .filter((s): s is SituacaoRecompra => s !== null);
  const outros = selecionados
    .filter((n) => n.kind !== "cliente" && n.kind !== "regiao" && n.kind !== "situacao")
    .map((n) => ({ id: n.id, kind: n.kind, label: n.label }));
  const partes: string[] = [];
  if (clientes.length > 0) partes.push(`${clientes.length} ${t("cliente(s)")}`);
  if (regioes.length > 0) partes.push(regioes.join(", "));
  if (situacoes.length > 0) partes.push(situacoes.map((s) => ROTULO_RECOMPRA[s]).join(", "));
  if (outros.length > 0) partes.push(outros.map((o) => o.label).join(", "));
  return {
    clientes,
    regioes,
    situacoes,
    outros,
    resumo: partes.length > 0 ? partes.join(" + ") : t("Nada selecionado"),
  };
}

/**
 * Explicação determinística de UM nó — só usa campos do nó (fatos) ou regra
 * citada (inferido). Nunca chama modelo, nunca inventa número.
 */
export function explainNode(n: NexusGraphNode, t: NexusT): string {
  if (n.kind === "cliente") {
    const m = n.meta ?? {};
    const ultima = typeof m["ultima_compra"] === "string" ? m["ultima_compra"] : "—";
    const ticket =
      typeof m["ticket_medio_cents"] === "number" ? comoMoeda(m["ticket_medio_cents"], "BRL") : "—";
    const dias = typeof m["dias_sem_compra"] === "number" ? m["dias_sem_compra"] : "—";
    return `${n.label} ${t("está há")} ${dias} ${t("dias sem comprar")} (${t("última")} ${ultima}, ${t("ticket médio")} ${ticket}).`;
  }
  if (n.kind === "insight" && n.id === "insight:recompra") {
    return `${t("Derivado")}: ${t("clientes acima passaram do próprio intervalo mediano de compra")}.`;
  }
  return n.detail ? `${n.label}: ${n.detail}.` : `${n.label}.`;
}

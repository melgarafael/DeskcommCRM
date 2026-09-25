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

import {
  flowGraphSchema,
  type EndFinish,
  type FlowGraph,
  type FlowNode,
} from "./graph-schema";
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

// ─────────────────────────────────────────────────────────────────────────────
// Onde cada coisa mora (port do #1130 — plano 2026-09-23, D1–D4)
// ─────────────────────────────────────────────────────────────────────────────
//
// O PR do autor guardava as respostas em `contact_flow_data` e a trilha em
// `contact_flow_events`. Aqui não há tabela própria:
//
//   * a RESPOSTA vai para `contacts.custom_fields[chave]` — um só lugar para o
//     dado do contato, já exportado ao titular e já zerado pela anonimização nos
//     dois caminhos. Um campo que o contato JÁ tem não é perguntado;
//   * a EXECUÇÃO é uma linha de `followup_enrollments` com status 'coletando'
//     (0394) — fora, por construção, de tudo que o relógio do follow-up lê;
//   * a TRILHA vai para `followup_enrollment_events` (`roteiro_*`), e o payload
//     NUNCA leva o valor respondido — só a chave do campo. A trilha não é dado
//     pessoal, e a LGPD não precisa redigi-la;
//   * as TENTATIVAS por pergunta são contadas da trilha (`roteiro_tentativa`).

/** Os tipos de evento do roteiro em `followup_enrollment_events.event_type`. */
export const EVENTOS_DO_ROTEIRO = [
  "roteiro_iniciado",
  "roteiro_mensagem",
  "roteiro_resposta",
  "roteiro_fora_do_fluxo",
  "roteiro_tentativa",
  "roteiro_pergunta_feita",
  "roteiro_concluido",
  "roteiro_encadeou",
  // Emitido só pelo banco hoje: a fusão por nono dígito encerra o roteiro vivo
  // excedente (baseline, bloco da 0198). O PR 2 o usa no handoff e na expiração.
  "roteiro_cancelado",
  // Emitido pelo banco (`fn_encerrar_roteiros_vencidos`, 0397): o prazo venceu.
  "roteiro_expirado",
] as const;
export type EventoDoRoteiro = (typeof EVENTOS_DO_ROTEIRO)[number];

/**
 * O que um evento do roteiro pode carregar. Não há campo para o VALOR de
 * propósito: o tipo é a cerca — quem quiser gravar a resposta na trilha tem de
 * mudar este tipo, e a mudança aparece na revisão.
 */
export interface PayloadDoEvento {
  campo?: string;
  origem?: "validador" | "captura" | "modelo" | "motor" | "gatilho" | "roteador" | "encadeamento";
  correcao?: boolean;
  esgotadas?: string[];
  proximo_fluxo?: string;
  proximo_enrollment_id?: string;
  motivo?: string;
}

/**
 * Bloco injetado no contexto do turno. Só existe quando o roteiro está em
 * andamento (enrollment 'coletando') — sem roteiro, nada disto vai à IA.
 */
export function renderBlocoDeAtendimento(
  estado: EstadoDeAtendimento,
  finalizacao?: EndFinish,
): string {
  // O "passa-bastão" do roteiro ANTERIOR (quando este foi encadeado): o que já
  // foi respondido não se repergunta, e o próximo passo da venda começa daqui.
  const contexto =
    estado.notaAnterior !== undefined && estado.notaAnterior.length > 0
      ? `Contexto do atendimento anterior: ${estado.notaAnterior}\n\n`
      : "";

  if (estado.situacao.pendentes.length === 0) {
    const nota =
      finalizacao?.tipo === "skill"
        ? `O roteiro foi concluído. Puxe agora a skill ${finalizacao.skill_name}.`
        : "O roteiro foi concluído — siga o atendimento normalmente.";
    return `${contexto}## Roteiro de atendimento — ${estado.nomeDoFluxo}\n${nota}`;
  }

  const linhas = estado.situacao.pendentes.map((n) => {
    const cfg = n.config;
    const obrig = cfg.required ? "obrigatória" : "opcional";
    const opcoes =
      cfg.type === "select" && (cfg.options?.length ?? 0) > 0
        ? ` Opções: ${cfg.options!.join(", ")}.`
        : "";
    const sugerida = cfg.question ? ` Pergunta sugerida: "${cfg.question}".` : "";
    return `- ${cfg.label} (${obrig}).${opcoes}${sugerida}`;
  });

  return [
    `${contexto}## Roteiro de atendimento ativo — ${estado.nomeDoFluxo}`,
    "Este roteiro foi acionado e precisa ser concluído. Atenda o cliente PRIMEIRO; encaixe no máximo UMA pergunta por resposta, quando houver abertura.",
    "O sistema registra sozinho o que o cliente responde. Não repergunte o que ele já disse e não peça para ele confirmar.",
    `Pergunta sem resposta pode ser repetida no máximo ${estado.maxTentativas} vez(es); depois disso, pare de perguntá-la.`,
    "Perguntas pendentes, na ordem:",
    ...linhas,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Banco
// ─────────────────────────────────────────────────────────────────────────────

/** O mínimo do `pg.Pool` que o roteiro usa — o teste injeta um dublê. */
export type BancoDoRoteiro = Pick<pg.Pool, "query">;

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
  /** Valor atual de cada chave do checklist em `contacts.custom_fields`. */
  valores: Record<string, string>;
  tentativas: Record<string, number>;
  /**
   * Chaves das perguntas que JÁ FORAM FEITAS ao cliente nesta execução (evento
   * `roteiro_pergunta_feita`). Só uma pergunta feita pode ser "a pergunta
   * atual": sem isso, no turno que COMEÇA o roteiro, "sim, quero financiar"
   * virava `tem_cnh = true` (revisão adversarial do PR 2).
   */
  perguntasFeitas: ReadonlySet<string>;
  maxTentativas: number;
  situacao: SituacaoDoChecklist;
  /**
   * Resumo do roteiro ANTERIOR do mesmo contato, montado dos campos (D4). É o
   * passa-bastão do encadeamento: o próximo passo não repergunta nem recomeça.
   */
  notaAnterior?: string;
}

/** O valor de um campo personalizado como texto — ou `null` se não há o que ler. */
function comoTexto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

/** Os valores das chaves do checklist, lidos de `custom_fields`. Puro. */
export function valoresDoChecklist(
  checklist: ChecklistDeAtendimento,
  customFields: unknown,
): Record<string, string> {
  const cf =
    customFields !== null && typeof customFields === "object" && !Array.isArray(customFields)
      ? (customFields as Record<string, unknown>)
      : {};
  const valores: Record<string, string> = {};
  for (const passo of checklist.passos) {
    if (passo.kind !== "collect") continue;
    const texto = comoTexto(cf[passo.node.config.key]);
    if (texto !== null) valores[passo.node.config.key] = texto;
  }
  return valores;
}

async function lerCamposDoContato(
  db: BancoDoRoteiro,
  organizationId: string,
  contactId: string,
): Promise<unknown> {
  const { rows } = await db.query<{ custom_fields: unknown }>(
    `select custom_fields from contacts where organization_id = $1 and id = $2`,
    [organizationId, contactId],
  );
  return rows[0]?.custom_fields ?? {};
}

/**
 * Roteiro EM ANDAMENTO de um contato (enrollment 'coletando' de um pointer
 * `atendimento` ativo). `null` quando não há roteiro ou o grafo é irrecuperável.
 */
export async function carregarEstadoDeAtendimento(
  db: BancoDoRoteiro,
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
       join followup_flow_pointers p on p.id = e.pointer_id and p.organization_id = e.organization_id
       join followup_flow_versions v on v.id = e.version_id and v.organization_id = e.organization_id
      where e.organization_id = $1
        and e.contact_id = $2
        and e.status = 'coletando'
        and p.surface = 'atendimento'
        -- Roteiro DESATIVADO para de guiar na hora (achado da auditoria do
        -- autor): o enrollment fica parado e volta se o roteiro voltar a 'active'.
        and p.status = 'active'
      limit 1`,
    [args.organizationId, args.contactId],
  );
  const row = rows[0];
  if (!row) return null;

  const parsed = flowGraphSchema.safeParse(row.graph);
  if (!parsed.success) return null;
  const checklist = mapearChecklist(parsed.data);
  if (!checklist.ok) return null;

  const valores = valoresDoChecklist(
    checklist.checklist,
    await lerCamposDoContato(db, args.organizationId, args.contactId),
  );

  const { rows: contagem } = await db.query<{ tipo: string; campo: string | null; n: number }>(
    `select event_type as tipo, payload->>'campo' as campo, count(*)::int as n
       from followup_enrollment_events
      where organization_id = $1 and enrollment_id = $2
        and event_type in ('roteiro_tentativa', 'roteiro_pergunta_feita')
      group by 1, 2`,
    [args.organizationId, row.id],
  );
  const tentativas: Record<string, number> = {};
  const perguntasFeitas = new Set<string>();
  for (const c of contagem) {
    if (!c.campo) continue;
    if (c.tipo === "roteiro_pergunta_feita") perguntasFeitas.add(c.campo);
    else tentativas[c.campo] = c.n;
  }

  const maxTentativas = parsed.data.settings?.max_tentativas_pergunta ?? MAX_TENTATIVAS_PADRAO;
  const notaAnterior = await resumoDoRoteiroAnterior(db, {
    organizationId: args.organizationId,
    contactId: args.contactId,
    enrollmentAtual: row.id,
  });

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
    perguntasFeitas,
    maxTentativas,
    situacao: situacaoDoChecklist(checklist.checklist, new Set(Object.keys(valores)), {
      tentativas,
      maxTentativas,
    }),
    ...(notaAnterior !== null ? { notaAnterior } : {}),
  };
}

/** Resumo, montado dos campos, do último roteiro CONCLUÍDO do contato. */
async function resumoDoRoteiroAnterior(
  db: BancoDoRoteiro,
  args: { organizationId: string; contactId: string; enrollmentAtual: string },
): Promise<string | null> {
  const { rows } = await db.query<{ nome: string; graph: unknown }>(
    `select p.name as nome, v.graph
       from followup_enrollments e
       join followup_flow_pointers p on p.id = e.pointer_id and p.organization_id = e.organization_id
       join followup_flow_versions v on v.id = e.version_id and v.organization_id = e.organization_id
      where e.organization_id = $1
        and e.contact_id = $2
        and e.id <> $3
        and e.status = 'completed'
        and p.surface = 'atendimento'
      order by e.completed_at desc nulls last
      limit 1`,
    [args.organizationId, args.contactId, args.enrollmentAtual],
  );
  const row = rows[0];
  if (!row) return null;
  const parsed = flowGraphSchema.safeParse(row.graph);
  if (!parsed.success) return null;
  const checklist = mapearChecklist(parsed.data);
  if (!checklist.ok) return null;
  const valores = valoresDoChecklist(
    checklist.checklist,
    await lerCamposDoContato(db, args.organizationId, args.contactId),
  );
  return montarResumoDoRoteiro({ nomeDoFluxo: row.nome, checklist: checklist.checklist, valores });
}

/**
 * Grava a resposta NORMALIZADA no campo personalizado do contato. Devolve
 * `false` quando nada foi gravado (contato de outra organização, sumiu ou foi
 * anonimizado — depois do esquecimento, o roteiro não regrava dado pessoal).
 */
export async function gravarRespostaNoContato(
  db: BancoDoRoteiro,
  args: { organizationId: string; contactId: string; campo: string; valor: string },
): Promise<boolean> {
  const r = await db.query(
    `update contacts
        set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object($3::text, $4::text),
            updated_at = now()
      where organization_id = $1 and id = $2 and not coalesce(is_anonymized, false)`,
    [args.organizationId, args.contactId, args.campo, args.valor],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Registra um evento na trilha. Devolve se a linha entrou — com
 * `idempotencyKey`, uma chave repetida não entra (índice único
 * `idx_followup_events_idem`), e é isso que torna o roteiro idempotente.
 */
export async function registrarEventoDoRoteiro(
  db: BancoDoRoteiro,
  args: {
    organizationId: string;
    enrollmentId: string;
    tipo: EventoDoRoteiro;
    nodeId?: string | null;
    payload?: PayloadDoEvento;
    idempotencyKey?: string;
  },
): Promise<boolean> {
  const r = await db.query(
    `insert into followup_enrollment_events
        (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict do nothing`,
    [
      args.organizationId,
      args.enrollmentId,
      args.nodeId ?? null,
      args.tipo,
      JSON.stringify(args.payload ?? {}),
      args.idempotencyKey ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Reivindica a mensagem para este roteiro (`roteiro_msg:<id>` no índice único
 * de eventos). `false` = ela já foi processada — um job reexecutado (retry da
 * fila) não grava, não conta tentativa e, chamado ANTES do validador, não paga
 * de novo a chamada de modelo (revisão do PR 1).
 */
export async function reivindicarMensagemDoRoteiro(
  db: BancoDoRoteiro,
  args: { organizationId: string; enrollmentId: string; messageId: string },
): Promise<boolean> {
  return registrarEventoDoRoteiro(db, {
    organizationId: args.organizationId,
    enrollmentId: args.enrollmentId,
    tipo: "roteiro_mensagem",
    idempotencyKey: `roteiro_msg:${args.messageId}`,
  });
}

/** Uma mensagem do cliente como o roteiro a lê; `texto: null` = mídia sem leitura. */
export interface MensagemDoLote {
  id: string;
  texto: string | null;
}

/**
 * O LOTE que este turno responde, como o ROTEIRO o lê: a mensagem pinada no
 * job e as que chegaram depois dela na mesma conversa (o drain junta uma rajada
 * num job só e as seguintes "pegam carona"). Cada uma com a legenda e o
 * conteúdo derivado da mídia (transcrição do áudio, leitura da imagem), sem o
 * enquadramento que o histórico do agente usa. `texto: null` = mídia sem
 * leitura (figurinha, áudio ainda não transcrito): não há o que ler, e isso NÃO
 * é "não respondeu" — achado 8 da prova do #1130, em que três áudios esgotavam
 * a pergunta.
 *
 * Lote, e não só a primeira: na rajada "oi" + "meu cpf é 529.982.247-25", o job
 * fica preso ao "oi" e o CPF chega de carona — conferir o lastro só na primeira
 * fazia o roteiro reperguntar o que o cliente acabou de dizer (revisão
 * adversarial do PR 2).
 */
export async function lerLoteParaORoteiro(
  db: BancoDoRoteiro,
  args: { organizationId: string; conversationId: string; messageId: string },
): Promise<MensagemDoLote[]> {
  const { rows } = await db.query<{ id: string; body: string | null; media_derived_text: string | null }>(
    `select m.id, m.body, m.media_derived_text
       from messages m
       join messages p on p.id = $3 and p.organization_id = $1 and p.conversation_id = $2
      where m.organization_id = $1
        and m.conversation_id = $2
        and m.direction = 'inbound'
        and coalesce(m.sent_at, m.created_at) >= coalesce(p.sent_at, p.created_at)
      order by coalesce(m.sent_at, m.created_at), m.id
      limit 20`,
    [args.organizationId, args.conversationId, args.messageId],
  );
  return rows.map((row) => {
    const partes = [row.body, row.media_derived_text]
      .map((p) => (p ?? "").trim())
      .filter((p) => p !== "");
    return { id: row.id, texto: partes.length === 0 ? null : partes.join("\n") };
  });
}

/**
 * Marca o turno: soma uma tentativa na PRÓXIMA pergunta pendente e, se com isso
 * ela esgotou, recalcula a situação e conclui quando não sobra pendente.
 */
export async function registrarTentativaDoTurno(
  db: BancoDoRoteiro,
  args: { organizationId: string; estado: EstadoDeAtendimento; messageId?: string | null },
): Promise<{ estado: EstadoDeAtendimento; concluiu: boolean }> {
  const { estado } = args;
  const primeira = estado.situacao.pendentes[0];
  if (!primeira) return { estado, concluiu: estado.situacao.completo };

  await registrarEventoDoRoteiro(db, {
    organizationId: args.organizationId,
    enrollmentId: estado.enrollment.id,
    tipo: "roteiro_tentativa",
    nodeId: primeira.id,
    payload: { campo: primeira.config.key },
  });

  const tentativas = {
    ...estado.tentativas,
    [primeira.config.key]: (estado.tentativas[primeira.config.key] ?? 0) + 1,
  };
  const atualizado = recomputarSituacao(estado, new Set(Object.keys(estado.valores)), tentativas);
  if (!atualizado.situacao.completo) return { estado: atualizado, concluiu: false };
  await finalizarFluxoDeAtendimento(db, {
    organizationId: args.organizationId,
    estado: atualizado,
    messageId: args.messageId ?? null,
  });
  return { estado: atualizado, concluiu: true };
}

/** Recalcula a situação do checklist preservando o resto do estado. */
function recomputarSituacao(
  estado: EstadoDeAtendimento,
  valores: ReadonlySet<string>,
  tentativas: Record<string, number> = estado.tentativas,
): EstadoDeAtendimento {
  return {
    ...estado,
    tentativas,
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
  /** true = o roteiro concluiu neste processamento. */
  concluiu: boolean;
  /** Ação de finalização, quando concluiu. */
  finalizacao?: EndFinish;
}

/**
 * Processa o INBOUND contra o roteiro antes de o modelo rodar:
 *
 *   - com leitura do VALIDADOR (`validacoes`) → grava cada campo que ele leu
 *     (pendente, ou já preenchido que aceita correção) e conclui se completou;
 *   - sem ela, a captura determinística lê a PRIMEIRA pendente:
 *     `respondeu` grava; `desviou` não conta tentativa; aceno/silêncio conta.
 *
 * Idempotente por mensagem: a primeira coisa é reivindicar a mensagem na
 * trilha (`roteiro_mensagem`, chave `roteiro_msg:<id>`). Um job reexecutado
 * (retry da fila) encontra a chave e não reprocessa — no teste ao vivo do autor,
 * o reprocessamento gravou a frase de abertura no campo seguinte (60bbe49b5).
 */
export async function processarInboundDoFluxo(
  db: BancoDoRoteiro,
  args: {
    organizationId: string;
    estado: EstadoDeAtendimento;
    texto: string | null;
    messageId?: string | null;
    validacoes?: ReadonlyArray<{ campo: string; valor: string }> | undefined;
  },
): Promise<ResultadoDoInbound> {
  const { estado } = args;
  const contactId = estado.enrollment.contact_id;

  if (args.messageId !== undefined && args.messageId !== null) {
    const primeiraVez = await reivindicarMensagemDoRoteiro(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      messageId: args.messageId,
    });
    if (!primeiraVez) return { estado, concluiu: false };
  }

  // MÚLTIPLAS respostas do validador (e correções), em QUALQUER ordem: o
  // cliente costuma responder a várias perguntas na mesma mensagem.
  if (args.validacoes !== undefined && args.validacoes.length > 0) {
    const valoresNovos: Record<string, string> = { ...estado.valores };
    let aplicou = false;
    for (const v of args.validacoes) {
      const node = campoPorChave(estado.checklist, v.campo);
      if (node === null) continue;
      const ehPendente = estado.situacao.pendentes.some((n) => n.config.key === v.campo);
      const ehCorrecao =
        !ehPendente && node.config.permite_correcao && estado.valores[v.campo] !== undefined;
      // RESPOSTA TARDIA: a pergunta foi encerrada por não resposta (teto), mas o
      // cliente finalmente a informou. Gravar é melhor que perder o dado — era o
      // que acontecia (medido pelo autor: CPF informado após esgotar caiu no vazio).
      const ehEsgotada =
        !ehPendente && estado.situacao.esgotadas.some((n) => n.config.key === v.campo);
      if (!ehPendente && !ehCorrecao && !ehEsgotada) continue;
      // NO-OP: o valor não mudou — não é resposta nova.
      if (v.valor === "" || v.valor === (valoresNovos[v.campo] ?? "")) continue;
      const gravou = await gravarRespostaNoContato(db, {
        organizationId: args.organizationId,
        contactId,
        campo: v.campo,
        valor: v.valor,
      });
      if (!gravou) continue;
      await registrarEventoDoRoteiro(db, {
        organizationId: args.organizationId,
        enrollmentId: estado.enrollment.id,
        tipo: "roteiro_resposta",
        nodeId: node.id,
        payload: { campo: v.campo, origem: "validador", ...(ehCorrecao ? { correcao: true } : {}) },
      });
      valoresNovos[v.campo] = v.valor;
      aplicou = true;
    }
    if (!aplicou) return { estado, concluiu: false };
    return concluirSeCompleto(db, args, recomputarSituacao({ ...estado, valores: valoresNovos }, new Set(Object.keys(valoresNovos))));
  }

  const primeiro = estado.situacao.pendentes[0];
  // Nada pendente = o roteiro já está completo (os valores chegaram por outra
  // via, ex.: o contato já tinha o campo). Fechar aqui é o que faz a venda
  // continuar — no teste ao vivo do autor, devolver cedo deixava o roteiro
  // aberto para sempre.
  if (primeiro === undefined) {
    return estado.situacao.completo ? concluirSeCompleto(db, args, estado) : { estado, concluiu: false };
  }

  const leitura = classificarInbound(comoCampoParaCaptura(primeiro), args.texto);
  // Pergunta que NÃO foi feita não é a pergunta atual: a mensagem não é
  // resposta a ela (nem desvio dela), e não conta tentativa. A captura só vale
  // para o que tem lastro próprio no texto (data, número, CPF, opção escrita);
  // um "sim" solto, sem a pergunta, não é resposta de nada.
  if (!estado.perguntasFeitas.has(primeiro.config.key)) {
    if (leitura.resultado !== "respondeu" || primeiro.config.type === "boolean") {
      return { estado, concluiu: false };
    }
  }

  if (leitura.resultado === "desviou") {
    await registrarEventoDoRoteiro(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      tipo: "roteiro_fora_do_fluxo",
      nodeId: primeiro.id,
      payload: { campo: primeiro.config.key },
    });
    return { estado, concluiu: false };
  }

  if (leitura.resultado === "respondeu") {
    const gravou = await gravarRespostaNoContato(db, {
      organizationId: args.organizationId,
      contactId,
      campo: primeiro.config.key,
      valor: leitura.captura.valor,
    });
    if (!gravou) return { estado, concluiu: false };
    await registrarEventoDoRoteiro(db, {
      organizationId: args.organizationId,
      enrollmentId: estado.enrollment.id,
      tipo: "roteiro_resposta",
      nodeId: primeiro.id,
      payload: { campo: primeiro.config.key, origem: "captura" },
    });
    const valores = { ...estado.valores, [primeiro.config.key]: leitura.captura.valor };
    return concluirSeCompleto(db, args, recomputarSituacao({ ...estado, valores }, new Set(Object.keys(valores))));
  }

  // `ignorou` ou `nao_identificado`: a pergunta segue pendente e o turno conta
  // como tentativa (o teto é o freio contra a pergunta infinita).
  const r = await registrarTentativaDoTurno(db, {
    organizationId: args.organizationId,
    estado,
    messageId: args.messageId ?? null,
  });
  return r.concluiu
    ? { estado: r.estado, concluiu: true, ...finalizacaoDe(r.estado) }
    : { estado: r.estado, concluiu: false };
}

function finalizacaoDe(estado: EstadoDeAtendimento): { finalizacao?: EndFinish } {
  const fim = estado.checklist.fim.config.ao_finalizar;
  return fim !== undefined ? { finalizacao: fim } : {};
}

async function concluirSeCompleto(
  db: BancoDoRoteiro,
  args: { organizationId: string; messageId?: string | null },
  estado: EstadoDeAtendimento,
): Promise<ResultadoDoInbound> {
  if (!estado.situacao.completo) return { estado, concluiu: false };
  const { finalizacao } = await finalizarFluxoDeAtendimento(db, {
    organizationId: args.organizationId,
    estado,
    messageId: args.messageId ?? null,
  });
  return { estado, concluiu: true, ...(finalizacao !== undefined ? { finalizacao } : {}) };
}

/**
 * RESUMO do roteiro, montado dos campos — o que a tela mostra e o que o
 * próximo roteiro lê (D4: sem síntese por modelo, decisão do titular de
 * 23/09). Percorre as perguntas na ordem; as não respondidas aparecem
 * marcadas, para ninguém tomar ausência por "não".
 */
export function montarResumoDoRoteiro(estado: {
  nomeDoFluxo: string;
  checklist: ChecklistDeAtendimento;
  valores: Record<string, string>;
}): string {
  const linhas = estado.checklist.passos
    .filter((p): p is Extract<PassoDeAtendimento, { kind: "collect" }> => p.kind === "collect")
    .map((p) => `${p.node.config.label}: ${estado.valores[p.node.config.key] ?? "(não respondido)"}`);
  return `Roteiro "${estado.nomeDoFluxo}" — ${linhas.join("; ")}`.slice(0, 2000);
}

/**
 * Fecha o roteiro: grava o desfecho, emite o evento final e — se o Fim pedir
 * `ao_finalizar: proximo_fluxo` — começa o PRÓXIMO roteiro (terminou um,
 * continua a venda). O desfecho diz a verdade: `exhausted` só quando alguma
 * pergunta esgotou sem resposta; senão `converted` (na prova, todo roteiro
 * concluído ficava "Esgotado" pelo padrão do nó Fim).
 */
export async function finalizarFluxoDeAtendimento(
  db: BancoDoRoteiro,
  args: { organizationId: string; estado: EstadoDeAtendimento; messageId?: string | null },
): Promise<{ finalizacao?: EndFinish; proximoEnrollmentId: string | null }> {
  const { estado } = args;
  const fim = estado.checklist.fim.config.ao_finalizar;
  const esgotadas = estado.situacao.esgotadas.map((n) => n.config.key);

  const r = await db.query(
    `update followup_enrollments
        set status = 'completed',
            outcome = $3,
            completed_at = now(),
            updated_at = now()
      where organization_id = $1 and id = $2 and status = 'coletando'`,
    [args.organizationId, estado.enrollment.id, esgotadas.length > 0 ? "exhausted" : "converted"],
  );
  // Outro processamento já fechou (turno concorrente): não emite nem encadeia de novo.
  if ((r.rowCount ?? 0) === 0) {
    return { ...(fim !== undefined ? { finalizacao: fim } : {}), proximoEnrollmentId: null };
  }
  await registrarEventoDoRoteiro(db, {
    organizationId: args.organizationId,
    enrollmentId: estado.enrollment.id,
    tipo: "roteiro_concluido",
    nodeId: estado.checklist.fim.id,
    payload: esgotadas.length > 0 ? { esgotadas } : {},
  });

  let proximoEnrollmentId: string | null = null;
  // Autoencadeamento (roteiro → ele mesmo) é ignorado: seria laço sem fim. Um
  // vínculo A→B→A é configuração do dono e só avança um passo por turno.
  if (fim?.tipo === "proximo_fluxo" && fim.fluxo !== estado.enrollment.pointer_id) {
    proximoEnrollmentId = await iniciarFluxoDeAtendimento(db, {
      organizationId: args.organizationId,
      contactId: estado.enrollment.contact_id,
      flowPointerId: fim.fluxo,
      origem: "encadeamento",
    });
    if (proximoEnrollmentId !== null) {
      await registrarEventoDoRoteiro(db, {
        organizationId: args.organizationId,
        enrollmentId: estado.enrollment.id,
        tipo: "roteiro_encadeou",
        nodeId: estado.checklist.fim.id,
        payload: { proximo_fluxo: fim.fluxo, proximo_enrollment_id: proximoEnrollmentId },
      });
    }
  }

  return { ...(fim !== undefined ? { finalizacao: fim } : {}), proximoEnrollmentId };
}

/**
 * ENTRADA POR GATILHO (motor): entre os roteiros ativos, qual LIGA pela
 * mensagem do cliente (palavra-gatilho). Independe do modelo e do roteador.
 */
export async function escolherFluxoPeloGatilho(
  db: BancoDoRoteiro,
  args: { organizationId: string; texto: string | null },
): Promise<{ id: string; nome: string } | null> {
  if (!args.texto) return null;
  const { rows } = await db.query<{ id: string; nome: string; graph: unknown }>(
    `select p.id, p.name as nome, v.graph
       from followup_flow_pointers p
       join followup_flow_versions v on v.id = p.active_version_id and v.organization_id = p.organization_id
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
 * Começa um roteiro para o contato. Devolve o id do enrollment, ou `null`
 * quando não é para começar: roteiro de outra organização, inativo, sem versão,
 * grafo que o motor não percorre, ou o contato já tem um roteiro 'coletando'
 * (índice `idx_followup_enrollments_um_roteiro_coletando` — 23505 não é erro).
 */
export async function iniciarFluxoDeAtendimento(
  db: BancoDoRoteiro,
  args: {
    organizationId: string;
    contactId: string;
    flowPointerId: string;
    conversationId?: string | null;
    origem: "gatilho" | "roteador" | "encadeamento";
  },
): Promise<string | null> {
  const { rows } = await db.query<{ active_version_id: string | null; graph: unknown }>(
    `select p.active_version_id, v.graph
       from followup_flow_pointers p
       join followup_flow_versions v on v.id = p.active_version_id and v.organization_id = p.organization_id
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
  const inicio = parsed.data.nodes.find((n) => n.type === "trigger")?.id;
  if (inicio === undefined) return null;

  let enrollmentId: string | null;
  try {
    // `next_eval_at` NULO de propósito: 'coletando' é conduzido pelo turno e
    // não tem relógio (0394). Omitir a coluna daria o default `now()`.
    const { rows: criado } = await db.query<{ id: string }>(
      `insert into followup_enrollments
          (organization_id, pointer_id, version_id, contact_id, conversation_id, current_node_id, status, next_eval_at)
       values ($1, $2, $3, $4, $5, $6, 'coletando', null)
       returning id`,
      [
        args.organizationId,
        args.flowPointerId,
        row.active_version_id,
        args.contactId,
        args.conversationId ?? null,
        inicio,
      ],
    );
    enrollmentId = criado[0]?.id ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return null;
    throw err;
  }
  if (enrollmentId !== null) {
    await registrarEventoDoRoteiro(db, {
      organizationId: args.organizationId,
      enrollmentId,
      tipo: "roteiro_iniciado",
      nodeId: inicio,
      payload: { origem: args.origem },
    });
  }
  return enrollmentId;
}

/**
 * Encerra, em lote, o roteiro 'coletando' cujo prazo venceu (0397,
 * `fn_encerrar_roteiros_vencidos`: sem mensagem lida há mais de
 * `settings.expira_em_horas`, padrão 72 h, com o evento `roteiro_expirado`).
 * Chamado pelo relógio do follow-up. Devolve quantos encerrou.
 */
export async function encerrarRoteirosVencidos(
  db: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> },
  limite = 200,
): Promise<number> {
  const { data, error } = await db.rpc("fn_encerrar_roteiros_vencidos", { p_limite: limite });
  if (error) throw new Error(error.message);
  return typeof data === "number" ? data : 0;
}

/**
 * Os chamados humanos — leitura compartilhada entre a tela e o agente.
 *
 * As duas consultas viviam dentro de `app/api/v1/ai/cases/route.ts` e
 * `.../[id]/route.ts`, servindo só à tela. O agente abria o chamado e não
 * conseguia mais olhar para ele: não sabia listar, não sabia se foi respondido,
 * não lia o que a pessoa decidiu. Extraído (Decisão 4 do briefing IA 360) para
 * que a pessoa e o agente vejam o MESMO chamado, pela mesma consulta.
 *
 * Só leitura aqui. A máquina de estados do chamado é
 * `lib/agent-engine/agent/human-cases.ts` (transições sobre `pg`, atômicas) —
 * duplicá-la em PostgREST daria dois donos para a mesma regra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const ESTADOS_ABERTOS = ["awaiting_human", "awaiting_lead"] as const;
export const ESTADOS_FECHADOS = ["resolved", "escalated", "cancelled"] as const;

/**
 * Quais conversas quem está lendo pode ver — parâmetro OBRIGATÓRIO, sem default.
 *
 * `conversations` tem RLS por atendente (`fn_can_view_conversation`, migration
 * 0035): numa organização em `visibility_mode = 'own'`, o papel `agent` só
 * enxerga a conversa dele. Estas duas consultas, porém, rodam com cliente
 * privilegiado e devolvem `title`, `summary`, `blocker`, nome e telefone do
 * contato — o que a tela de conversas escondia, a tela de casos entregava.
 *
 * **Por que argumento e não filtro embutido:** o MCP chama as MESMAS funções
 * (`lib/mcp/tools/escalacao.ts`), onde o cliente é admin por contrato. Embutir o
 * recorte faria o agente de IA enxergar menos casos que hoje — e o cabeçalho de
 * `app/api/v1/ai/cases/route.ts` declara que a tela e o agente discordarem sobre
 * o que está aberto seria o pior tipo de divergência. A divergência passa a ser
 * DECLARADA no tipo.
 *
 * **Por que sem default:** um default escolheria um dos dois lados para todo
 * chamador futuro, e os dois estão certos em contextos diferentes. Quem chama
 * declara; o tipo cobra (e `pnpm typecheck` cobre `tests/**`, então o
 * `@ts-expect-error` de `tests/unit/chamados-visibilidade.test.ts` é gate).
 */
export type ConversasVisiveis = string[] | "todas";

/**
 * O recorte, com falha FECHADA: `"todas"` devolve `null` (não filtra), array
 * devolve o array, e qualquer outra coisa estoura.
 *
 * O `throw` não é zelo — é o que impede o modo de falha silencioso. Tipo é
 * apagado em runtime: um chamador em JS, um cast frouxo ou um `any` vindo de
 * fora entregaria `undefined` aqui, e `undefined` significaria "não filtrei" —
 * isto é, devolver a fila inteira com PII para quem não podia vê-la. Falha
 * fechada na ação, aberta na informação.
 */
function recorte(visiveisPara: ConversasVisiveis): string[] | null {
  if (visiveisPara === "todas") return null;
  if (!Array.isArray(visiveisPara)) {
    throw new Error(
      "chamados: `visiveisPara` é obrigatório — declare `\"todas\"` (cliente admin por " +
        "contrato, como o MCP) ou o conjunto de conversas que a RLS devolveu para a sessão.",
    );
  }
  return visiveisPara;
}

/**
 * As conversas que ESTA sessão enxerga entre as dos casos da organização.
 *
 * Quem responde é a RLS de `conversations` — por isso o cliente passado aqui tem
 * de ser o de SESSÃO (`lib/supabase/server.ts`), nunca o admin: com o admin a
 * policy não se aplica e o recorte vira enfeite. Repetir a regra em TypeScript
 * seria pior ainda: no dia em que `visibility_mode` mudasse, a tela e o banco
 * passariam a discordar sobre quem vê o quê, e a tela ganharia.
 *
 * **O universo sai dos CASOS, não do histórico de conversas**, porque os ids
 * voltam para a consulta seguinte dentro de uma query string até o PostgREST:
 * enumerar todas as conversas de uma instalação antiga montaria uma URL de
 * megabytes. `agent_cases` é legível org-wide pelo papel
 * (`tenant_isolation_agent_cases_select`) e `conversation_id` é uuid opaco —
 * este primeiro passo não mostra nada sobre a pessoa atendida.
 */
export async function conversasVisiveisDosCasos(
  sessao: SupabaseClient,
  organizationId: string,
  opts: { caseId?: string } = {},
): Promise<string[]> {
  const base = sessao
    .from("agent_cases")
    .select("conversation_id")
    .eq("organization_id", organizationId);
  const { data: dosCasos, error: erroDosCasos } = await (opts.caseId
    ? base.eq("id", opts.caseId)
    : base);
  if (erroDosCasos) throw new Error(erroDosCasos.message);

  const candidatas = [
    ...new Set(
      ((dosCasos ?? []) as Array<{ conversation_id: string }>).map((l) => l.conversation_id),
    ),
  ];
  if (candidatas.length === 0) return [];

  const { data: visiveis, error: erroVisiveis } = await sessao
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .in("id", candidatas);
  if (erroVisiveis) throw new Error(erroVisiveis.message);

  return ((visiveis ?? []) as Array<{ id: string }>).map((c) => c.id);
}

export interface ChamadoDaLista {
  id: string;
  title: string;
  summary: string;
  blocker: string;
  status: string;
  /**
   * Do que o caso trata — o corte por onde a fila se tria.
   *
   * ⚠️ ESTE CAMPO PRECISA APARECER EM TRÊS LUGARES, e os três são o contrato:
   * na `COLUNAS_*` (o que o PostgREST traz), aqui (o que a rota promete) e em
   * `achatarContato` (o que a rota de fato devolve). Ele já entrou na consulta
   * sem entrar na projeção uma vez: a coluna vinha do banco e morria no `map`,
   * e a tela renderizava "Outro" para todo caso, para sempre, com os gates
   * verdes. `string` e não a união porque o vocabulário é ABERTO no banco —
   * quem resolve valor desconhecido é `tipoDeCasoLabel`.
   */
  kind: string;
  opened_at: string;
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  /**
   * Quantas perguntas a equipe já fez à IA dentro deste caso.
   *
   * Hoje é sempre `0`, e `0` aqui é LITERAL, não um "não sei": a tabela do chat
   * do caso (`agent_case_chat_messages`) só nasce na onda 4, então ninguém
   * perguntou nada ainda. Quem ligar a contagem de verdade move as TRÊS pontas
   * juntas — consulta, projeção e tipo —, que é a regra que o comentário de
   * `kind` acima registra em sangue.
   */
  perguntas_no_chat?: number;
}

export interface EventoDoChamado {
  id: string;
  kind: string;
  actor_kind: string;
  actor_user_id: string | null;
  human_action: string | null;
  body: string | null;
  source: string | null;
  /** `metadata->>fora_da_fronteira`: "true" quando a resposta do cliente chegou fora do atendimento atual. */
  fora_da_fronteira: string | null;
  created_at: string;
}

export interface ChamadoDetalhado extends ChamadoDaLista {
  source: string;
  closed_at: string | null;
  events: EventoDoChamado[];
}

const COLUNAS_LISTA =
  "id, title, summary, blocker, status, kind, opened_at, conversation_id, " +
  "conversations:conversation_id(contacts:contact_id(name, phone_number))";

const COLUNAS_DETALHE =
  "id, title, summary, blocker, status, kind, source, opened_at, closed_at, conversation_id, " +
  "conversations:conversation_id(contacts:contact_id(name, phone_number))";

/** As mesmas colunas, sem o embed: o contato é juntado por `juntarContatos`. */
const COLUNAS_LISTA_SEM_EMBED =
  "id, title, summary, blocker, status, kind, opened_at, conversation_id";
const COLUNAS_DETALHE_SEM_EMBED =
  "id, title, summary, blocker, status, kind, source, opened_at, closed_at, conversation_id";

interface LinhaComContato {
  id: string;
  title: string;
  summary: string;
  blocker: string;
  status: string;
  kind: string | null;
  opened_at: string;
  conversation_id: string;
  source?: string;
  closed_at?: string | null;
  conversations: { contacts: { name: string | null; phone_number: string | null } | null } | null;
}

/**
 * O contato de cada chamado quando o cliente do banco é a service role (ramo do
 * token, Spec 33). O embed `conversations(contacts(...))` não passa pela RLS das
 * tabelas de dentro e a FK simples não confere organização: um chamado de uma
 * organização poderia trazer o nome e o telefone de um contato de outra. Aqui a
 * conversa e o contato saem de consultas próprias, ambas filtradas pela
 * organização; o que não for dela vira `conversations: null`, como a RLS faria.
 */
async function juntarContatos(
  supabase: SupabaseClient,
  organizationId: string,
  linhas: Array<Record<string, unknown>>,
): Promise<LinhaComContato[]> {
  const idsDasConversas = [
    ...new Set(linhas.map((l) => l.conversation_id).filter((id): id is string => typeof id === "string")),
  ];
  const contatoDaConversa = new Map<string, string | null>();
  const contatoPorId = new Map<string, { name: string | null; phone_number: string | null }>();
  if (idsDasConversas.length > 0) {
    const { data: conversas, error } = await supabase
      .from("conversations")
      .select("id, contact_id")
      .eq("organization_id", organizationId)
      .in("id", idsDasConversas);
    if (error) throw new Error(error.message);
    for (const c of (conversas ?? []) as Array<{ id: string; contact_id: string | null }>) {
      contatoDaConversa.set(c.id, c.contact_id);
    }
    const idsDosContatos = [
      ...new Set([...contatoDaConversa.values()].filter((id): id is string => typeof id === "string")),
    ];
    if (idsDosContatos.length > 0) {
      const { data: contatos, error: erroContatos } = await supabase
        .from("contacts")
        .select("id, name, phone_number")
        .eq("organization_id", organizationId)
        .in("id", idsDosContatos);
      if (erroContatos) throw new Error(erroContatos.message);
      for (const c of (contatos ?? []) as Array<{ id: string; name: string | null; phone_number: string | null }>) {
        contatoPorId.set(c.id, { name: c.name, phone_number: c.phone_number });
      }
    }
  }
  return linhas.map((l) => {
    const conversa = contatoDaConversa.has(l.conversation_id as string);
    const contatoId = contatoDaConversa.get(l.conversation_id as string) ?? null;
    return {
      ...l,
      conversations: conversa
        ? { contacts: contatoId ? (contatoPorId.get(contatoId) ?? null) : null }
        : null,
    } as unknown as LinhaComContato;
  });
}

function achatarContato(r: LinhaComContato): ChamadoDaLista {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    blocker: r.blocker,
    status: r.status,
    // `?? "outro"` e não `r.kind` cru: a coluna é `not null default 'outro'`,
    // mas uma linha lida por um caminho que ainda não a traga viraria
    // `undefined` no JSON — e `undefined` some na serialização, devolvendo à
    // tela exatamente o buraco que este campo existe para fechar.
    kind: r.kind ?? "outro",
    opened_at: r.opened_at,
    conversation_id: r.conversation_id,
    contact_name: r.conversations?.contacts?.name ?? null,
    contact_phone: r.conversations?.contacts?.phone_number ?? null,
    perguntas_no_chat: 0,
  };
}

export interface ResultadoDaLista {
  chamados: ChamadoDaLista[];
  /** Quantos continuam abertos — independe do filtro pedido. */
  abertos: number;
}

export async function listarChamados(
  supabase: SupabaseClient,
  organizationId: string,
  opts: {
    estado: "abertos" | "fechados";
    limite?: number;
    visiveisPara: ConversasVisiveis;
    /** Ramo do token: sem embed, contato juntado por consulta própria da organização. */
    contatoSeparado?: boolean;
  },
): Promise<ResultadoDaLista> {
  const estados = opts.estado === "abertos" ? ESTADOS_ABERTOS : ESTADOS_FECHADOS;
  const conversas = recorte(opts.visiveisPara);

  const filtrada = supabase
    .from("agent_cases")
    .select(opts.contatoSeparado ? COLUNAS_LISTA_SEM_EMBED : COLUNAS_LISTA)
    .eq("organization_id", organizationId)
    .in("status", estados as unknown as string[]);
  const base = (conversas === null ? filtrada : filtrada.in("conversation_id", conversas)).order(
    "opened_at",
    { ascending: false },
  );

  const { data, error } = await (opts.limite === undefined ? base : base.limit(opts.limite));
  if (error) throw new Error(error.message);

  // O contador recebe o MESMO recorte: ele é o crachá da navegação, e dizer
  // "2 em aberto" sobre uma lista de um manda a pessoa procurar um caso que ela
  // nunca vai achar.
  const contagem = supabase
    .from("agent_cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("status", ESTADOS_ABERTOS as unknown as string[]);
  const { count } = await (conversas === null
    ? contagem
    : contagem.in("conversation_id", conversas));

  const linhas = opts.contatoSeparado
    ? await juntarContatos(supabase, organizationId, (data ?? []) as unknown as Array<Record<string, unknown>>)
    : ((data ?? []) as unknown as LinhaComContato[]);
  return {
    chamados: linhas.map(achatarContato),
    abertos: count ?? 0,
  };
}

/**
 * null = não existe, é de outra organização, OU a conversa dele está fora do
 * recorte de quem pediu — os três pelo MESMO caminho, de propósito: a rota
 * devolve 404 nos três, e um 403 no terceiro confirmaria que o caso existe.
 */
export async function lerChamado(
  supabase: SupabaseClient,
  organizationId: string,
  caseId: string,
  opts: { visiveisPara: ConversasVisiveis; contatoSeparado?: boolean },
): Promise<ChamadoDetalhado | null> {
  // `opts?` embora o tipo o exija: quem esquecer o argumento inteiro tem de
  // cair na mensagem de `recorte`, não num "cannot read properties of
  // undefined" que não diz a quem ler o log o que faltou declarar.
  const conversas = recorte(opts?.visiveisPara);

  const consulta = supabase
    .from("agent_cases")
    .select(opts?.contatoSeparado ? COLUNAS_DETALHE_SEM_EMBED : COLUNAS_DETALHE)
    .eq("id", caseId)
    .eq("organization_id", organizationId);
  const { data: caseRow, error: caseErr } = await (conversas === null
    ? consulta
    : consulta.in("conversation_id", conversas)
  ).maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) return null;

  const { data: events, error: eventsErr } = await supabase
    .from("agent_case_events")
    .select("id, kind, actor_kind, actor_user_id, human_action, body, source:metadata->>source, fora_da_fronteira:metadata->>fora_da_fronteira, created_at")
    .eq("organization_id", organizationId)
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  if (eventsErr) throw new Error(eventsErr.message);

  const linha = opts.contatoSeparado
    ? ((await juntarContatos(supabase, organizationId, [caseRow as unknown as Record<string, unknown>]))[0] as LinhaComContato)
    : (caseRow as unknown as LinhaComContato);
  return {
    ...achatarContato(linha),
    source: linha.source ?? "agent",
    closed_at: linha.closed_at ?? null,
    events: (events ?? []) as EventoDoChamado[],
  };
}

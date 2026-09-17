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
}

export interface EventoDoChamado {
  id: string;
  kind: string;
  actor_kind: string;
  actor_user_id: string | null;
  human_action: string | null;
  body: string | null;
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
  opts: { estado: "abertos" | "fechados"; limite?: number },
): Promise<ResultadoDaLista> {
  const estados = opts.estado === "abertos" ? ESTADOS_ABERTOS : ESTADOS_FECHADOS;

  const base = supabase
    .from("agent_cases")
    .select(COLUNAS_LISTA)
    .eq("organization_id", organizationId)
    .in("status", estados as unknown as string[])
    .order("opened_at", { ascending: false });

  const { data, error } = await (opts.limite === undefined ? base : base.limit(opts.limite));
  if (error) throw new Error(error.message);

  const { count } = await supabase
    .from("agent_cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("status", ESTADOS_ABERTOS as unknown as string[]);

  return {
    chamados: ((data ?? []) as unknown as LinhaComContato[]).map(achatarContato),
    abertos: count ?? 0,
  };
}

/** null = não existe OU é de outra organização — 404 honesto, sem vazar existência. */
export async function lerChamado(
  supabase: SupabaseClient,
  organizationId: string,
  caseId: string,
): Promise<ChamadoDetalhado | null> {
  const { data: caseRow, error: caseErr } = await supabase
    .from("agent_cases")
    .select(COLUNAS_DETALHE)
    .eq("id", caseId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) return null;

  const { data: events, error: eventsErr } = await supabase
    .from("agent_case_events")
    .select("id, kind, actor_kind, actor_user_id, human_action, body, created_at")
    .eq("organization_id", organizationId)
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  if (eventsErr) throw new Error(eventsErr.message);

  const linha = caseRow as unknown as LinhaComContato;
  return {
    ...achatarContato(linha),
    source: linha.source ?? "agent",
    closed_at: linha.closed_at ?? null,
    events: (events ?? []) as EventoDoChamado[],
  };
}

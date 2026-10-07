/**
 * A VOLTA: o que a pessoa fez, num formato que o agente consegue ler.
 *
 * `buildHandoffSummary` (lib/agent-engine/agent/human-handoff.ts) já resolve a ida
 * — quando a IA para, o humano recebe um resumo em vez da conversa crua. A volta
 * não existia: o agente abria o chamado e ficava cego. Reassumir sem saber o que
 * foi decidido não é continuidade, é o cliente repetindo tudo para a máquina
 * depois de já ter combinado com uma pessoa.
 *
 * Este módulo LÊ (nunca escreve) as três superfícies onde o humano deixa rastro:
 *   - `agent_case_events` — a decisão explícita (resolveu / pediu algo ao cliente
 *     / escalou), com o texto que a pessoa escreveu;
 *   - `conversation_notes` — a nota interna, que nunca vai ao cliente;
 *   - `agent_cases` — o estado de cada chamado.
 *
 * E devolve DUAS coisas de propósito diferentes: os campos estruturados (para
 * quem for programar em cima) e `resumo`, um texto em português corrido — é o
 * `resumo` que entra no ritual de abertura do turno, porque é lá que o modelo lê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { textoLegivelDeMencao } from "@/lib/notifications/mentions";

/** O que a pessoa decidiu num chamado, na linguagem de quem vai ler. */
export interface DecisaoHumana {
  chamadoId: string;
  chamadoTitulo: string;
  /** `resolved` | `need_lead_info` | `escalate` — a ação registrada pela pessoa. */
  acao: string;
  /** O texto que a pessoa escreveu ao decidir. */
  texto: string;
  quando: string;
}

export interface NotaInterna {
  autor: string | null;
  texto: string;
  quando: string;
}

export interface ChamadoResumido {
  id: string;
  titulo: string;
  estado: string;
  abertoEm: string;
  fechadoEm: string | null;
}

export interface ContinuidadeHumana {
  /** false = nenhuma pessoa mexeu nesta conversa; não há o que retomar. */
  houveAtendimentoHumano: boolean;
  decisoes: DecisaoHumana[];
  notas: NotaInterna[];
  chamados: ChamadoResumido[];
  /**
   * O que ficou PENDENTE com o cliente — só existe quando a pessoa pediu algo a
   * ele (`need_lead_info`). Vira a próxima ação do agente ao retomar; nos outros
   * casos fica null em vez de adivinhar, porque próxima ação inventada faz o
   * agente cobrar o cliente por algo que ninguém combinou.
   */
  pendenciaComOCliente: string | null;
  /** O texto que o agente lê. Vazio quando não houve atendimento humano. */
  resumo: string;
}

/** Teto por superfície: o resumo entra num prompt, e prompt tem orçamento. */
const LIMITE_POR_SUPERFICIE = 10;

const ACAO_LEGIVEL: Record<string, string> = {
  resolved: "resolveu",
  need_lead_info: "pediu uma informação ao cliente",
  escalate: "escalou para outra pessoa",
};

export const CONTINUIDADE_VAZIA: ContinuidadeHumana = {
  houveAtendimentoHumano: false,
  decisoes: [],
  notas: [],
  chamados: [],
  pendenciaComOCliente: null,
  resumo: "",
};

interface CaseRow {
  id: string;
  title: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
}

interface CaseEventRow {
  case_id: string;
  human_action: string | null;
  body: string | null;
  created_at: string;
}

interface NoteRow {
  body: string;
  created_by_name: string | null;
  created_at: string;
}

/**
 * Lê o rastro humano de UMA conversa.
 *
 * Service role bypassa RLS, então `organization_id` entra explícito em toda
 * query — nunca vem do input do modelo.
 */
export async function lerContinuidadeHumana(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<ContinuidadeHumana> {
  const { data: casesData } = await supabase
    .from("agent_cases")
    .select("id, title, status, opened_at, closed_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("opened_at", { ascending: false })
    .limit(LIMITE_POR_SUPERFICIE);
  const cases = (casesData ?? []) as CaseRow[];
  const tituloPorChamado = new Map(cases.map((c) => [c.id, c.title] as const));

  let eventos: CaseEventRow[] = [];
  if (cases.length > 0) {
    const { data: eventsData } = await supabase
      .from("agent_case_events")
      .select("case_id, human_action, body, created_at")
      .eq("organization_id", organizationId)
      .in(
        "case_id",
        cases.map((c) => c.id),
      )
      .eq("kind", "human_replied")
      .order("created_at", { ascending: true });
    eventos = ((eventsData ?? []) as CaseEventRow[]).slice(-LIMITE_POR_SUPERFICIE);
  }

  const { data: notesData } = await supabase
    .from("conversation_notes")
    .select("body, created_by_name, created_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(LIMITE_POR_SUPERFICIE);
  const notas = ((notesData ?? []) as NoteRow[])
    .map((n) => ({ autor: n.created_by_name, texto: textoLegivelDeMencao(n.body), quando: n.created_at }))
    .reverse();

  const decisoes: DecisaoHumana[] = eventos.map((e) => ({
    chamadoId: e.case_id,
    chamadoTitulo: tituloPorChamado.get(e.case_id) ?? "chamado",
    acao: e.human_action ?? "respondeu",
    texto: (e.body ?? "").trim(),
    quando: e.created_at,
  }));

  const chamados: ChamadoResumido[] = cases.map((c) => ({
    id: c.id,
    titulo: c.title,
    estado: c.status,
    abertoEm: c.opened_at,
    fechadoEm: c.closed_at,
  }));

  // A pendência é a ÚLTIMA vez que alguém pediu algo ao cliente — pedidos
  // anteriores já foram superados pelo mais recente.
  const ultimoPedido = [...decisoes].reverse().find((d) => d.acao === "need_lead_info");
  const pendenciaComOCliente =
    ultimoPedido && ultimoPedido.texto !== "" ? ultimoPedido.texto : null;

  const houveAtendimentoHumano = decisoes.length > 0 || notas.length > 0;

  return {
    houveAtendimentoHumano,
    decisoes,
    notas,
    chamados,
    pendenciaComOCliente,
    resumo: houveAtendimentoHumano
      ? montarResumo({ decisoes, notas, pendenciaComOCliente })
      : "",
  };
}

/**
 * O texto que entra no prompt. Separado da leitura porque é o que os testes
 * conseguem prender: comparar frase montada é barato, comparar linha de banco é
 * caro — e é a FRASE que decide se o agente cita ou não o que a pessoa fez.
 */
export function montarResumo(input: {
  decisoes: DecisaoHumana[];
  notas: NotaInterna[];
  pendenciaComOCliente: string | null;
}): string {
  const linhas: string[] = [
    "Uma pessoa da equipe assumiu esta conversa e devolveu o atendimento para você.",
    "O que ela fez, e que o cliente já considera combinado:",
  ];

  for (const d of input.decisoes) {
    const acao = ACAO_LEGIVEL[d.acao] ?? d.acao;
    const texto = d.texto === "" ? "sem texto registrado" : d.texto;
    linhas.push(`- No chamado "${d.chamadoTitulo}", ${acao}: ${texto}`);
  }

  for (const n of input.notas) {
    const autor = n.autor ?? "a equipe";
    linhas.push(`- ${autor} anotou internamente: ${n.texto}`);
  }

  if (input.pendenciaComOCliente !== null) {
    linhas.push(`Ficou pendente com o cliente: ${input.pendenciaComOCliente}`);
  }

  linhas.push(
    "Retome daqui: não peça de novo o que já foi combinado nem contradiga a decisão da pessoa.",
  );
  return linhas.join("\n");
}

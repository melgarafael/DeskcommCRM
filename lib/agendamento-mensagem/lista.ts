/**
 * LISTA DOS AGENDAMENTOS DE TODAS AS CONVERSAS QUE A SESSÃO ENXERGA (segunda
 * parte da #3118, escopo do "Exibir todos").
 *
 * A RÉGUA É A DA CONVERSA, não a do autor. Quem lê é o cliente de SESSÃO: a
 * policy de `mensagens_agendadas` (migration 20261111132432_9336) confere a
 * linha em `conversations` pela RLS dela, então o PostgREST só devolve o
 * agendamento cuja conversa a pessoa enxerga — papel, `visibility_mode`, setor,
 * participante e contato pessoal valem aqui sem uma linha de cópia. O gestor vê
 * o envio que OUTRO atendente agendou numa conversa da equipe; quem não enxerga
 * a conversa não vê o envio dela. Por isso esta consulta NÃO filtra por
 * `created_by_user_id`: fazer isso esconderia justamente o envio do colega.
 *
 * Quem chama passa o cliente de sessão, nunca o `service_role`: o admin ignora a
 * RLS e devolveria a empresa inteira.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Teto explícito da página: o PostgREST corta em 1000, e a tela não pede mais que isso. */
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 50;

/**
 * O contato vem junto porque a lista cruza conversas: sem o nome, duas linhas
 * para "11:00" não dizem de quem são. O embed segue a FK `contact_id`.
 */
export const COLUNAS_DA_LISTA =
  "id, conversation_id, contact_id, title, body, scheduled_at, status, se_desconectado, motivo, created_at, mensagem:messages(status), contato:contacts(name, phone_number)";

export interface AgendamentoDaLista {
  id: string;
  conversation_id: string;
  contact_id: string;
  title: string | null;
  body: string;
  scheduled_at: string;
  status: "agendada" | "encaminhada" | "falhou" | "cancelada";
  se_desconectado: "esperar" | "cancelar";
  motivo: string | null;
  created_at: string;
  mensagem: { status: string } | null;
  contato: { name: string | null; phone_number: string | null } | null;
}

type Parametros = { get: (nome: string) => string | null };

/** Só dígitos: `-7`, `1e3` e lixo não viram número por acidente. */
function inteiroPositivo(bruto: string | null): number | null {
  if (bruto === null) return null;
  const limpo = bruto.trim();
  if (!/^\d+$/.test(limpo)) return null;
  return Number(limpo);
}

/**
 * `limit`/`offset` da query string, com os limites aplicados no servidor: o teto
 * não depende de a tela pedir direito. Valor ausente ou inválido cai no padrão;
 * `limit=0` também (página vazia não é página).
 */
export function paginaDaConsulta(parametros: Parametros): { limite: number; deslocamento: number } {
  const limite = inteiroPositivo(parametros.get("limit"));
  const deslocamento = inteiroPositivo(parametros.get("offset"));
  return {
    limite: limite !== null && limite > 0 ? Math.min(limite, LIMITE_MAXIMO) : LIMITE_PADRAO,
    deslocamento: deslocamento ?? 0,
  };
}

/** Tem mais linha depois desta página? `total` nulo (sem contagem) cai na página cheia. */
export function temMaisPagina(deslocamento: number, nestaPagina: number, total: number | null, limite: number): boolean {
  if (total === null) return nestaPagina >= limite;
  return deslocamento + nestaPagina < total;
}

export async function listarAgendamentosVisiveis(
  sessao: SupabaseClient,
  opcoes: { organizationId: string; limite: number; deslocamento: number },
): Promise<{ linhas: AgendamentoDaLista[]; total: number | null; erro: string | null }> {
  // `.order("scheduled_at")` ascendente: o próximo a sair é o primeiro da lista
  // operacional. O `id` desempata — sem ele, duas linhas no mesmo minuto podem
  // trocar de lugar entre a página 1 e a 2 e uma delas some.
  const { data, error, count } = await sessao
    .from("mensagens_agendadas")
    .select(COLUNAS_DA_LISTA, { count: "exact" })
    .eq("organization_id", opcoes.organizationId)
    .order("scheduled_at", { ascending: true })
    .order("id", { ascending: true })
    .range(opcoes.deslocamento, opcoes.deslocamento + opcoes.limite - 1);
  if (error) return { linhas: [], total: null, erro: error.message };
  return { linhas: (data ?? []) as unknown as AgendamentoDaLista[], total: count ?? null, erro: null };
}

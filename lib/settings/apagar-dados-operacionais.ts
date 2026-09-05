import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reset dos dados de ATENDIMENTO de uma organização — o motor da "Zona de
 * perigo" de Configurações › Organização.
 *
 * Extraído da contribuição de @maugarciasa (PR #556). O original delegava tudo
 * a uma RPC `fn_apagar_dados_operacionais_da_organizacao` que **não existia em
 * lugar nenhum do repositório** — nem em `supabase/migrations/`, nem no
 * `baseline.sql`. Aqui o apagamento é feito pelo próprio app, o que evita criar
 * uma `security definer` nova em `public` cujo ÚNICO parâmetro de seleção de
 * linha é a organização — exatamente a forma que a doutrina de migrations
 * (cabeçalho da 0167) descreve como porta de adulteração.
 *
 * ── Por que a ORDEM é código e não estilo ────────────────────────────────────
 * Três FKs para `contacts` são ON DELETE RESTRICT (medido no baseline aplicado:
 * `messages.contact_id`, `conversations.contact_id`,
 * `calendar_appointments.contact_id`). Apagar `contacts` antes deles devolve
 * 23503 e o reset morre pela metade. O resto do grafo é CASCADE ou SET NULL, e
 * o Postgres cuida — por isso a lista abaixo é curta de propósito: ela é o
 * conjunto MÍNIMO de raízes, não a lista de tudo que some.
 *
 * O que some junto, por CASCADE (não precisa estar na lista, e não deve):
 *   de `conversations` → agent_cases, conversation_notes,
 *     conversation_assignment_events, demanda_conversas, messages
 *   de `contacts` → demandas, lead_state, lead_state_transitions,
 *     lead_checkpoints, lead_notes, followup_enrollments, send_ledger,
 *     job_queue, cron_jobs, before_send_traces, contact_field_proposals
 *   de `crm_leads` → crm_lead_activities, crm_lead_links, crm_lead_scores,
 *     crm_lead_risk_states, crm_lead_reactivations
 *
 * O que SOBREVIVE de propósito (e é o ponto da feature): usuários, convites,
 * a organização e suas configurações, funis e etapas, agentes de IA e suas
 * credenciais, canais de WhatsApp, tokens de API, `api_audit_log` (append-only)
 * e `lgpd_requests` (registro legal — a FK para contato é SET NULL).
 */

/** Uma raiz do apagamento: a tabela e por que ela vem nesta posição. */
interface Raiz {
  readonly tabela: TabelaOperacional;
  readonly porque: string;
}

export type TabelaOperacional =
  | "messages"
  | "conversations"
  | "calendar_appointments"
  | "orders"
  | "crm_leads"
  | "contacts";

/**
 * A ordem é a do apagamento e é significativa: quem tem FK RESTRICT para
 * `contacts` precisa sair antes dele.
 */
export const RAIZES_DO_APAGAMENTO: readonly Raiz[] = [
  { tabela: "messages", porque: "FK RESTRICT para contacts" },
  { tabela: "conversations", porque: "FK RESTRICT para contacts" },
  { tabela: "calendar_appointments", porque: "FK RESTRICT para contacts" },
  { tabela: "orders", porque: "FK SET NULL para contacts; ninguém a referencia" },
  { tabela: "crm_leads", porque: "FK SET NULL para contacts" },
  { tabela: "contacts", porque: "a raiz do grafo — sempre por último" },
] as const;

export type ContagensApagadas = Record<TabelaOperacional, number>;

export interface FalhaAoApagar {
  readonly tabela: TabelaOperacional;
  readonly mensagem: string;
}

export type ResultadoDoApagamento =
  | { readonly ok: true; readonly counts: ContagensApagadas }
  | { readonly ok: false; readonly falha: FalhaAoApagar; readonly counts: ContagensApagadas };

function contagensZeradas(): ContagensApagadas {
  return {
    messages: 0,
    conversations: 0,
    calendar_appointments: 0,
    orders: 0,
    crm_leads: 0,
    contacts: 0,
  };
}

/**
 * Apaga, NA ORDEM, os dados de atendimento de UMA organização.
 *
 * Todo DELETE carrega `.eq("organization_id", organizationId)` — o client aqui
 * é o de service role, que bypassa RLS, então o filtro é a única coisa que
 * separa uma organização da vizinha. `organizationId` tem de vir da sessão
 * (`resolveActiveOrg`), NUNCA do corpo da requisição.
 *
 * Não é atômico: o PostgREST não expõe transação de várias chamadas. A ordem é
 * escolhida para que uma parada no meio deixe o banco íntegro (filhos antes dos
 * pais) e para que repetir a ação continue de onde parou. Por isso as contagens
 * parciais voltam junto com a falha, em vez de serem perdidas.
 */
export async function apagarDadosOperacionaisDaOrg(
  client: SupabaseClient,
  organizationId: string,
): Promise<ResultadoDoApagamento> {
  const counts = contagensZeradas();

  for (const { tabela } of RAIZES_DO_APAGAMENTO) {
    const { count, error } = await client
      .from(tabela)
      .delete({ count: "exact" })
      .eq("organization_id", organizationId);

    if (error) {
      return { ok: false, falha: { tabela, mensagem: error.message }, counts };
    }
    counts[tabela] = count ?? 0;
  }

  return { ok: true, counts };
}

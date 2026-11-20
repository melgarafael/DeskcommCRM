import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reset dos dados de TESTE de uma organização (tela "Limpar dados de teste") — o motor da "Zona de
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
 * ⚠️ FORA desta lista, de propósito: a prospecção (`prospecting_campaigns` /
 * `prospecting_candidates`). Candidato com `suppression_salt` é a TOMBA de quem
 * exerceu opt-out ou exclusão (migration 0370) e é ela que recusa reimportar a
 * pessoa; apagar a campanha leva a tomba por cascata. Entra num PR próprio, que
 * apague só o que não é supressão.
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
  // D10: `crm_proposals` tem FK SET NULL (não mais CASCADE) para lead e
  // contato — sem raiz própria aqui, uma proposta enviada ficaria órfã PARA
  // SEMPRE num reset "total" da organização, e o PDF dela continuaria
  // ocupando o bucket sem nenhuma linha apontando pra ele.
  | "crm_proposals"
  | "crm_leads"
  | "contacts"
  // A22 (issue #4887): o módulo "Empresas e pessoas" nasceu depois do reset, e a
  // base de teste deixava empresas, pessoas e lotes de importação para trás.
  | "import_batches"
  | "people"
  | "companies";

/**
 * A ordem é a do apagamento e é significativa: quem tem FK RESTRICT para
 * `contacts` precisa sair antes dele.
 */
export const RAIZES_DO_APAGAMENTO: readonly Raiz[] = [
  { tabela: "messages", porque: "FK RESTRICT para contacts" },
  { tabela: "conversations", porque: "FK RESTRICT para contacts" },
  { tabela: "calendar_appointments", porque: "FK RESTRICT para contacts" },
  { tabela: "orders", porque: "FK SET NULL para contacts; ninguém a referencia" },
  { tabela: "crm_proposals", porque: "FK SET NULL para contacts e crm_leads (D10) — raiz própria" },
  { tabela: "crm_leads", porque: "FK SET NULL para contacts" },
  { tabela: "contacts", porque: "a raiz do grafo do atendimento — vem depois de quem o referencia" },
  // A22. Nenhuma FK RESTRICT aponta para as três abaixo (medido no baseline:
  // `company_people` cai em CASCADE com a empresa ou a pessoa; `contacts.person_id`,
  // `contacts.company_id` e `import_rows.company_id/person_id` são SET NULL; as
  // `import_rows` caem em CASCADE com o lote). Vêm DEPOIS de `contacts` só para o
  // `set null` não reescrever linha que a linha seguinte vai apagar.
  { tabela: "import_batches", porque: "as import_rows caem em CASCADE com o lote" },
  { tabela: "people", porque: "company_people cai em CASCADE; contacts.person_id é SET NULL" },
  { tabela: "companies", porque: "company_people cai em CASCADE; contacts.company_id é SET NULL" },
] as const;

export type ContagensApagadas = Record<TabelaOperacional, number>;

export interface FalhaAoApagar {
  readonly tabela: TabelaOperacional;
  readonly mensagem: string;
}

export type ResultadoDoApagamento =
  | { readonly ok: true; readonly counts: ContagensApagadas; readonly pdfsRemovidos: number }
  | { readonly ok: false; readonly falha: FalhaAoApagar; readonly counts: ContagensApagadas; readonly pdfsRemovidos: number };

function contagensZeradas(): ContagensApagadas {
  return {
    messages: 0,
    conversations: 0,
    calendar_appointments: 0,
    orders: 0,
    crm_proposals: 0,
    crm_leads: 0,
    contacts: 0,
    import_batches: 0,
    people: 0,
    companies: 0,
  };
}

export type ResultadoDaPrevia =
  | { readonly ok: true; readonly counts: ContagensApagadas }
  | { readonly ok: false; readonly falha: FalhaAoApagar };

/**
 * A PRÉVIA do reset: quantas linhas cada raiz tem HOJE na organização, sem
 * apagar nada (A22). É a mesma lista, na mesma ordem e com o mesmo filtro de
 * `organization_id` do apagamento — uma lista própria para a tela viraria uma
 * segunda verdade, e a primeira tabela nova acrescentada às raízes sumiria da
 * prévia. É contagem exata de cabeçalho (`head: true`), sem trazer linha.
 *
 * ⚠️ Falha de contagem NÃO vira zero: a tela diria "nada a apagar" de uma base
 * cheia. Devolve a falha, e a tela mostra que não conseguiu contar.
 */
export async function contarDadosParaLimparDaOrg(
  client: SupabaseClient,
  organizationId: string,
): Promise<ResultadoDaPrevia> {
  const counts = contagensZeradas();
  for (const { tabela } of RAIZES_DO_APAGAMENTO) {
    const { count, error } = await client
      .from(tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    if (error) return { ok: false, falha: { tabela, mensagem: error.message } };
    counts[tabela] = count ?? 0;
  }
  return { ok: true, counts };
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
      return { ok: false, falha: { tabela, mensagem: error.message }, counts, pdfsRemovidos: 0 };
    }
    counts[tabela] = count ?? 0;
  }

  // D10: os PDFs de proposta (bucket `propostas`, path `<org>/<id>.pdf` —
  // lib/propostas/storage.ts) não têm FK nenhuma que os apague sozinhos; o
  // reset "total" só está completo quando a pasta da organização some junto
  // com as linhas de `crm_proposals` apagadas acima. O contador de numeração
  // (`crm_proposal_counters`) NÃO é tocado por este reset — a organização
  // pode zerar o atendimento e continuar numerando propostas de onde parou.
  // `storage.list()` pagina em 100 por padrão (storage-js) — sem o laço,
  // qualquer organização com mais de 100 propostas ficava com PDFs órfãos
  // no bucket depois do reset. Sempre lista do zero: cada `remove()` já tira
  // do bucket os arquivos que acabaram de ser listados, então a próxima
  // chamada devolve o lote seguinte na mesma posição — não precisa (nem pode
  // confiar em) offset, que uma listagem que muda debaixo do pé tornaria
  // instável.
  let pdfsRemovidos = 0;
  const LOTE = 100;
  for (;;) {
    const { data: arquivos, error: listErr } = await client.storage
      .from("propostas")
      .list(organizationId, { limit: LOTE });
    if (listErr || !arquivos || arquivos.length === 0) break;

    const { error: removeErr } = await client.storage
      .from("propostas")
      .remove(arquivos.map((a) => `${organizationId}/${a.name}`));
    if (removeErr) break;
    pdfsRemovidos += arquivos.length;

    if (arquivos.length < LOTE) break;
  }

  return { ok: true, counts, pdfsRemovidos };
}

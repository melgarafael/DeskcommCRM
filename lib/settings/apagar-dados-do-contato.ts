/**
 * Apaga TUDO de UM contato, como o `limpar-tudo.sh` faz por telefone (C-104).
 *
 * ─── Por que existe, e por que NÃO é o `deleteContactHandler` ───────────────
 *
 * `deleteContactHandler` (`app/api/v1/contacts/_handler.ts`) apaga só
 * `messages` → `conversations` → `contacts` e deixa o banco cascatear. Isto
 * basta para o botão "Excluir contato" da lista, mas NÃO para o pedido do dono,
 * cujo efeito tem de ser idêntico ao script de limpeza: sobram resíduos que o
 * script apaga explicitamente (checkpoints, fila de jobs, ledger de envio,
 * traces, runs de IA, dados/eventos do fluxo, follow-up) — e é justamente esse
 * resíduo que fazia o agente "lembrar" o teste e o cliente reaparecer com
 * histórico.
 *
 * ─── O que a ordem paga ─────────────────────────────────────────────────────
 *
 * `messages`, `conversations` e `calendar_appointments` têm FK RESTRICT para
 * `contacts` no baseline. Filhos antes dos pais; `contacts` por último. O resto
 * é CASCADE ou SET NULL — as deleções explícitas abaixo são o cinto sobre o
 * suspensório que o script já usava, e saem ANTES do pai por segurança.
 *
 * ─── O que SOBREVIVE de propósito ───────────────────────────────────────────
 *
 * `api_audit_log` (append-only), `lgpd_requests` (registro legal — a FK para
 * contato é SET NULL, então o pedido permanece sem o titular) e a própria
 * organização com agente, canais e configurações. O script de teste apaga
 * `lgpd_requests`; aqui NÃO se apaga, porque isto também roda para um pedido de
 * cliente de verdade, e destruir o registro do próprio pedido seria apagar a
 * prova do cumprimento.
 *
 * ─── Não é atômico, e a direção do erro é escolhida ─────────────────────────
 *
 * O PostgREST não expõe transação de várias chamadas. As deleções são
 * best-effort e os pais (messages → conversations → contacts) são checados no
 * fim: uma parada no meio deixa o banco íntegro (filhos antes dos pais) e
 * repetir a ação continua de onde parou. `ok: false` significa que ainda há
 * resíduo, e a lista de `falhas` diz onde.
 *
 * Toda query é escopada por `contact_id` (UUID globalmente único) e, nos pais,
 * também por `organization_id` — o client de service role bypassa RLS, então o
 * filtro é a única separação entre organizações.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FalhaDoApagamento {
  readonly tabela: string;
  readonly mensagem: string;
}

/**
 * A superfície do PostgREST que esta função usa — nada além disso. Declarada em
 * vez de importada pelo mesmo motivo de `ClienteDaCascata` em
 * `lib/lgpd/cascata.ts`: o teste injeta um dublê, e amarrar a assinatura aos
 * genéricos do `SupabaseClient` obrigaria a reimplementar o construtor de query.
 */
interface FiltravelDoDelete
  extends PromiseLike<{ count: number | null; error: { message: string } | null }> {
  eq(coluna: string, valor: string): FiltravelDoDelete;
  in(coluna: string, valores: string[]): FiltravelDoDelete;
}

export interface ResultadoApagamentoDoContato {
  readonly ok: boolean;
  /** Linhas apagadas por tabela. Tabela ausente do mapa = não tocada. */
  readonly counts: Record<string, number>;
  readonly falhas: readonly FalhaDoApagamento[];
}

/** Filhos de `conversations`, apagados por `conversation_id`. */
const FILHOS_DA_CONVERSA = [
  "ai_invocations",
  "conversation_notes",
  "conversation_assignment_events",
  "demanda_conversas",
  "agent_cases",
] as const;

/** Estado preso ao contato, apagado por `contact_id`. */
const FILHOS_DO_CONTATO = [
  "before_send_traces",
  "llm_calls",
  "ai_agent_runs",
  "ai_reply_drafts",
  "calendar_appointments",
  "calendar_google_reconcilable_appointments",
  "orders",
  "crm_lead_activities",
  "crm_tasks",
  "cron_jobs",
  "webhook_lead_captures",
  "contact_field_proposals",
  "lead_checkpoints",
  "lead_notes",
  "lead_state_transitions",
  "lead_state",
  "send_ledger",
  "contact_flow_data",
  "contact_flow_events",
  "followup_enrollments",
  "job_queue",
] as const;

/** Resíduos indexados pela sessão do canal, não pelo contato. */
const RESIDUOS_POR_SESSAO = ["pacing_ledger", "outbound_copies"] as const;

/**
 * Apaga, na ordem, tudo de UM contato dentro de UMA organização.
 *
 * `client` deve ser o de service role (admin). `organizationId` e `contactId`
 * vêm de fonte confiável — no caminho do cliente, da própria ingestão; no do
 * atendente, de `requireRole` + consulta escopada.
 */
export async function apagarDadosDoContato(
  client: SupabaseClient,
  alvo: { readonly organizationId: string; readonly contactId: string },
): Promise<ResultadoApagamentoDoContato> {
  const { organizationId, contactId } = alvo;
  const counts: Record<string, number> = {};
  const falhas: FalhaDoApagamento[] = [];

  async function apagar(
    tabela: string,
    aplicar: (q: FiltravelDoDelete) => FiltravelDoDelete,
  ): Promise<void> {
    const base = client.from(tabela).delete({ count: "exact" }) as unknown as FiltravelDoDelete;
    const { count, error } = await aplicar(base);
    if (error) {
      falhas.push({ tabela, mensagem: error.message });
      return;
    }
    counts[tabela] = (counts[tabela] ?? 0) + (count ?? 0);
  }

  // 1) Sessões e conversas do contato (a base dos resíduos por sessão).
  const { data: conversas, error: erroConversas } = await client
    .from("conversations")
    .select("id, channel_session_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId);
  if (erroConversas) {
    return {
      ok: false,
      counts,
      falhas: [{ tabela: "conversations", mensagem: `leitura falhou: ${erroConversas.message}` }],
    };
  }
  const convIds = (conversas ?? [])
    .map((r: { id?: unknown }) => (typeof r.id === "string" ? r.id : null))
    .filter((v): v is string => v !== null);
  const sessIds = [
    ...new Set(
      (conversas ?? [])
        .map((r: { channel_session_id?: unknown }) =>
          typeof r.channel_session_id === "string" ? r.channel_session_id : null,
        )
        .filter((v): v is string => v !== null),
    ),
  ];

  // 2) Filhos das conversas.
  for (const tabela of FILHOS_DA_CONVERSA) {
    if (convIds.length === 0) break;
    await apagar(tabela, (q) => q.in("conversation_id", convIds));
  }

  // 3) Estado preso ao contato.
  for (const tabela of FILHOS_DO_CONTATO) {
    await apagar(tabela, (q) => q.eq("contact_id", contactId));
  }

  // 4) Resíduos por sessão.
  if (sessIds.length > 0) {
    for (const tabela of RESIDUOS_POR_SESSAO) {
      await apagar(tabela, (q) => q.in("channel_session_id", sessIds));
    }
  }

  // 5) Pais, do filho para a raiz. `messages`/`conversations` RESTRICT: se
  //    falharem, `contacts` também falha e a prova final acusa.
  await apagar("messages", (q) => q.eq("contact_id", contactId));
  await apagar("crm_leads", (q) => q.eq("contact_id", contactId));
  await apagar("demandas", (q) => q.eq("contact_id", contactId));
  await apagar("conversations", (q) => q.eq("contact_id", contactId));
  await apagar("contacts", (q) => q.eq("id", contactId).eq("organization_id", organizationId));

  // 6) Prova: o contato não pode sobrar. Se sobrar, `ok: false`.
  const { data: resto, error: erroResto } = await client
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroResto) {
    falhas.push({ tabela: "contacts", mensagem: `prova falhou: ${erroResto.message}` });
  }
  const ok = !resto && falhas.length === 0;

  return { ok, counts, falhas };
}

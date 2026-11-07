/**
 * O NEGÓCIO DA TAREFA QUANDO O CLIENTE DO BANCO É A SERVICE ROLE (Spec 33, R2).
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * Na sessão, `crm_tasks` é lido com o embed `lead:crm_leads(id, title)`: quem
 * decide, linha a linha, qual negócio aparece é a RLS de `crm_leads`. No ramo
 * do TOKEN o cliente é a service role, que contorna a RLS por desenho, e o
 * embed devolveria o título de QUALQUER negócio apontado por `lead_id`.
 *
 * `crm_tasks.lead_id` é uma chave estrangeira simples (migration 0210): a
 * conferência de chave estrangeira do Postgres não passa pela RLS, então uma
 * tarefa de uma organização pode apontar para o negócio de outra. Com o embed
 * e a service role, o título desse negócio sairia na resposta — vazamento
 * entre organizações por uma consulta que nenhum `.eq("organization_id")` da
 * rota alcança, porque o filtro está na tabela de fora e a junção é do
 * PostgREST.
 *
 * ─── O remédio ──────────────────────────────────────────────────────────────
 *
 * No ramo do token a rota lê `crm_tasks` SEM o embed e junta o negócio aqui, em
 * consulta própria, filtrada pela organização da linha do token. Negócio de
 * outra organização vira `lead: null` — o mesmo que a RLS faz na sessão. A
 * sessão não passa por este arquivo: ela segue com o embed e com a RLS.
 *
 * `conferirNegocioEContato` é a metade da escrita: o token não grava uma tarefa
 * presa a negócio ou contato de outra organização (a mesma régua que
 * `conferirDemanda` e `conferirResponsavel` já aplicam a `demanda_id` e
 * `assigned_to`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { NegocioDaTarefa, Tarefa } from "@/lib/tarefas/tipos";

/** As colunas que a tela lê, sem o negócio embutido. */
export const COLUNAS_DA_TAREFA =
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at";

/**
 * Quantos ids de negócio vão em cada consulta. Os ids viajam na URL do
 * PostgREST (`in.(…)`); a lista corta em 500 tarefas, e 500 uuids passariam do
 * teto de URL do proxy. Lotes de 100 cabem com folga.
 */
const TAMANHO_DO_LOTE = 100;

/**
 * Junta a cada tarefa o negócio de `lead_id`, achado SÓ dentro da organização.
 * Devolve `null` quando a consulta falha: quem chama decide se isso derruba a
 * resposta (a lista) ou só zera o negócio (uma escrita que já gravou).
 */
export async function anexarNegocioDaTarefa(
  db: SupabaseClient,
  organizationId: string,
  tarefas: Tarefa[],
): Promise<Tarefa[] | null> {
  const ids = [
    ...new Set(tarefas.map((t) => t.lead_id).filter((id): id is string => typeof id === "string")),
  ];

  const porId = new Map<string, NegocioDaTarefa>();
  for (let i = 0; i < ids.length; i += TAMANHO_DO_LOTE) {
    const { data, error } = await db
      .from("crm_leads")
      .select("id, title")
      .eq("organization_id", organizationId)
      .in("id", ids.slice(i, i + TAMANHO_DO_LOTE));
    if (error) return null;
    for (const negocio of (data ?? []) as NegocioDaTarefa[]) {
      porId.set(negocio.id, { id: negocio.id, title: negocio.title });
    }
  }

  return tarefas.map((t) => ({
    ...t,
    lead: t.lead_id ? (porId.get(t.lead_id) ?? null) : null,
  }));
}

export type VereditoDosVinculos = "aceitos" | "fora_da_organizacao" | "falha_na_consulta";

/**
 * O negócio e o contato a que uma tarefa pode ser presa: têm de existir na
 * organização do token. `null` e ausente passam (a tarefa avulsa é caso real, e
 * `null` é como se desvincula).
 */
export async function conferirNegocioEContato(
  db: SupabaseClient,
  organizationId: string,
  vinculos: { lead_id?: string | null; contact_id?: string | null },
): Promise<VereditoDosVinculos> {
  const alvos: Array<{ tabela: "crm_leads" | "contacts"; id: string | null | undefined }> = [
    { tabela: "crm_leads", id: vinculos.lead_id },
    { tabela: "contacts", id: vinculos.contact_id },
  ];

  for (const alvo of alvos) {
    if (!alvo.id) continue;
    const { data, error } = await db
      .from(alvo.tabela)
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", alvo.id)
      .maybeSingle();
    if (error) return "falha_na_consulta";
    if (!data) return "fora_da_organizacao";
  }
  return "aceitos";
}

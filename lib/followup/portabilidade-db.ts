/**
 * A parte de `portabilidade.ts` que lê o banco: os NOMES do que o grafo cita
 * (exportação) e o que a organização de destino tem (importação).
 *
 * Toda leitura filtra `organization_id` explicitamente, mesmo pelo client da
 * sessão: a RLS é piso, não escopo — quem pertence a duas organizações enxerga
 * as linhas das duas, e o remapeamento por nome não pode casar com a conta errada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ContextoDaConta, IdsCitados, NomesDaOrigem } from "./portabilidade";

type Linha = Record<string, unknown>;

async function linhas(
  consulta: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Linha[]> {
  const { data, error } = await consulta;
  if (error) throw new Error(error.message);
  return (data ?? []) as Linha[];
}

/** «Etapa · Funil» — o rótulo que o `validate-publish` e o seletor de etapas mostram. */
async function rotulosDeEtapa(
  supabase: SupabaseClient,
  organizationId: string,
  etapas: Linha[],
): Promise<Map<string, string>> {
  const idsDeFunil = [...new Set(etapas.map((e) => String(e.pipeline_id)))];
  const funis =
    idsDeFunil.length === 0
      ? []
      : await linhas(
          supabase
            .from("crm_pipelines")
            .select("id, name")
            .eq("organization_id", organizationId)
            .in("id", idsDeFunil),
        );
  const nomeDoFunil = new Map(funis.map((f) => [String(f.id), String(f.name)]));
  return new Map(
    etapas.map((e) => {
      const funil = nomeDoFunil.get(String(e.pipeline_id));
      return [String(e.id), funil ? `${String(e.name)} · ${funil}` : String(e.name)];
    }),
  );
}

/** Nomes, na organização de ORIGEM, de cada id que o fluxo exportado cita. */
export async function nomesDaOrigem(
  supabase: SupabaseClient,
  organizationId: string,
  citados: IdsCitados,
): Promise<NomesDaOrigem> {
  const vazio = <T>() => Promise.resolve([] as T[]);
  const [etapas, mensagens, aprovados, fluxos, tipos] = await Promise.all([
    citados.stages.size === 0
      ? vazio<Linha>()
      : linhas(
          supabase
            .from("crm_stages")
            .select("id, name, pipeline_id")
            .eq("organization_id", organizationId)
            .in("id", [...citados.stages]),
        ),
    citados.templates.size === 0
      ? vazio<Linha>()
      : linhas(
          supabase
            .from("message_templates")
            .select("id, title")
            .eq("organization_id", organizationId)
            .in("id", [...citados.templates]),
        ),
    citados.templates.size === 0
      ? vazio<Linha>()
      : linhas(
          supabase
            .from("meta_templates")
            .select("id, name")
            .eq("organization_id", organizationId)
            .in("id", [...citados.templates]),
        ),
    citados.flows.size === 0
      ? vazio<Linha>()
      : linhas(
          supabase
            .from("followup_flow_pointers")
            .select("id, name")
            .eq("organization_id", organizationId)
            .in("id", [...citados.flows]),
        ),
    citados.event_types.size === 0
      ? vazio<Linha>()
      : linhas(
          supabase
            .from("calendar_event_types")
            .select("id, name")
            .eq("organization_id", organizationId)
            .in("id", [...citados.event_types]),
        ),
  ]);

  return {
    stages: await rotulosDeEtapa(supabase, organizationId, etapas),
    templates: new Map([
      ...mensagens.map((m) => [String(m.id), String(m.title)] as [string, string]),
      ...aprovados.map((m) => [String(m.id), String(m.name)] as [string, string]),
    ]),
    flows: new Map(fluxos.map((f) => [String(f.id), String(f.name)])),
    event_types: new Map(tipos.map((t) => [String(t.id), String(t.name)])),
  };
}

/**
 * O que a organização de DESTINO tem — o universo contra o qual o arquivo é conferido.
 *
 * `admin` lê SÓ os membros: a RLS de `user_organizations` deixa um gerente ver
 * apenas a própria linha (`user_orgs_select`), e pela sessão a tarefa atribuída a
 * um colega viraria «dono do lead» numa importação na própria conta. Lê id e as
 * datas de aceite/revogação — nada de pessoa — e filtra a organização da sessão.
 */
export async function contextoDaConta(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  organizationId: string,
): Promise<ContextoDaConta> {
  const [etapas, mensagens, aprovados, membros, fluxos, tipos] = await Promise.all([
    // Etapa arquivada não é destino: o `validate-publish` a recusa
    // (`check_stage_archived`). Fora do universo, o id dela vira remapeamento
    // por nome para a etapa ativa equivalente — ou pendência.
    linhas(
      supabase
        .from("crm_stages")
        .select("id, name, pipeline_id")
        .eq("organization_id", organizationId)
        .eq("is_archived", false),
    ),
    linhas(
      supabase.from("message_templates").select("id, title").eq("organization_id", organizationId),
    ),
    linhas(
      supabase.from("meta_templates").select("id, name").eq("organization_id", organizationId),
    ),
    linhas(
      admin
        .from("user_organizations")
        .select("user_id, accepted_at, revoked_at")
        .eq("organization_id", organizationId),
    ),
    linhas(
      supabase
        .from("followup_flow_pointers")
        .select("id, name")
        .eq("organization_id", organizationId),
    ),
    linhas(
      supabase
        .from("calendar_event_types")
        .select("id, name")
        .eq("organization_id", organizationId),
    ),
  ]);

  return {
    stages: await rotulosDeEtapa(supabase, organizationId, etapas),
    templates: new Map([
      ...mensagens.map((m) => [String(m.id), String(m.title)] as [string, string]),
      ...aprovados.map((m) => [String(m.id), String(m.name)] as [string, string]),
    ]),
    users: new Set(
      membros.filter((m) => m.accepted_at && !m.revoked_at).map((m) => String(m.user_id)),
    ),
    flows: new Map(fluxos.map((f) => [String(f.id), String(f.name)])),
    event_types: new Map(tipos.map((t) => [String(t.id), String(t.name)])),
  };
}

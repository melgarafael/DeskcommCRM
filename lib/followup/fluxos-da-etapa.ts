/**
 * «Quais fluxos de follow-up disparam quando o negócio ENTRA nesta etapa?» —
 * a leitura que faltava (issue #3603).
 *
 * ─── Por que aqui, e não em cada rota ─────────────────────────────────────
 *
 * Duas leituras precisam da mesma resposta: o GET das etapas (o contrato da
 * tela de funil) e o GET do `agent-mapping`, que é a leitura ÚNICA que a tela de
 * etapas já faz (ver `hooks/pipelines/useStages.ts`: a tela não abre uma segunda
 * lista de etapas). Duplicar a régua nas duas rotas daria duas respostas para a
 * mesma pergunta, e elas divergiriam no primeiro ajuste — a tela mostraria o
 * fluxo que a API não devolve.
 *
 * ─── O recorte é o MESMO do motor, de propósito ───────────────────────────
 *
 * `status='active'` E `active_version_id` preenchido. É exatamente o que
 * `carregaPointersDeEtapa` (`./gatilho-etapa.ts`) exige para armar: rascunho
 * nunca publicado não dispara nada, e desativado parou de disparar. Uma lista
 * mais generosa ("mostre tudo que já apontou para esta etapa") faria o gestor
 * caçar mensagem que nunca sai — o oposto do que a tela existe para responder.
 * Só LEITURA: o motor e o envio não são tocados por este arquivo.
 *
 * ─── Uma consulta, não uma por etapa ──────────────────────────────────────
 *
 * A tabela é lida UMA vez por requisição e agrupada em memória pelo
 * `stage_id` do `trigger_config`. O caminho N+1 (uma consulta por coluna do
 * quadro) custaria vinte idas ao banco num funil de vinte etapas, numa tela que
 * reabre a cada edição.
 *
 * `trigger_config` NÃO é filtrado em SQL: o `stage_id` mora dentro de um jsonb
 * cujo formato é validado por `triggerConfigSchema` (o MESMO schema do publish),
 * e filtrar por caminho no PostgREST deixaria entrar config que o motor recusa.
 * Aqui, config que não passa no schema não arma nada — igual ao motor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { triggerConfigSchema } from "./api-schemas";

/** O mínimo que a tela precisa para citar o fluxo — id para link futuro, nome para ler. */
export interface FluxoDeEtapa {
  id: string;
  name: string;
}

/** `stage_id` → fluxos armados nele, na ordem de nome. */
export type FluxosPorEtapa = ReadonlyMap<string, readonly FluxoDeEtapa[]>;

const COLUNAS_DO_POINTER = "id, name, status, active_version_id, trigger_config";

/**
 * Agrupa as linhas de `followup_flow_pointers` por etapa — PURA, para o teste
 * cobrir o recorte sem dublê de banco.
 *
 * Ordem de chegada é preservada dentro de cada etapa; a consulta ordena por
 * nome, então a lista sai estável entre renders.
 */
export function agrupaFluxosPorEtapa(linhas: ReadonlyArray<unknown>): Map<string, FluxoDeEtapa[]> {
  const porEtapa = new Map<string, FluxoDeEtapa[]>();
  for (const linha of linhas) {
    if (!linha || typeof linha !== "object") continue;
    const {
      id,
      name,
      status,
      active_version_id: versaoAtiva,
      trigger_config: gatilho,
    } = linha as Record<string, unknown>;

    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    // Rascunho e desativado ficam de fora pela mesma porta do motor.
    if (status !== "active") continue;
    if (typeof versaoAtiva !== "string" || versaoAtiva.length === 0) continue;

    const parsed = triggerConfigSchema.safeParse(gatilho);
    if (!parsed.success || parsed.data.kind !== "stage_change") continue;

    const etapaId = parsed.data.params.stage_id;
    const lista = porEtapa.get(etapaId);
    if (lista) lista.push({ id, name });
    else porEtapa.set(etapaId, [{ id, name }]);
  }
  return porEtapa;
}

/**
 * Lê os fluxos armados por etapa da organização. LANÇA quando o banco recusa —
 * quem chama decide o que fazer (as duas rotas seguem sem o campo, que é
 * diferente de dizer "não há nenhum").
 */
export async function carregaFluxosPorEtapa(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<string, FluxoDeEtapa[]>> {
  const { data, error } = await supabase
    .from("followup_flow_pointers")
    // `organization_id` explícito mesmo com RLS: é a convenção do repo para toda
    // leitura de tenant, e é a rede que sobra se a policy mudar.
    .select(COLUNAS_DO_POINTER)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return agrupaFluxosPorEtapa((data ?? []) as unknown[]);
}

/**
 * Anexa `fluxos` a cada etapa que tem fluxo armado.
 *
 * `fluxos === null` (a leitura falhou) devolve as etapas SEM o campo, e não com
 * lista vazia: a tela precisa poder distinguir "não tem nenhum" de "não
 * carregou", e só a primeira pode virar afirmação.
 */
export function anexaFluxos<T extends { id: string }>(
  etapas: readonly T[],
  fluxos: FluxosPorEtapa | null,
): Array<T & { fluxos?: FluxoDeEtapa[] }> {
  if (!fluxos) return etapas.map((e) => ({ ...e }));
  return etapas.map((e) => ({ ...e, fluxos: [...(fluxos.get(e.id) ?? [])] }));
}

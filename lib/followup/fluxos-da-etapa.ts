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
 * ─── O que a lista mostra, e o que o aviso marca ──────────────────────────
 *
 * O motor (`aplicaGatilhoDeEtapa`, `./gatilho-etapa.ts`) passa cada pointer por
 * três portas que não dependem do negócio, e esta leitura chama as MESMAS
 * funções, não uma cópia delas:
 *
 *   1. `etapaQueOPointerArma` — ativo, com versão publicada, fora do roteiro de
 *      atendimento e com `trigger_config` de etapa válido. Quem não passa NÃO
 *      aparece: rascunho, desativado ou roteiro nunca disparam por etapa.
 *   2. `noDeGatilhoDoGrafo` — a versão ativa tem nó de gatilho. Sem ele (ou com
 *      grafo que não passa no `flowGraphSchema`) o motor não arma, e a linha NÃO
 *      aparece.
 *   3. `decidirAgenteDoEnrollmentAutomatico` — fluxo que pede IA e que nenhum
 *      agente publicado com follow-up ligado arma é BARRADO pelo motor. Esse
 *      APARECE, marcado com `sem_agente: true`: escondê-lo deixaria o gestor sem
 *      saber que o fluxo existe e está parado, que é justamente o conserto que
 *      ele precisa fazer.
 *
 * O que fica de fora por natureza: o que depende do NEGÓCIO (sem contato, já
 * vivo noutro fluxo, janela de origem). A lista diz "entrar aqui arma isto",
 * não "este negócio vai receber isto".
 *
 * ─── Nenhuma consulta por etapa ───────────────────────────────────────────
 *
 * Os pointers são lidos UMA vez por requisição e agrupados em memória pelo
 * `stage_id` do `trigger_config`; as portas 2 e 3 custam uma leitura cada
 * (grafos das versões ativas, agentes publicados), nunca uma por fluxo. O caminho N+1 (uma consulta por coluna do
 * quadro) custaria vinte idas ao banco num funil de vinte etapas, numa tela que
 * reabre a cada edição.
 *
 * `trigger_config` NÃO é filtrado em SQL: o `stage_id` mora dentro de um jsonb
 * cujo formato é validado por `triggerConfigSchema` (o MESMO schema do publish),
 * e filtrar por caminho no PostgREST deixaria entrar config que o motor recusa.
 * Aqui, config que não passa no schema não arma nada — igual ao motor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createSupabaseFollowupGateDb,
  decidirAgenteDoEnrollmentAutomatico,
  noDeGatilhoDoGrafo,
  type EnabledFollowupAgent,
  type FollowupGateDb,
  type NoDeGatilho,
} from "./agent-followup-gate";
import { etapaQueOPointerArma } from "./gatilho-etapa";
import { flowGraphSchema } from "./graph-schema";

/** O mínimo que a tela precisa para citar o fluxo — id para link futuro, nome para ler. */
export interface FluxoDeEtapa {
  id: string;
  name: string;
  /** Pede IA e nenhum agente publicado com follow-up ligado o arma: o motor o barra. */
  sem_agente: boolean;
}

/** `stage_id` → fluxos armados nele, na ordem de nome. */
export type FluxosPorEtapa = ReadonlyMap<string, readonly FluxoDeEtapa[]>;

/**
 * Lê os fluxos armados por etapa da organização. Custa no máximo TRÊS leituras
 * por requisição, nenhuma por etapa: pointers, grafos das versões ativas e
 * agentes publicados. LANÇA quando o banco recusa — quem chama decide o que
 * fazer (as duas rotas seguem sem o campo, que é diferente de dizer "não há
 * nenhum").
 */
export async function carregaFluxosPorEtapa(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<string, FluxoDeEtapa[]>> {
  const { data, error } = await supabase
    .from("followup_flow_pointers")
    // `organization_id` explícito mesmo com RLS: é a convenção do repo para toda
    // leitura de tenant, e é a rede que sobra se a policy mudar.
    .select("id, name, active_version_id, trigger_config, surface")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  const armados: Array<FluxoDeEtapa & { etapaId: string; versaoId: string }> = [];
  for (const linha of (data ?? []) as Array<Record<string, unknown>>) {
    const { id, name, active_version_id: versaoId } = linha;
    if (typeof id !== "string" || typeof name !== "string" || name.length === 0) continue;
    if (typeof versaoId !== "string") continue;
    const etapaId = etapaQueOPointerArma({
      active_version_id: versaoId,
      trigger_config: linha.trigger_config,
      surface: typeof linha.surface === "string" ? linha.surface : null,
    });
    if (etapaId) armados.push({ id, name, sem_agente: false, etapaId, versaoId });
  }
  const porEtapa = new Map<string, FluxoDeEtapa[]>();
  if (armados.length === 0) return porEtapa;

  const { data: versoes, error: erroDoGrafo } = await supabase
    .from("followup_flow_versions")
    .select("id, graph")
    .eq("organization_id", organizationId)
    .in("id", [...new Set(armados.map((a) => a.versaoId))]);
  if (erroDoGrafo) throw new Error(erroDoGrafo.message);
  const noPorVersao = new Map<string, NoDeGatilho | null>();
  for (const v of (versoes ?? []) as Array<{ id: string; graph: unknown }>) {
    // O motor faz `flowGraphSchema.parse` e falha o evento num grafo inválido:
    // nos dois casos nada dispara, então aqui ele vale como "sem gatilho".
    const grafo = flowGraphSchema.safeParse(v.graph);
    noPorVersao.set(v.id, grafo.success ? noDeGatilhoDoGrafo(grafo.data) : null);
  }

  // Os agentes da org são lidos UMA vez e servidos à função do motor para cada
  // fluxo — a decisão é a dele, a ida ao banco é uma só.
  const gateReal = createSupabaseFollowupGateDb(supabase);
  let agentes: Promise<EnabledFollowupAgent[]> | null = null;
  const gateDb: FollowupGateDb = {
    loadEnabledPublishedFollowupAgents: (orgId) => (agentes ??= gateReal.loadEnabledPublishedFollowupAgents(orgId)),
  };

  for (const { etapaId, versaoId, ...fluxo } of armados) {
    const no = noPorVersao.get(versaoId);
    if (!no) continue;
    const { barrado } = await decidirAgenteDoEnrollmentAutomatico(gateDb, organizationId, fluxo.id, no.pedeAgente);
    const item = { ...fluxo, sem_agente: barrado };
    const lista = porEtapa.get(etapaId);
    if (lista) lista.push(item);
    else porEtapa.set(etapaId, [item]);
  }
  return porEtapa;
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

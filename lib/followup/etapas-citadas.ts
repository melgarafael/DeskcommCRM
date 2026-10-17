import type { SupabaseClient } from "@supabase/supabase-js";

import type { FlowNode } from "./graph-schema";
import type { NomesDeValor } from "./vocabulario";

/**
 * As etapas que um grafo cita — regras de condição e destino de `move_lead` —, lidas do banco.
 *
 * A regra de etapa guarda o `stage_id` — é o que o motor compara —, e o nome só
 * existe em `crm_stages`. Quem mostra a regra fora do construtor (o 422 do
 * publish, o "pular este passo" do dossiê) precisa do nome para não pôr um uuid
 * na tela; quem publica precisa saber se a etapa ainda existe e está ativa.
 */
export interface EtapaCitada {
  /** «Etapa · Funil»: todo funil nasce com «Novo / Em andamento / Ganho / Perdido», e o nome sozinho não identifica a etapa. */
  nome: string;
  arquivada: boolean;
  /** `crm_stages.is_lost` — a etapa fecha o negócio como perda e exige motivo. */
  isPerda: boolean;
  /** `crm_pipelines.settings` cru do funil da etapa — o vocabulário de motivos extras. */
  settingsDoFunil: unknown;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Os `stage_id` citados, sem repetição. Nome digitado à mão (fluxo antigo) não é consultável e fica de fora. */
export function idsDeEtapaCitados(nodes: readonly FlowNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    // #2065: o publish confere o destino do `move_lead` (`conferirEtapaDestino`)
    // contra estas mesmas etapas; fora daqui, o destino lê como etapa apagada.
    if (node.type === "move_lead") {
      if (UUID_RX.test(node.config.stage_id.trim())) ids.add(node.config.stage_id.trim());
      continue;
    }
    if (node.type !== "condition") continue;
    for (const check of node.config.checks) {
      const valor = String(check.value).trim();
      if (check.field === "lead_stage" && UUID_RX.test(valor)) ids.add(valor);
    }
  }
  return [...ids];
}

type Linha = { id: string; name: string; is_archived: boolean; is_lost: boolean | null; crm_pipelines: { name: string; settings: unknown } | { name: string; settings?: unknown }[] | null };

export async function carregaEtapasCitadas(
  client: SupabaseClient,
  orgId: string,
  nodes: readonly FlowNode[],
): Promise<{ ok: true; etapas: Map<string, EtapaCitada> } | { ok: false; mensagem: string }> {
  const etapas = new Map<string, EtapaCitada>();
  const ids = idsDeEtapaCitados(nodes);
  if (ids.length === 0) return { ok: true, etapas };

  const { data, error } = await client
    .from("crm_stages")
    .select("id, name, is_archived, is_lost, crm_pipelines(name, settings)")
    .eq("organization_id", orgId)
    .in("id", ids);
  // Erro NÃO vira mapa vazio: vazio leria como "nenhuma dessas etapas existe" e
  // o publish recusaria um fluxo certo dizendo que a etapa foi apagada.
  if (error) return { ok: false, mensagem: error.message };

  for (const linha of (data ?? []) as Linha[]) {
    const funil = Array.isArray(linha.crm_pipelines) ? linha.crm_pipelines[0] : linha.crm_pipelines;
    etapas.set(linha.id, {
      nome: funil?.name ? `${linha.name} · ${funil.name}` : linha.name,
      arquivada: linha.is_archived,
      isPerda: linha.is_lost === true,
      settingsDoFunil: (funil as { settings?: unknown } | undefined)?.settings ?? null,
    });
  }
  return { ok: true, etapas };
}

/**
 * O funil que as etapas citadas pelo grafo compartilham — `null` quando o grafo
 * não cita etapa nenhuma, ou cita etapas de funis DIFERENTES.
 *
 * ─── Por que isto existe ───────────────────────────────────────────────────
 *
 * `loadLeadFacts` escolhia a oportunidade do contato pelo `updated_at` mais
 * recente, SEM filtrar funil. Com mais de um funil — e quatro é o normal numa
 * operação montada: captação, vendas, onboarding, suporte — a condição
 * `lead_stage` de um fluxo de vendas era avaliada contra o card de captação,
 * porque foi ele que mudou por último.
 *
 * Medido na instalação do relato (15/10/2026): dos 143 contatos com
 * oportunidade, 2 tinham card em mais de um funil, e nos DOIS o card que o
 * motor escolheria era o de captação na etapa «Perdido (manter)» — um fluxo de
 * vendas leria "perdido" e nunca casaria a condição. A regra automática que
 * cria card em outro funil estava desligada no dia; religá-la multiplica o caso.
 *
 * `null` devolve o comportamento de antes de propósito: grafo que não fala de
 * etapa não tem funil preferido, e grafo que fala de DOIS funis não tem como
 * eleger um sem adivinhar. Nenhum fluxo publicado muda de resultado a menos
 * que estivesse lendo o card errado.
 *
 * Aceita `unknown` e DEGRADA em vez de lançar. Dois motivos, e o segundo é
 * prático: o método que alimenta isto é opcional no adaptador, e vários falsos
 * de teste são `Proxy` que devolvem função para QUALQUER chave — ali o método
 * "existe" e responde `null`. Lançar faria o motor morrer por causa da forma do
 * falso; devolver `null` é o mesmo que "não sei de que funil é", que é
 * exatamente o comportamento de antes.
 */
export function funilUnicoDasEtapas(funis: unknown): string | null {
  if (!Array.isArray(funis)) return null;
  const distintos = new Set(funis.filter((f): f is string => typeof f === "string" && f !== ""));
  return distintos.size === 1 ? [...distintos][0]! : null;
}

export function nomesDasEtapas(etapas: ReadonlyMap<string, EtapaCitada>): NomesDeValor {
  return { etapa: (id) => etapas.get(id)?.nome ?? null };
}

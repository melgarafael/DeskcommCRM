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

type Linha = { id: string; name: string; is_archived: boolean; crm_pipelines: { name: string } | { name: string }[] | null };

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
    .select("id, name, is_archived, crm_pipelines(name)")
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
    });
  }
  return { ok: true, etapas };
}

export function nomesDasEtapas(etapas: ReadonlyMap<string, EtapaCitada>): NomesDeValor {
  return { etapa: (id) => etapas.get(id)?.nome ?? null };
}

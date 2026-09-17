import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";

/**
 * O RADAR CHAMA A PESSOA PELO NOME QUE ALGUÉM ESCOLHEU.
 *
 * A issue #906 converteu oito pontos para `nomeDoContato`, e SETE deles ficaram
 * sem teste de comportamento: dava para revertê-los um a um sem nada ficar
 * vermelho. Medido no HEAD do lote: com `radar-de-risco.ts` devolvido a
 * `display_name ?? name`, a suíte inteira (`pnpm test:unit`, 920 arquivos)
 * continuou nos mesmos 3 vermelhos do baseline — ZERO novos.
 *
 * Este arquivo fecha o buraco nas DUAS leituras do radar, que são caminhos
 * independentes e quebram separado:
 *
 *  - o pool de leads frios, que resolve o nome por uma consulta em lote a
 *    `contacts` e um `Map` (`nameByContact`);
 *  - as demandas sem próximo passo, que resolvem pelo embed do PostgREST.
 *
 * Um teste só, em um dos dois, deixaria o outro revertível em silêncio — que é
 * exatamente o defeito que este arquivo existe para não repetir.
 *
 * O banco falso APLICA os filtros: um dublê que os ignorasse passaria com ou sem
 * o conserto.
 */

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: async () => new Map(),
}));

const ORG = "org-1";
const AGORA = new Date("2026-09-15T12:00:00.000Z");
const HA_MUITO = "2026-08-01T12:00:00.000Z";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => l[col] === val)), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (l[col] ?? null) === val)), chain),
      in: (col: string, vals: unknown[]) => ((linhas = linhas.filter((l) => vals.includes(l[col]))), chain),
      gt: (col: string, val: unknown) =>
        ((linhas = linhas.filter((l) => String(l[col] ?? "") > String(val))), chain),
      not: (col: string, op: string, lista: string) => {
        if (op !== "in") throw new Error(`operador não suportado no dublê: ${op}`);
        const vals = lista.replace(/^\(|\)$/g, "").split(",");
        linhas = linhas.filter((l) => !vals.includes(String(l[col])));
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

/** Um contato como o banco o entrega nas duas leituras: em lote e por embed. */
function banco(contato: { id: string; name: string | null; display_name: string | null }) {
  const perfil = { name: contato.name, display_name: contato.display_name };
  return bancoFalso({
    crm_pipelines: [{ id: "funil-ativo", organization_id: ORG, is_archived: false }],
    crm_leads: [
      {
        id: "lead-frio", organization_id: ORG, status: "open", title: "Negócio parado",
        pipeline_id: "funil-ativo", contact_id: contato.id, owner_user_id: null, owner_kind: null,
        owner_agent_id: null, stage_id: null, last_activity_at: HA_MUITO, created_at: HA_MUITO,
      },
    ],
    contacts: [{ id: contato.id, organization_id: ORG, ...perfil }],
    demandas: [
      {
        id: "demanda-parada", organization_id: ORG, lead_id: "lead-frio", contact_id: contato.id,
        aberta_em: HA_MUITO, origem: "whatsapp", fechada_em: null, proximo_passo: null,
        contacts: perfil,
      },
    ],
  });
}

const KAIO = { id: "c1", name: "Kaio Gomes", display_name: "🌸 Kaio" };

describe("o radar de risco chama o contato pelo nome escolhido", () => {
  it("no pool de leads frios, o nome da ficha vence o do perfil do WhatsApp", async () => {
    const radar = await carregaRadarDeRisco(banco(KAIO), { organizationId: ORG, now: AGORA });
    expect(radar.items.map((l) => l.contact_name)).toEqual(["Kaio Gomes"]);
  });

  it("em 'sem próximo passo', o nome da ficha vence o do perfil do WhatsApp", async () => {
    // Leitura DIFERENTE da de cima (embed do PostgREST, não `Map` em lote): as
    // duas já divergiram no produto e por isso são asseridas separado.
    const radar = await carregaRadarDeRisco(banco(KAIO), { organizationId: ORG, now: AGORA });
    expect(radar.sem_proximo_passo.map((d) => d.contact_name)).toEqual(["Kaio Gomes"]);
  });

  it("identificador técnico não vira nome de gente em nenhuma das duas leituras", async () => {
    // `Contato 543134@lid` esteve na tela do atendente da produção. O radar é
    // lido pela IA (lib/mcp/tools/retencao.ts) além da tela: um rótulo de
    // máquina aqui vira vocabulário de máquina na fala com o cliente.
    const residuo = { id: "c2", name: null, display_name: "Contato 543134@lid" };
    const radar = await carregaRadarDeRisco(banco(residuo), { organizationId: ORG, now: AGORA });
    expect(radar.items.map((l) => l.contact_name)).toEqual([null]);
    expect(radar.sem_proximo_passo.map((d) => d.contact_name)).toEqual([null]);
  });

  it("sem nome na ficha, o do perfil do WhatsApp aparece — não some", async () => {
    // A metade que a inversão de precedência NÃO pode custar: contato que entra
    // pelo WhatsApp nasce só com `display_name`, e nesta instalação eram 15 de 33.
    const soPerfil = { id: "c3", name: null, display_name: "Kaio" };
    const radar = await carregaRadarDeRisco(banco(soPerfil), { organizationId: ORG, now: AGORA });
    expect(radar.items.map((l) => l.contact_name)).toEqual(["Kaio"]);
    expect(radar.sem_proximo_passo.map((d) => d.contact_name)).toEqual(["Kaio"]);
  });
});

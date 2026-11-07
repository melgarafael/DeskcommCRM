/**
 * A RECUSA DA CONFIGURAÇÃO DIZ QUAL CAPACIDADE FALTA (#4118).
 *
 * A tela de Prospecção recebia UMA frase para DUAS causas diferentes — falta da
 * ferramenta `crm_move_lead_stage` e falta do funil da campanha em
 * `pipeline_ids` — e nenhuma das duas dizia onde marcar. Quem ligava o pacote
 * "Vender e mover o funil" na aba de conversa lia "publique o agente com a
 * ferramenta de mover negócios" e concluía que já tinha feito o que o aviso
 * pedia: o que faltava era o funil, marcado em OUTRA aba.
 *
 * O que estes casos trancam: cada causa tem a SUA frase, com o nome do lugar
 * onde se conserta, e o desfecho misto pede as duas coisas. O código cru do que
 * faltou continua indo para o log — a frase é para quem configura, o código é
 * para quem investiga.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "@/lib/logger";

import { validateConfig } from "./store";
import type { CampaignConfig } from "./schema";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CANAL = "33333333-3333-4333-8333-333333333333";
const FUNIL = "55555555-5555-4555-8555-555555555555";
const ETAPA = "66666666-6666-4666-8666-666666666666";
const ETAPA_QUALIFICADA = "77777777-7777-4777-8777-777777777777";

/**
 * A configuração mínima que o schema aceita — o caso é sobre a recusa do agente.
 *
 * Os campos com `default` no `campaignConfigSchema` (ofertas, ritmo, entrada no
 * funil e oferta de saída) aparecem EXPLÍCITOS porque `CampaignConfig` é o tipo
 * DEPOIS do parse do zod, onde o padrão já foi aplicado: omiti-los aqui é uma
 * configuração que o tipo real não aceita. O tipo no retorno é o que impede a
 * fixture de voltar a divergir em silêncio quando o schema ganhar uma chave.
 */
function configuracao(): CampaignConfig {
  return {
    agent_id: AGENTE,
    channel_session_id: CANAL,
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    qualified_stage_id: ETAPA_QUALIFICADA,
    instruction: "Apresente a oferta em duas frases.",
    qualification: "Pergunte o segmento e o tamanho da equipe.",
    ofertas: ["site"],
    daily_limit: 10,
    interval_minutes: 15,
    legal_basis_ref: "legítimo interesse — prospecção B2B",
    funnel_entry: "on_start",
    exit_offer: "first_message",
  };
}

/**
 * Só a PRIMEIRA consulta de `validateConfig` (a versão publicada do agente) tem
 * dublê: a recusa acontece antes de qualquer outra ida ao banco, e uma consulta
 * a mais neste caminho seria defeito — o teste a denuncia.
 */
function bancoDoAgente(toolIds: string[] | null, pipelineIds: string[] | null) {
  const query = vi.fn(async (sql: string) => {
    if (!sql.includes("from ai_agents")) throw new Error(`consulta inesperada: ${sql}`);
    return { rows: [{ tool_ids: toolIds, pipeline_ids: pipelineIds }] };
  });
  return { query } as never;
}

async function recusa(toolIds: string[] | null, pipelineIds: string[] | null): Promise<string> {
  vi.mocked(logger.warn).mockClear();
  try {
    await validateConfig(bancoDoAgente(toolIds, pipelineIds), ORG, configuracao());
  } catch (erro) {
    return erro instanceof Error ? erro.message : String(erro);
  }
  throw new Error("validateConfig aceitou um agente que não atende à campanha");
}

/** O que o log guardou da última recusa — a telemetria continua com o código cru. */
function logDaRecusa(): Record<string, unknown> {
  const chamadas = vi.mocked(logger.warn).mock.calls;
  const ultima = chamadas[chamadas.length - 1];
  return (ultima?.[1] ?? {}) as Record<string, unknown>;
}

describe("a Prospecção nomeia a capacidade que falta no agente publicado (#4118)", () => {
  it("sem a ferramenta de mover etapa: diz a ferramenta e a aba onde ligá-la", async () => {
    const mensagem = await recusa(["crm_get_lead"], [FUNIL]);

    expect(mensagem).toContain("Mover oportunidade de etapa");
    expect(mensagem).toContain("Conversa com o cliente");
    // A frase NÃO pode mandar marcar o funil: ele já está marcado, e era esse
    // desvio que fazia a pessoa procurar no lugar errado.
    expect(mensagem).not.toContain("Organiza o sistema");
    expect(mensagem).not.toMatch(/publique o agente com a ferramenta de mover negócios/i);
  });

  it("sem o funil da campanha: diz o funil e a aba 'Organiza o sistema'", async () => {
    const mensagem = await recusa(["crm_move_lead_stage"], []);

    expect(mensagem).toContain("funil desta campanha");
    expect(mensagem).toContain("Organiza o sistema");
    expect(mensagem).toContain("Em que negócios ele pode mexer");
    // E não pode mandar ligar a ferramenta: ela já está ligada.
    expect(mensagem).not.toContain("ligue");
  });

  it("faltando as duas: nomeia as duas, cada uma com o lugar do conserto", async () => {
    const mensagem = await recusa([], []);

    expect(mensagem).toContain("Mover oportunidade de etapa");
    expect(mensagem).toContain("Em que negócios ele pode mexer");
  });

  it("o log leva o código cru do que faltou, não só a frase da tela", async () => {
    await recusa(["crm_get_lead"], []);

    expect(logDaRecusa()).toMatchObject({
      agentId: AGENTE,
      pipelineId: FUNIL,
      codigo: "sem_ferramenta_e_funil",
    });
    // O identificador da ferramenta é o dado de investigação; a frase não o cita
    // porque quem configura conhece o rótulo, não o nome técnico.
    expect(JSON.stringify(logDaRecusa())).toContain("crm_move_lead_stage");
  });
});

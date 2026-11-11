/**
 * A RECUSA DA PROSPECÇÃO DIZ QUAL DAS DUAS FALTA — E ONDE MARCAR (issue #4118).
 *
 * ─── O defeito, medido na fonte ─────────────────────────────────────────────
 *
 * `validateConfig` (`lib/prospecting/store.ts`) cobria DUAS condições com UMA
 * frase: "Publique o agente com a ferramenta de mover negócios e acesso ao funil
 * escolhido."
 *
 *   1. `tool_ids` da versão PUBLICADA sem `crm_move_lead_stage` — na tela do
 *      agente, "Mover oportunidade de etapa";
 *   2. `pipeline_ids` da versão PUBLICADA sem o funil da campanha — na tela,
 *      "Em que negócios ele pode mexer".
 *
 * Quem ligou o pacote "Vender e mover o funil" inteiro continuou vendo a MESMA
 * frase e não tinha como saber qual das duas faltava, nem onde marcar (a
 * configuração mora em outra aba, "Organiza o sistema"), nem que o rascunho não
 * valia — a leitura é da versão publicada.
 *
 * ─── O que este arquivo vigia ───────────────────────────────────────────────
 *
 * 1. CADA CAUSA TEM FRASE PRÓPRIA, exercitada separadamente pela própria
 *    `validateConfig` (não só pela função que monta o texto): a da ferramenta
 *    nomeia "Mover oportunidade de etapa"; a do funil cita o funil PELO NOME.
 * 2. As DUAS juntas aparecem as duas — parar na primeira faria o operador
 *    publicar, tentar de novo e bater na segunda.
 * 3. O fecho fala da VERSÃO PUBLICADA — é ela que a campanha lê.
 * 4. O caminho feliz não ganha aviso nenhum, e outra organização não vê nada.
 * 5. O código de wire (`prospecting_agent_incompleto`) e `details.agent_id` vão
 *    junto: é com eles que a tela oferece o link direto do agente.
 */
import { describe, expect, it, vi } from "vitest";

import { ProspectingError } from "@/lib/prospecting/provider";
import * as store from "@/lib/prospecting/store";

const ORG = "0b110000-0000-4000-8000-000000000001";
const OUTRA_ORG = "0b110000-0000-4000-8000-000000000009";
const AGENTE = "0b110000-1111-4000-8000-000000000001";
const CANAL = "0b110000-2222-4000-8000-000000000002";
const FUNIL = "0b110000-3333-4000-8000-000000000003";
const ETAPA = "0b110000-4444-4000-8000-000000000004";
const QUALIFICADOS = "0b110000-4444-4000-8000-000000000005";
const NOME_DO_FUNIL = "Clínicas de Sorocaba";

const CONFIG = {
  agent_id: AGENTE,
  channel_session_id: CANAL,
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  qualified_stage_id: QUALIFICADOS,
  instruction: "Oferecer uma avaliação comercial.",
  qualification: "Confirmou a necessidade e quer conversar.",
  ofertas: ["site"],
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação de legítimo interesse nº 03/2026",
};

interface Cena {
  /** O que a linha da VERSÃO PUBLICADA traz. `null` = agente não encontrado. */
  agente: { tool_ids: string[] | null; pipeline_ids: string[] | null } | null;
  /** Nome do funil da campanha; `null` = funil apagado/inexistente. */
  nomeDoFunil?: string | null;
  /** Organização dona da linha — para provar que a leitura é escopada. */
  organizacao?: string;
}

/**
 * Dublê do `pg.PoolClient`: responde pelo TEXTO da consulta, como o banco faria.
 *
 * A ordem importa e é a mesma de `validateConfig`: agente publicado → funil (só
 * quando falta) → canal → roteador → etapas. Um dublê que respondesse qualquer
 * coisa esconderia justamente o defeito que este arquivo mede.
 */
function banco(cena: Cena) {
  const consultas: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    // ANTES do ramo da versão publicada: a consulta dos membros do roteador
    // passou a trazer o público do agente pelo MESMO select (#3722, fatia 2:
    // `left join ai_agent_versions`), e respondida pelo ramo de baixo ela
    // devolveria a linha do agente no lugar do membro.
    if (sql.includes("from ai_router_members")) {
      // O agente da campanha É membro do roteador: sem isto o caminho feliz para
      // numa recusa que não tem nada a ver com este teste.
      return { rows: [{ agent_id: AGENTE, intent_name: "vendas" }] };
    }
    if (sql.includes("join ai_agent_versions")) {
      if (cena.agente === null || params[0] !== (cena.organizacao ?? ORG)) return { rows: [] };
      return { rows: [{ ...cena.agente }] };
    }
    if (sql.includes("from crm_pipelines")) {
      const nome = cena.nomeDoFunil === undefined ? NOME_DO_FUNIL : cena.nomeDoFunil;
      return { rows: nome === null ? [] : [{ name: nome }] };
    }
    if (sql.includes("from channel_sessions")) {
      return { rows: [{ provider: "waha", status: "WORKING" }] };
    }
    if (sql.includes("from ai_routers")) {
      return {
        rows: [{ id: "roteador-1", name: "Roteador do comercial", config: {}, fallback_agent_id: null }],
      };
    }
    if (sql.includes("from crm_stages")) {
      return { rows: [{ id: ETAPA }, { id: QUALIFICADOS }] };
    }
    return { rows: [] };
  });
  return { db: { query } as never, consultas };
}

async function recusa(cena: Cena, org = ORG): Promise<ProspectingError> {
  const { db } = banco(cena);
  try {
    await store.validateConfig(db, org, CONFIG as never);
  } catch (erro) {
    if (erro instanceof ProspectingError) return erro;
    throw erro;
  }
  throw new Error("validateConfig aceitou um agente que não serve para a campanha");
}

describe("validateConfig — cada falta do agente tem a SUA frase", () => {
  it("sem a ferramenta: a frase nomeia 'Mover oportunidade de etapa' e não fala de funil", async () => {
    const erro = await recusa({ agente: { tool_ids: ["crm_get_lead"], pipeline_ids: [FUNIL] } });

    expect(erro.message).toContain('"Mover oportunidade de etapa"');
    // A aba onde o controle mora — a frase antiga não dizia onde era.
    expect(erro.message).toContain("Organiza o sistema");
    // A OUTRA causa não aparece: era exatamente isso que a frase única fazia.
    expect(erro.message).not.toContain("não tem acesso ao funil");
  });

  it("com a ferramenta e sem o funil: a frase cita o funil PELO NOME", async () => {
    const erro = await recusa({
      agente: { tool_ids: ["crm_move_lead_stage"], pipeline_ids: [] },
    });

    expect(erro.message).toContain(`não tem acesso ao funil "${NOME_DO_FUNIL}"`);
    expect(erro.message).toContain('"Em que negócios ele pode mexer"');
    expect(erro.message).not.toContain("Mover oportunidade de etapa");
  });

  it("as duas juntas: as DUAS causas aparecem, nessa ordem", async () => {
    const erro = await recusa({ agente: { tool_ids: [], pipeline_ids: null } });

    const ferramenta = erro.message.indexOf("Mover oportunidade de etapa");
    const funil = erro.message.indexOf("não tem acesso ao funil");
    expect(ferramenta, "a falta da ferramenta sumiu da frase").toBeGreaterThanOrEqual(0);
    expect(funil, "a falta do funil sumiu da frase").toBeGreaterThanOrEqual(0);
    expect(ferramenta).toBeLessThan(funil);
  });

  it("a frase diz que a campanha lê a VERSÃO PUBLICADA", async () => {
    const erro = await recusa({ agente: { tool_ids: [], pipeline_ids: [] } });
    expect(erro.message).toContain("versão publicada");
    expect(erro.message).toContain("depois de publicar");
  });

  it("rascunho com a capacidade ligada e versão publicada antiga: continua recusando", async () => {
    // O rascunho (que TEM a ferramenta e o funil) não é o que a campanha lê. O
    // dublê devolve a linha publicada — sem a ferramenta — e a consulta só pode
    // alcançar a versão publicada.
    const { db, consultas } = banco({ agente: { tool_ids: [], pipeline_ids: [] } });
    await expect(store.validateConfig(db, ORG, CONFIG as never)).rejects.toThrow(
      /versão publicada/,
    );
    const daVersao = consultas.find((c) => c.sql.includes("join ai_agent_versions"));
    expect(daVersao?.sql).toContain("published_version_id");
    expect(daVersao?.sql).toContain("v.status='published'");
  });

  it("agente publicado completo: nenhuma recusa, e nem consulta o nome do funil", async () => {
    const { db, consultas } = banco({
      agente: { tool_ids: ["crm_move_lead_stage"], pipeline_ids: [FUNIL] },
    });

    const config = await store.validateConfig(db, ORG, CONFIG as never);

    expect(config.pipeline_id).toBe(FUNIL);
    expect(consultas.some((c) => c.sql.includes("from crm_pipelines"))).toBe(false);
  });

  it("outra organização não herda a linha: o agente não é encontrado", async () => {
    const erro = await recusa(
      { agente: { tool_ids: ["crm_move_lead_stage"], pipeline_ids: [FUNIL] }, organizacao: OUTRA_ORG },
      ORG,
    );

    expect(erro.message).toBe("Escolha um agente publicado e em operação automática.");
  });

  it("leva o código de wire e o id do agente para a tela montar o link", async () => {
    const erro = await recusa({ agente: { tool_ids: [], pipeline_ids: [] } });

    expect(erro.codigo).toBe("prospecting_agent_incompleto");
    expect(erro.status).toBe(422);
    expect(erro.escopo).toBe("campanha");
    expect(erro.detalhes).toMatchObject({
      agent_id: AGENTE,
      pipeline_id: FUNIL,
      faltando: ["ferramenta", "funil"],
    });
  });

  it("funil sem nome no banco: a frase não inventa nome nem mostra uuid", async () => {
    const erro = await recusa({
      agente: { tool_ids: ["crm_move_lead_stage"], pipeline_ids: [] },
      nomeDoFunil: null,
    });

    expect(erro.message).toContain("não tem acesso ao funil desta campanha");
    expect(erro.message).not.toContain(FUNIL);
  });
});

describe("faltasDoAgentePublicado — a regra, sem banco no meio", () => {
  const faltas = (
    agente: { tool_ids: string[] | null; pipeline_ids: string[] | null },
    nome: string | null = NOME_DO_FUNIL,
  ) => store.faltasDoAgentePublicado(agente, { id: FUNIL, name: nome });

  it("agente completo não gera falta nenhuma", () => {
    expect(faltas({ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [FUNIL] })).toEqual([]);
  });

  it("cada falta tem a sua causa — a tela do servidor usa isso em `details.faltando`", () => {
    expect(faltas({ tool_ids: [], pipeline_ids: [] }).map((f) => f.causa)).toEqual([
      "ferramenta",
      "funil",
    ]);
  });

  it("o funil marcado por id, não por nome: o mesmo nome em outro funil não vale", () => {
    const outras = store.faltasDoAgentePublicado(
      { tool_ids: ["crm_move_lead_stage"], pipeline_ids: ["outro-funil-qualquer"] },
      { id: FUNIL, name: NOME_DO_FUNIL },
    );
    expect(outras.map((f) => f.causa)).toEqual(["funil"]);
  });

  it("a mensagem é as frases + o fecho da versão publicada, uma vez só", () => {
    const lista = faltas({ tool_ids: [], pipeline_ids: [] });
    const mensagem = store.mensagemDoAgenteIncompleto(lista);
    expect(mensagem).toBe(`${lista.map((f) => f.frase).join(" ")} ${store.FECHO_DA_VERSAO_PUBLICADA}`);
    // O fecho não se repete por causa — repetir era o jeito de a frase voltar a
    // ficar ilegível quando as duas faltam.
    expect(mensagem.split("versão publicada")).toHaveLength(2);
  });
});

/**
 * ARQUIVAR UMA CAMPANHA DE PROSPECÇÃO — issue #4359, item 1.
 *
 * ## O pedido, e o que ele NÃO autoriza
 *
 * Campanha que falhou ou veio zerada fica para sempre em "Suas campanhas". A pessoa
 * quer escondê-la. O gesto é ARQUIVAR, não excluir: nenhum negócio, conversa,
 * candidato ou custo pode ser apagado — é o que o cliente já construiu naquele funil.
 *
 * Esses dois lados puxam em direções opostas, e é por isso que este arquivo existe:
 * a metade que "some da lista" é fácil; a metade que garante que NADA foi apagado e
 * que uma campanha RODANDO para de enviar é a que um dia vai faltar se ninguém
 * escrever. Campanha invisível disparando mensagem é o pior desfecho possível.
 *
 * ## O que este arquivo prova, e onde cada prova mora
 *
 * Aqui, sem banco: o formato aceito pelo schema, a lista que a tela mostra, o TEXTO
 * dos `update` (que só tocam `prospecting_campaigns` e só mexem em `config`/`status`)
 * e a régua do envio lida da fonte do worker. O efeito real sobre linhas — inclusive
 * que outra organização não alcança a campanha — é do invariante de banco.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: vi.fn(),
  beginServiceAtOrigin: vi.fn(),
}));
// A ativação confere que o agente atende o canal escolhido (#4430, `activateCampaign`).
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: async () => null }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfig: async () => ({ agentId: CONFIG.agent_id }),
}));

import { arquivadaEm, campanhasVisiveis } from "@/lib/prospecting/arquivamento";
import { campaignConfigSchema, prospectingInputSchema } from "@/lib/prospecting/schema";
import { ProspectingError } from "@/lib/prospecting/provider";
import { activateCampaign, arquivarCampanha, desarquivarCampanha } from "@/lib/prospecting/store";

const ORG = "0a110000-0000-4000-8000-000000000001";
const CAMPANHA = "0a110000-1111-4000-8000-000000000001";
const OUTRA = "0a110000-2222-4000-8000-000000000002";
const ISO = "2026-11-11T12:00:00.000Z";

const CONFIG = {
  agent_id: "0a110000-3333-4000-8000-000000000001",
  channel_session_id: "0a110000-4444-4000-8000-000000000001",
  pipeline_id: "0a110000-5555-4000-8000-000000000001",
  stage_id: "0a110000-6666-4000-8000-000000000001",
  qualified_stage_id: "0a110000-7777-4000-8000-000000000001",
  instruction: "Apresente a clínica com educação.",
  qualification: "Tem interesse em agendar avaliação.",
  legal_basis_ref: "legítimo interesse, registro 1",
  daily_limit: 10,
  interval_minutes: 15,
};

type Linha = { id: string; status: string; config: Record<string, unknown> | null };
type Chamada = { text: string; params: unknown[] };

/**
 * Banco de mentira do lock: guarda a LINHA de verdade e aplica os dois `update` pelo
 * que o SQL diz — é o que permite perguntar, no fim, "a campanha continua rodando?".
 * Registra cada chamada para o controle de "nada foi apagado".
 */
function banco(linhas: Linha[]) {
  const estado = new Map(linhas.map((l) => [l.id, { ...l, config: l.config ? { ...l.config } : null }]));
  const chamadas: Chamada[] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    chamadas.push({ text, params });
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (text.startsWith("select pg_advisory_unlock")) return { rows: [], rowCount: 0 };
    const linha = estado.get(params[1] as string);
    if (text.startsWith("update prospecting_campaigns")) {
      if (!linha) return { rows: [], rowCount: 0 };
      const marcador = typeof linha.config?.arquivada_em === "string" ? linha.config.arquivada_em : "";
      if (text.includes("- 'arquivada_em'")) {
        if (!marcador) return { rows: [], rowCount: 0 };
        const resto = { ...(linha.config ?? {}) };
        delete resto.arquivada_em;
        linha.config = resto;
        return { rows: [{ id: linha.id, status: linha.status }], rowCount: 1 };
      }
      if (text.includes("jsonb_build_object('arquivada_em'")) {
        if (marcador) return { rows: [], rowCount: 0 };
        linha.config = { ...(linha.config ?? {}), arquivada_em: params[2] as string };
        // A regra dura: campanha rodando PARA de enviar.
        if (text.includes("status='running'")) linha.status = "paused";
        return { rows: [{ id: linha.id, status: linha.status }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("from prospecting_campaigns")) {
      return {
        rows: linha
          ? [{ id: linha.id, status: linha.status, arquivada_em: linha.config?.arquivada_em ?? null }]
          : [],
        rowCount: linha ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) };
  return { pool: pool as never, estado, chamadas };
}

describe("as ações arquivar/desarquivar no schema da API", () => {
  it("aceita arquivar e desarquivar uma campanha pelo id", () => {
    for (const action of ["arquivar", "desarquivar"])
      expect(prospectingInputSchema.safeParse({ action, id: CAMPANHA }).success, action).toBe(true);
  });

  it("recusa campo a mais: organização vem da sessão, não do corpo", () => {
    for (const action of ["arquivar", "desarquivar"])
      expect(
        prospectingInputSchema.safeParse({ action, id: CAMPANHA, organization_id: ORG }).success,
      ).toBe(false);
  });

  it("o marcador no config não torna a configuração inválida (o envio e a prévia fazem parse estrito)", () => {
    expect(campaignConfigSchema.safeParse(CONFIG).success).toBe(true);
    const arquivada = campaignConfigSchema.safeParse({ ...CONFIG, arquivada_em: ISO });
    expect(arquivada.success).toBe(true);
    expect(arquivada.success && arquivada.data.arquivada_em).toBe(ISO);
  });
});

describe("a lista que a tela mostra", () => {
  const campanhas = [
    { name: "falhou", config: { ...CONFIG, arquivada_em: ISO } },
    { name: "ativa", config: CONFIG },
    { name: "nunca iniciada", config: null },
  ];

  it("arquivada sai da lista principal e NÃO some: aparece no filtro das arquivadas", () => {
    expect(campanhasVisiveis(campanhas, false).map((c) => c.name)).toEqual(["ativa", "nunca iniciada"]);
    expect(campanhasVisiveis(campanhas, true).map((c) => c.name)).toEqual(["falhou"]);
  });

  it("controle: campanha sem configuração (busca que nunca iniciou) não é arquivada", () => {
    const semConfig = campanhas.filter((c) => c.config === null);
    expect(semConfig.every((c) => arquivadaEm(c.config) === null)).toBe(true);
    expect(campanhasVisiveis(semConfig, false)).toHaveLength(1);
  });
});

describe("arquivarCampanha: esconde sem apagar e para o envio", () => {
  it("campanha RODANDO ao ser arquivada vira pausada (o worker só envia `running`)", async () => {
    const { pool, estado } = banco([{ id: CAMPANHA, status: "running", config: { ...CONFIG } }]);
    const r = await arquivarCampanha(pool, ORG, CAMPANHA);
    expect(r).toEqual({ arquivada: true, ja_estava: false, status: "paused", arquivada_em: r.arquivada_em });
    expect(typeof r.arquivada_em).toBe("string");
    expect(estado.get(CAMPANHA)?.status).toBe("paused");
    expect(arquivadaEm(estado.get(CAMPANHA)?.config)).toBe(r.arquivada_em);
    // A régua do envio, lida da FONTE: o tick relê a campanha exigindo `running`
    // antes de mandar (`lib/prospecting/worker.ts`, o comentário "RELÊ A CAMPANHA
    // ANTES DE ENVIAR"). Se essa releitura sumir, o arquivamento para de bastar.
    const fonte = readFileSync(join(__dirname, "..", "..", "lib", "prospecting", "worker.ts"), "utf8");
    expect(fonte).toContain("where organization_id=$1 and status='running' and id=$2");
    expect(estado.get(CAMPANHA)?.status).not.toBe("running");
  });

  it("campanha pausada/falhada continua como estava — arquivar não inventa estado", async () => {
    const { pool, estado } = banco([{ id: CAMPANHA, status: "paused", config: { ...CONFIG } }]);
    const r = await arquivarCampanha(pool, ORG, CAMPANHA);
    expect(r.status).toBe("paused");
    expect(estado.get(CAMPANHA)?.status).toBe("paused");
  });

  it("é idempotente: arquivar de novo não reescreve o marcador nem o estado", async () => {
    const { pool, estado, chamadas } = banco([{ id: CAMPANHA, status: "running", config: { ...CONFIG } }]);
    const antes = chamadas.length;
    const primeiro = await arquivarCampanha(pool, ORG, CAMPANHA);
    const antesDoEstado = { ...estado.get(CAMPANHA)! };
    const segundo = await arquivarCampanha(pool, ORG, CAMPANHA);
    expect(segundo.arquivada).toBe(true);
    expect(segundo.ja_estava).toBe(true);
    expect(segundo.arquivada_em).toBe(primeiro.arquivada_em);
    // A segunda chamada não muda NADA: a linha fica igual (o `update` é guardado
    // pelo marcador, então casa zero linhas).
    expect(estado.get(CAMPANHA)).toEqual(antesDoEstado);
    expect(
      chamadas.slice(antes).every((c) => !c.text.startsWith("update") || c.text.includes("coalesce(config->>'arquivada_em','') = ''")),
      "todo update é guardado pelo marcador",
    ).toBe(true);
  });

  it("campanha de outra organização (ou inexistente) é 404", async () => {
    const { pool } = banco([{ id: OUTRA, status: "running", config: { ...CONFIG } }]);
    await expect(arquivarCampanha(pool, ORG, CAMPANHA)).rejects.toBeInstanceOf(ProspectingError);
  });

  it("CONTROLE: o arquivamento não apaga nem toca negócio, conversa, candidato ou saída", async () => {
    const { pool, chamadas } = banco([{ id: CAMPANHA, status: "running", config: { ...CONFIG } }]);
    await arquivarCampanha(pool, ORG, CAMPANHA);
    const escritas = chamadas.filter((c) => /^(update|delete|insert|truncate)/i.test(c.text));
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.text).toMatch(/^update prospecting_campaigns/);
    for (const chamada of chamadas) {
      expect(chamada.text).not.toMatch(/\bdelete\b|\btruncate\b/i);
      expect(chamada.text).not.toContain("prospecting_candidates");
      expect(chamada.text).not.toContain("crm_leads");
      expect(chamada.text).not.toContain("conversations");
      expect(chamada.text).not.toContain("exit_offered_at");
      // A organização vem da sessão em TODA leitura/escrita da campanha.
      if (chamada.text.includes("prospecting_campaigns")) expect(chamada.params[0]).toBe(ORG);
    }
  });
});

describe("desarquivarCampanha: volta para a lista, sem retomar sozinha", () => {
  it("tira o marcador e devolve a campanha PAUSADA (quem retoma é uma pessoa)", async () => {
    const { pool, estado } = banco([
      { id: CAMPANHA, status: "paused", config: { ...CONFIG, arquivada_em: ISO } },
    ]);
    const r = await desarquivarCampanha(pool, ORG, CAMPANHA);
    expect(r).toEqual({ arquivada: false, ja_estava: false, status: "paused", arquivada_em: null });
    expect(arquivadaEm(estado.get(CAMPANHA)?.config)).toBeNull();
    // O resto da configuração fica inteiro: desarquivar não é reconfigurar.
    expect(estado.get(CAMPANHA)?.config).toMatchObject({
      agent_id: CONFIG.agent_id,
      daily_limit: CONFIG.daily_limit,
    });
  });

  it("é idempotente: desarquivar o que já está na lista não escreve", async () => {
    const { pool, estado, chamadas } = banco([{ id: CAMPANHA, status: "paused", config: { ...CONFIG } }]);
    const antesDoEstado = { ...estado.get(CAMPANHA)! };
    const r = await desarquivarCampanha(pool, ORG, CAMPANHA);
    expect(r.ja_estava).toBe(true);
    expect(r.arquivada).toBe(false);
    expect(estado.get(CAMPANHA)).toEqual(antesDoEstado);
    expect(
      chamadas.every((c) => !c.text.startsWith("update") || c.text.includes("<> ''")),
      "todo update é guardado pelo marcador",
    ).toBe(true);
  });

  it("CONTROLE: desarquivar também não apaga nada", async () => {
    const { pool, chamadas } = banco([
      { id: CAMPANHA, status: "paused", config: { ...CONFIG, arquivada_em: ISO } },
    ]);
    await desarquivarCampanha(pool, ORG, CAMPANHA);
    for (const chamada of chamadas) expect(chamada.text).not.toMatch(/\bdelete\b|\btruncate\b/i);
  });
});

describe("ida e volta: arquivar, sair da lista, desarquivar, voltar", () => {
  it("a campanha falhada some da lista principal e volta ao desarquivar, sem perder a linha", async () => {
    const linha: Linha = { id: CAMPANHA, status: "paused", config: { ...CONFIG } };
    const { pool, estado } = banco([linha]);
    await arquivarCampanha(pool, ORG, CAMPANHA);
    expect(campanhasVisiveis([estado.get(CAMPANHA)!], false)).toHaveLength(0);
    expect(campanhasVisiveis([estado.get(CAMPANHA)!], true)).toHaveLength(1);
    await desarquivarCampanha(pool, ORG, CAMPANHA);
    expect(campanhasVisiveis([estado.get(CAMPANHA)!], false)).toHaveLength(1);
  });
});

describe("activateCampaign: rascunho arquivado não inicia (#4430)", () => {
  // O que a tela manda no Iniciar: a configuração da campanha, que carrega o marcador.
  const comMarcador = campaignConfigSchema.parse({ ...CONFIG, arquivada_em: ISO });
  /** O mínimo para `validateConfig` passar e a ativação chegar à campanha. */
  function bancoDaAtivacao(configDaCampanha: Record<string, unknown> | null) {
    const escritas: Chamada[] = [];
    const query = vi.fn(async (text: string, params: unknown[] = []) => {
      if (/^(update|insert|delete)/i.test(text)) escritas.push({ text, params });
      const rows = (() => {
        if (text.includes("pg_try_advisory_lock")) return [{ locked: true }];
        if (text.includes("from ai_agents a join ai_agent_versions"))
          return [{ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [CONFIG.pipeline_id] }];
        if (text.includes("from channel_sessions")) return [{ provider: "waha", status: "WORKING" }];
        if (text.includes("from crm_stages"))
          return [{ id: CONFIG.stage_id }, { id: CONFIG.qualified_stage_id }];
        if (text.startsWith("select * from prospecting_campaigns"))
          return [
            { id: CAMPANHA, name: "C", status: "draft", search_status: "succeeded", config: configDaCampanha },
          ];
        return [];
      })();
      return { rows, rowCount: rows.length };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }) };
    return { pool: pool as never, escritas };
  }

  it("recusa com 409 e não escreve nada: iniciado, ele sairia enviando fora da lista", async () => {
    const { pool, escritas } = bancoDaAtivacao({ arquivada_em: ISO });
    const erro = await activateCampaign(pool, {} as never, ORG, CAMPANHA, comMarcador).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).status).toBe(409);
    expect(escritas).toEqual([]);
  });

  it("aba antiga que ainda manda o marcador não arquiva a campanha que está iniciando", async () => {
    const { pool, escritas } = bancoDaAtivacao(null);
    await activateCampaign(pool, {} as never, ORG, CAMPANHA, comMarcador);
    const daCampanha = escritas.filter((e) => e.text.startsWith("update prospecting_campaigns"));
    expect(daCampanha.some((e) => e.text.includes("status='running'"))).toBe(true);
    for (const e of daCampanha) expect(arquivadaEm(e.params[2])).toBeNull();
  });
});

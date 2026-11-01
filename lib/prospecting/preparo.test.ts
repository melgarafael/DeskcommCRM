/**
 * O preparo automático (B2): verificação do site + prévia, em segundo plano,
 * FORA do bloqueio da organização, com teto por rodada e bloqueio próprio.
 *
 * Casos da ordem: B (quem entra), C (teto e prazo), D (bloqueio próprio),
 * E (falha da IA), F (auditoria).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enriquecer: vi.fn(),
  gerar: vi.fn(),
  audit: vi.fn(),
  withLock: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/prospecting/site-enrich", () => ({ enriquecerSitesPendentes: mocks.enriquecer }));
vi.mock("@/lib/prospecting/previa-gerar", () => ({ gerarPreviaDoCandidato: mocks.gerar }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: mocks.error, debug: vi.fn() },
}));
// O preparo NUNCA pega o bloqueio da organização: se importar isto, o caso D vê.
vi.mock("@/lib/prospecting/store", () => ({ withProspectingLock: mocks.withLock }));

import { prepararCandidatos, TETO_PREVIAS_POR_RODADA } from "./preparo";

const ORG = "99999999-9999-4999-8999-999999999999";
const AGENTE = "55555555-5555-4555-8555-555555555555";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "11111111-1111-4111-8111-111111111112";
/** A busca nova grava as duas chaves (o formulário e o `searchSchema` as preenchem). */
const BUSCA_NOVA = { niche: "clínica", avaliar_site: true, gerar_previa: true };
const SEGREDO = "TEXTO-SECRETO-DA-PREVIA";
const CONFIG = {
  agent_id: AGENTE,
  channel_session_id: "66666666-6666-4666-8666-666666666666",
  pipeline_id: "77777777-7777-4777-8777-777777777777",
  stage_id: "88888888-8888-4888-8888-888888888888",
  qualified_stage_id: "99999999-9999-4999-8999-999999999998",
  instruction: "Apresente a clínica com educação.",
  qualification: "Tem interesse em agendar avaliação.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "legítimo interesse, registro 1",
};
const SITE_DEFINITIVO = {
  ver: 1,
  classe: "site-ok",
  problemas: [],
  checklist: { tem: [], falta: [] },
  final_url: "https://x.test/",
  http_status: 200,
  tempo_ms: 10,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};

function cand(id: string, over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    id,
    status: "queued",
    selected: true,
    contact_id: null,
    data: {
      name: `Empresa ${id}`,
      category: "Serviços",
      address: "Rua X",
      website: `https://${id}.test/`,
      rating: 4.5,
      reviews: 10,
      emails: [],
      socials: [],
      site: SITE_DEFINITIVO,
      ...data,
    },
    ...over,
  };
}

type Cenario = {
  trava?: boolean;
  campanhas?: Array<{ id: string; config: unknown; search?: unknown }>;
  candidatos?: Record<string, ReturnType<typeof cand>[]>;
  falhaNaCampanhas?: Error;
  falhaNoUnlock?: Error;
  /** O agente padrão da organização (campanha sem agente usa a config dele). */
  padrao?: unknown;
};

function montar(c: Cenario = {}) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: c.trava ?? true }] };
      if (sql.includes("pg_advisory_unlock")) {
        if (c.falhaNoUnlock) throw c.falhaNoUnlock;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (sql.includes("join ai_agents")) return { rows: c.padrao ? [{ config: c.padrao }] : [] };
      if (sql.includes("from prospecting_campaigns")) {
        if (c.falhaNaCampanhas) throw c.falhaNaCampanhas;
        return {
          rows: (c.campanhas ?? [{ id: C1, config: CONFIG, search: BUSCA_NOVA }]).map(
            (x) => ({ search: BUSCA_NOVA, ...x }),
          ),
        };
      }
      if (sql.includes("select settings from organizations")) return { rows: [{ settings: {} }] };
      if (sql.startsWith("select") && sql.includes("from prospecting_candidates"))
        return { rows: (c.candidatos ?? {})[String(params[1])] ?? [] };
      if (sql.startsWith("update prospecting_candidates")) return { rowCount: 1, rows: [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [] })) };
  return { pool, client, sqls };
}

const gravacoes = (sqls: Array<{ sql: string; params: unknown[] }>) =>
  sqls.filter((s) => s.sql.startsWith("update prospecting_candidates"));
const idsGerados = () => mocks.gerar.mock.calls.map((c) => (c[2] as { id: string }).id);
const rodar = (pool: unknown, deadline = Date.now() + 60_000) =>
  prepararCandidatos(pool as never, {} as never, ORG, "req-1", deadline);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enriquecer.mockResolvedValue({ enriquecidos: 0, classes: {} });
  mocks.gerar.mockImplementation(async (_pool: unknown, _org: string, linha: { id: string }) => ({
    ok: true,
    texto: SEGREDO,
    previa: {
      texto: SEGREDO,
      baseada_em: `site-ok@${SITE_DEFINITIVO.verificado_em}`,
      gerada_em: "2026-10-16T10:00:00.000Z",
      agente_id: AGENTE,
    },
    estrategia: {},
    score: { valor: 50, motivo: "x" },
    _id: linha.id,
  }));
});

describe("B) quem recebe prévia", () => {
  it("só candidato com veredito definitivo, sem prévia, marcado, na fila, de campanha COM agente", async () => {
    const previaValida = {
      texto: "já tem",
      baseada_em: `site-ok@${SITE_DEFINITIVO.verificado_em}`,
      gerada_em: "2026-10-15T00:00:00.000Z",
      agente_id: AGENTE,
    };
    const { pool, sqls } = montar({
      campanhas: [
        { id: C1, config: CONFIG, search: BUSCA_NOVA },
        // Rascunho ainda sem agente: só verifica o site.
        { id: C2, config: { instruction: "Oferecer uma avaliação comercial." } },
      ],
      candidatos: {
        [C1]: [
          cand("elegivel"),
          cand("provisorio", {}, { site: { ...SITE_DEFINITIVO, provisorio: true, tentativas: 1 } }),
          cand("desmarcado", { selected: false }),
          cand("ja-tem-previa", {}, { previa: previaValida }),
          cand("ja-abordado", { status: "sent" }),
          cand("sem-veredito", {}, { site: null }),
          cand("sem-site-na-web", {}, { website: null, site: null }),
        ],
        [C2]: [cand("campanha-sem-agente")],
      },
    });
    const r = await rodar(pool);
    expect(idsGerados().sort()).toEqual(["elegivel", "sem-site-na-web"]);
    expect(r).toMatchObject({ previas: 2, pulou: false });
    expect(gravacoes(sqls)).toHaveLength(2);
    // A campanha sem agente AINDA verifica o site (a rede é de todas), mas não lê candidato para prévia.
    const campanhasVerificadas = mocks.enriquecer.mock.calls.map((c) => c[4]);
    expect(campanhasVerificadas).toEqual([C1, C2]);
    expect(
      sqls.some((s) => s.sql.includes("from prospecting_candidates") && s.params[1] === C2),
    ).toBe(false);
  });

  it("campanha SEM agente usa o agente PADRÃO da organização (a prévia sai junto com a avaliação)", async () => {
    const { pool, sqls } = montar({
      padrao: CONFIG,
      campanhas: [
        { id: C2, config: { instruction: "busca nova, sem agente" } },
        { id: C1, config: null },
      ],
      candidatos: { [C2]: [cand("a")], [C1]: [cand("b")] },
    });
    await rodar(pool);
    expect(idsGerados().sort()).toEqual(["a", "b"]);
    // A geração recebe o AGENTE do padrão, com instrução NEUTRA — nunca o roteiro da campanha
    // antiga (segmento dela) nem a config parcial da campanha nova.
    for (const chamada of mocks.gerar.mock.calls) {
      const cfg = (chamada[2] as { config: Record<string, unknown> }).config;
      expect(cfg.agent_id).toBe(CONFIG.agent_id);
    }
    // O padrão é lido UMA vez por rodada, não por campanha.
    expect(sqls.filter((s) => s.sql.includes("join ai_agents"))).toHaveLength(1);
    // O filtro de organização está na consulta do padrão.
    expect(sqls.find((s) => s.sql.includes("join ai_agents"))!.sql).toContain("pc.organization_id = $1");
  });

  it("interruptor 'Gerar a prévia' desligado: sem IA, mas AINDA verifica o site", async () => {
    const { pool } = montar({
      padrao: CONFIG,
      campanhas: [{ id: C1, config: CONFIG, search: { niche: "clínica", avaliar_site: true, gerar_previa: false } }],
      candidatos: { [C1]: [cand("a")] },
    });
    await rodar(pool);
    expect(mocks.gerar).not.toHaveBeenCalled();
    expect(mocks.enriquecer).toHaveBeenCalledTimes(1);
  });

  it("interruptor 'Avaliar o site' desligado: nenhuma rede e, sem avaliação, nenhuma prévia", async () => {
    const { pool } = montar({
      padrao: CONFIG,
      campanhas: [{ id: C1, config: CONFIG, search: { niche: "clínica", avaliar_site: false, gerar_previa: true } }],
      candidatos: { [C1]: [cand("a")] },
    });
    await rodar(pool);
    expect(mocks.enriquecer).not.toHaveBeenCalled();
    expect(mocks.gerar).not.toHaveBeenCalled();
  });

  it("campanha antiga (sem as chaves): verifica o site, mas NÃO gera prévia (doc 163, B)", async () => {
    const { pool } = montar({
      padrao: CONFIG,
      campanhas: [{ id: C1, config: CONFIG, search: { niche: "clínica" } }],
      candidatos: { [C1]: [cand("a")] },
    });
    await rodar(pool);
    expect(mocks.enriquecer).toHaveBeenCalledTimes(1);
    expect(mocks.gerar).not.toHaveBeenCalled();
  });

  it("busca nova (as duas chaves gravadas) gera a prévia", async () => {
    const { pool } = montar({
      campanhas: [{ id: C1, config: CONFIG, search: BUSCA_NOVA }],
      candidatos: { [C1]: [cand("a")] },
    });
    await rodar(pool);
    expect(mocks.enriquecer).toHaveBeenCalledTimes(1);
    expect(idsGerados()).toEqual(["a"]);
  });

  it("sem agente na campanha e sem padrão: nada é gerado", async () => {
    const { pool } = montar({
      campanhas: [{ id: C2, config: { instruction: "busca nova, sem agente" } }],
      candidatos: { [C2]: [cand("a")] },
    });
    const r = await rodar(pool);
    expect(idsGerados()).toEqual([]);
    expect(r.previas).toBe(0);
  });

  it("lê as campanhas da MAIS NOVA para a mais antiga (a busca nova não espera atrás das velhas)", async () => {
    const { pool, sqls } = montar({ candidatos: { [C1]: [] } });
    await rodar(pool);
    const sql = sqls.find((s) => s.sql.includes("from prospecting_campaigns") && !s.sql.includes("join ai_agents"))!.sql;
    expect(sql).toContain("order by created_at desc");
  });

  it("a seleção de candidatos filtra no SQL o que o TS também recusa (não trava a fila)", async () => {
    const { pool, sqls } = montar({ candidatos: { [C1]: [] } });
    await rodar(pool);
    const sql = sqls.find((s) => s.sql.startsWith("select") && s.sql.includes("from prospecting_candidates"))!
      .sql;
    expect(sql).toContain("organization_id=$1");
    expect(sql).toContain("selected is not false");
    expect(sql).toContain("'new','queued'");
    expect(sql).toContain("data->'previa' is null");
    expect(sql).toContain("provisorio");
    expect(sql).toMatch(/limit \$3/);
  });

  it("o SQL não recusa classe que o TS aceita: `nao-medido` definitivo ganha prévia (#3742)", async () => {
    // Se o SQL excluísse uma classe que `previaPorGerar` aceita, a tela mostraria
    // "Gerando prévia…" para sempre e a recarga de 10 s nunca pararia.
    const { pool, sqls } = montar({ candidatos: { [C1]: [] } });
    await rodar(pool);
    const sql = sqls.find((s) => s.sql.startsWith("select") && s.sql.includes("from prospecting_candidates"))!
      .sql;
    expect(sql).not.toContain("classe");
  });

  it("grava a prévia pelo merge de uma chave, com organização e campanha", async () => {
    const { pool, sqls } = montar({ candidatos: { [C1]: [cand("a")] } });
    await rodar(pool);
    const [g] = gravacoes(sqls);
    expect(g!.params.slice(0, 3)).toEqual([ORG, C1, "a"]);
    expect(g!.sql).toContain("jsonb_build_object('previa'");
  });

  it("devolve as contagens de sites e de prévias", async () => {
    mocks.enriquecer.mockResolvedValue({ enriquecidos: 4, classes: { "site-ok": 4 } });
    const { pool } = montar({ candidatos: { [C1]: [cand("a"), cand("b")] } });
    expect(await rodar(pool)).toEqual({ sites: 4, previas: 2, pulou: false });
  });
});

describe("C) teto e prazo", () => {
  it("com 20 elegíveis gera no máximo TETO_PREVIAS_POR_RODADA (8) por rodada", async () => {
    expect(TETO_PREVIAS_POR_RODADA).toBe(8);
    const vinte = Array.from({ length: 20 }, (_, i) => cand(`c${i}`));
    const { pool, sqls } = montar({ candidatos: { [C1]: vinte } });
    const r = await rodar(pool);
    expect(mocks.gerar).toHaveBeenCalledTimes(8);
    expect(r.previas).toBe(8);
    expect(gravacoes(sqls)).toHaveLength(8);
  });

  it("o teto é da organização na rodada, não de cada campanha", async () => {
    const cinco = (p: string) => Array.from({ length: 5 }, (_, i) => cand(`${p}${i}`));
    const { pool } = montar({
      campanhas: [
        { id: C1, config: CONFIG },
        { id: C2, config: CONFIG },
      ],
      candidatos: { [C1]: cinco("a"), [C2]: cinco("b") },
    });
    await rodar(pool);
    expect(mocks.gerar).toHaveBeenCalledTimes(8);
  });

  it("no máximo 3 em paralelo", async () => {
    let voando = 0;
    let pico = 0;
    mocks.gerar.mockImplementation(async () => {
      voando++;
      pico = Math.max(pico, voando);
      await new Promise((r) => setTimeout(r, 15));
      voando--;
      return {
        ok: true,
        texto: "x",
        previa: { texto: "x", baseada_em: "k", gerada_em: "t", agente_id: AGENTE },
        estrategia: {},
        score: { valor: 1, motivo: "m" },
      };
    });
    const { pool } = montar({
      candidatos: { [C1]: Array.from({ length: 8 }, (_, i) => cand(`p${i}`)) },
    });
    await rodar(pool);
    expect(pico).toBe(3);
    expect(mocks.gerar).toHaveBeenCalledTimes(8);
  });

  it("prazo vencido: não verifica nem gera", async () => {
    const { pool } = montar({ candidatos: { [C1]: [cand("a")] } });
    const r = await rodar(pool, Date.now() - 1);
    expect(mocks.gerar).not.toHaveBeenCalled();
    expect(r.previas).toBe(0);
  });

  it("o prazo estoura no meio: para depois do lote em curso (3), não gera os 8", async () => {
    mocks.gerar.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return {
        ok: true,
        texto: "x",
        previa: { texto: "x", baseada_em: "k", gerada_em: "t", agente_id: AGENTE },
        estrategia: {},
        score: { valor: 1, motivo: "m" },
      };
    });
    const { pool } = montar({
      candidatos: { [C1]: Array.from({ length: 10 }, (_, i) => cand(`q${i}`)) },
    });
    await rodar(pool, Date.now() + 60);
    expect(mocks.gerar).toHaveBeenCalledTimes(3);
  });

  it("a verificação do site respeita o teto de 30 por rodada somando as campanhas", async () => {
    mocks.enriquecer.mockResolvedValueOnce({ enriquecidos: 25, classes: {} });
    mocks.enriquecer.mockResolvedValueOnce({ enriquecidos: 5, classes: {} });
    const { pool } = montar({
      campanhas: [
        { id: C1, config: CONFIG },
        { id: C2, config: CONFIG },
        { id: "11111111-1111-4111-8111-111111111113", config: CONFIG },
      ],
    });
    await rodar(pool);
    // 2ª campanha só recebe o que sobrou (5); a 3ª nem é chamada (30 batidos).
    expect(mocks.enriquecer).toHaveBeenCalledTimes(2);
    expect(mocks.enriquecer.mock.calls[0]![5]).toBe(30);
    expect(mocks.enriquecer.mock.calls[1]![5]).toBe(5);
  });
});

describe("D) bloqueio próprio, nunca o da organização", () => {
  it("não conseguiu o bloqueio: pulou, sem consulta de trabalho e sem chamar o modelo", async () => {
    const { pool, client } = montar({ trava: false, candidatos: { [C1]: [cand("a")] } });
    const r = await rodar(pool);
    expect(r).toEqual({ sites: 0, previas: 0, pulou: true });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(String(client.query.mock.calls[0]![0])).toContain("pg_try_advisory_lock");
    expect(mocks.gerar).not.toHaveBeenCalled();
    expect(mocks.enriquecer).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    // Sem bloqueio não há o que soltar; a conexão volta ao pool.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("a chave é DIFERENTE da do withProspectingLock (`prospecting:<org>`)", async () => {
    const { pool, client } = montar();
    await rodar(pool);
    const tentativa = client.query.mock.calls.find((c) => String(c[0]).includes("pg_try_advisory_lock"))!;
    expect(tentativa[1]).toEqual([`prospecting:${ORG}:preparo`]);
    expect(tentativa[1]).not.toEqual([`prospecting:${ORG}`]);
  });

  it("nunca chama withProspectingLock", async () => {
    const { pool } = montar({ candidatos: { [C1]: [cand("a")] } });
    await rodar(pool);
    expect(mocks.withLock).not.toHaveBeenCalled();
  });

  it("solta o bloqueio (mesma chave) e devolve a conexão no caminho feliz", async () => {
    const { pool, client } = montar();
    await rodar(pool);
    const solta = client.query.mock.calls.find((c) => String(c[0]).includes("pg_advisory_unlock"));
    expect(solta?.[1]).toEqual([`prospecting:${ORG}:preparo`]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("solta o bloqueio mesmo se o trabalho lançar — e a rodada não derruba o chamador", async () => {
    mocks.enriquecer.mockRejectedValue(new Error("rede caiu"));
    const { pool, client } = montar({ candidatos: { [C1]: [cand("a")] } });
    const r = await rodar(pool);
    expect(r.pulou).toBe(false);
    const solta = client.query.mock.calls.find((c) => String(c[0]).includes("pg_advisory_unlock"));
    expect(solta).toBeTruthy();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalled();
  });

  it("falha de consulta no meio do trabalho também solta o bloqueio", async () => {
    const { pool, client } = montar({ falhaNaCampanhas: new Error("banco fora") });
    await expect(rodar(pool)).resolves.toMatchObject({ pulou: false, previas: 0 });
    expect(
      client.query.mock.calls.some((c) => String(c[0]).includes("pg_advisory_unlock")),
    ).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("se o unlock falhar, a conexão é descartada (release com erro), não reemprestada", async () => {
    const { pool, client } = montar({ falhaNoUnlock: new Error("unlock falhou") });
    await rodar(pool);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe("E) falha da IA em um candidato", () => {
  it("não impede os outros, não repete o mesmo na rodada e o log não leva o texto", async () => {
    mocks.gerar.mockImplementation(async (_p: unknown, _o: string, linha: { id: string }) => {
      if (linha.id === "ruim-throw") throw new Error("gateway 500");
      if (linha.id === "ruim-vazio") return { ok: false, motivo: "ia_falhou", detalhe: "vazio" };
      return {
        ok: true,
        texto: SEGREDO,
        previa: { texto: SEGREDO, baseada_em: "k", gerada_em: "t", agente_id: AGENTE },
        estrategia: {},
        score: { valor: 1, motivo: "m" },
      };
    });
    const { pool, sqls } = montar({
      candidatos: {
        [C1]: [cand("ok-1"), cand("ruim-throw"), cand("ruim-vazio"), cand("ok-2")],
      },
    });
    const r = await rodar(pool);
    expect(r.previas).toBe(2);
    expect(gravacoes(sqls).map((g) => g.params[2]).sort()).toEqual(["ok-1", "ok-2"]);
    const ids = idsGerados();
    expect(new Set(ids).size).toBe(ids.length);
    expect(mocks.warn).toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(SEGREDO);
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(SEGREDO);
  });

  it("três falhas na rodada interrompem a geração (evita laço de custo a cada minuto)", async () => {
    mocks.gerar.mockRejectedValue(new Error("gateway fora"));
    const { pool } = montar({
      candidatos: { [C1]: Array.from({ length: 8 }, (_, i) => cand(`f${i}`)) },
    });
    const r = await rodar(pool);
    expect(mocks.gerar).toHaveBeenCalledTimes(3);
    expect(r.previas).toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("falha ao gravar uma prévia não derruba as outras", async () => {
    const { pool, client } = montar({ candidatos: { [C1]: [cand("a"), cand("b")] } });
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("update prospecting_candidates") && params?.[2] === "a")
        throw new Error("gravação falhou");
      return original(sql, params);
    });
    const r = await rodar(pool);
    expect(r.previas).toBe(1);
  });
});

describe("F) auditoria prospecting.previews_generated", () => {
  it("uma vez por rodada, quando houve efeito, sem o texto", async () => {
    const { pool } = montar({
      campanhas: [
        { id: C1, config: CONFIG },
        { id: C2, config: CONFIG },
      ],
      candidatos: { [C1]: [cand("a"), cand("b")], [C2]: [cand("c")] },
    });
    await rodar(pool);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const arg = mocks.audit.mock.calls[0]![0] as {
      action: string;
      organizationId: string;
      metadata: Record<string, unknown>;
    };
    expect(arg.action).toBe("prospecting.previews_generated");
    expect(arg.organizationId).toBe(ORG);
    expect(arg.metadata).toMatchObject({
      geradas: 3,
      campaign_ids: [C1, C2],
      por_campanha: { [C1]: 2, [C2]: 1 },
    });
    expect(JSON.stringify(arg)).not.toContain(SEGREDO);
  });

  it("rodada sem prévia gerada não audita", async () => {
    const { pool } = montar({ candidatos: { [C1]: [] } });
    await rodar(pool);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rodada que pulou (outro tick preparando) não audita", async () => {
    const { pool } = montar({ trava: false });
    await rodar(pool);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

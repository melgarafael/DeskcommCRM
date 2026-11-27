/**
 * O estado do atendimento do chat no site (spec 36, F3): dentro do horário, fora dele,
 * ou sem agente que atenda a conexão. A regra pura (`decidirAtendimento`) e a leitura
 * (`carregarAtendimento`) são testadas aqui; a janela e o aviso vêm do agente, não de
 * um horário novo.
 */
import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { carregarAtendimento, decidirAtendimento, type VersaoDoAtendimento } from "./atendimento";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONEXAO = "22222222-2222-4222-8222-222222222222";

// Terça 2026-11-24, 12h em São Paulo (15h UTC).
const TERCA_12H = new Date("2026-11-24T15:00:00Z");
// Terça 22h em São Paulo (01h UTC de quarta).
const TERCA_22H = new Date("2026-11-25T01:00:00Z");
// Sábado 2026-11-28, 12h em São Paulo.
const SABADO_12H = new Date("2026-11-28T15:00:00Z");

const JANELA = {
  filters: {
    business_hours: {
      timezone: "America/Sao_Paulo",
      start: "08:00",
      end: "18:00",
      weekdays: [1, 2, 3, 4, 5],
    },
  },
};

describe("decidirAtendimento", () => {
  it("lista vazia = sem_agente", () => {
    expect(decidirAtendimento([], TERCA_12H)).toEqual({
      estado: "sem_agente",
      abreEm: null,
      aviso: null,
    });
  });

  it("só agente pausado = sem_agente", () => {
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: JANELA, pausado: true }];
    expect(decidirAtendimento(versoes, TERCA_12H).estado).toBe("sem_agente");
  });

  it("sem business_hours = aberto (sempre atende)", () => {
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: {}, pausado: false }];
    expect(decidirAtendimento(versoes, TERCA_22H)).toEqual({
      estado: "aberto",
      abreEm: null,
      aviso: null,
    });
  });

  it("dentro da janela (terça 12h) = aberto", () => {
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: JANELA, pausado: false }];
    expect(decidirAtendimento(versoes, TERCA_12H).estado).toBe("aberto");
  });

  it("terça 22h = fechado, abre quarta 8h e devolve o aviso configurado", () => {
    const config = {
      filters: {
        business_hours: { ...JANELA.filters.business_hours, notice: "Voltamos amanhã cedo." },
      },
    };
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: config, pausado: false }];
    expect(decidirAtendimento(versoes, TERCA_22H)).toEqual({
      estado: "fechado",
      abreEm: "2026-11-25T11:00:00.000Z",
      aviso: "Voltamos amanhã cedo.",
    });
  });

  it("terça 22h sem notice = fechado com aviso null", () => {
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: JANELA, pausado: false }];
    expect(decidirAtendimento(versoes, TERCA_22H)).toEqual({
      estado: "fechado",
      abreEm: "2026-11-25T11:00:00.000Z",
      aviso: null,
    });
  });

  it("sábado = fechado, abre na segunda 8h", () => {
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: JANELA, pausado: false }];
    expect(decidirAtendimento(versoes, SABADO_12H)).toEqual({
      estado: "fechado",
      abreEm: "2026-11-30T11:00:00.000Z",
      aviso: null,
    });
  });

  it("fuso inválido = aberto (falha aberta)", () => {
    const config = {
      filters: { business_hours: { ...JANELA.filters.business_hours, timezone: "Marte/Olimpo" } },
    };
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: config, pausado: false }];
    expect(decidirAtendimento(versoes, TERCA_22H).estado).toBe("aberto");
  });

  it("pausado primeiro e ativo depois = usa o ativo (aberto, mesmo com o pausado fechado)", () => {
    const versoes: VersaoDoAtendimento[] = [
      { triggerConfig: JANELA, pausado: true },
      { triggerConfig: {}, pausado: false },
    ];
    expect(decidirAtendimento(versoes, TERCA_22H).estado).toBe("aberto");
  });

  it("com notice e dentro da janela, o aviso é null (o aviso só vale quando fechado)", () => {
    const config = {
      filters: { business_hours: { ...JANELA.filters.business_hours, notice: "Fechado." } },
    };
    const versoes: VersaoDoAtendimento[] = [{ triggerConfig: config, pausado: false }];
    expect(decidirAtendimento(versoes, TERCA_12H)).toEqual({
      estado: "aberto",
      abreEm: null,
      aviso: null,
    });
  });
});

describe("carregarAtendimento", () => {
  /** Dublê encadeado do supabase-js: `.from().select().eq()...` e `await` no fim. */
  function supabaseStub(resposta: { data: unknown; error: { message: string } | null }) {
    const chain: Record<string, unknown> = {};
    const eq = vi.fn(() => chain);
    const select = vi.fn((_colunas: string) => chain);
    Object.assign(chain, {
      select,
      eq,
      then: (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
        Promise.resolve(resposta).then(ok, falha),
    });
    const from = vi.fn(() => chain);
    return { admin: { from } as never, from, eq, select };
  }

  function linha(
    over: {
      paused_at?: string | null;
      archived_at?: string | null;
      janela?: unknown;
      published_version_id?: string;
    } = {},
  ) {
    return {
      id: "versao-1",
      trigger_config: over.janela ?? JANELA,
      ai_agents: {
        published_version_id: over.published_version_id ?? "versao-1",
        paused_at: over.paused_at ?? null,
        archived_at: over.archived_at ?? null,
        priority: 0,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
  }

  it("erro do banco = aberto e registra o aviso no logger", async () => {
    vi.mocked(logger.warn).mockClear();
    const { admin } = supabaseStub({ data: null, error: { message: "boom" } });
    const estado = await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(estado).toEqual({ estado: "aberto", abreEm: null, aviso: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("exceção ao consultar = aberto (o chat nunca fica mudo)", async () => {
    vi.mocked(logger.warn).mockClear();
    const admin = {
      from: () => {
        throw new Error("rede caiu");
      },
    } as never;
    const estado = await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(estado.estado).toBe("aberto");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("uma versão ativa com janela fechada = fechado", async () => {
    const { admin } = supabaseStub({ data: [linha()], error: null });
    const estado = await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(estado.estado).toBe("fechado");
    expect(estado.abreEm).toBe("2026-11-25T11:00:00.000Z");
  });

  it("agente arquivado não atende: sem_agente", async () => {
    const { admin } = supabaseStub({
      data: [linha({ archived_at: "2026-02-01T00:00:00Z" })],
      error: null,
    });
    const estado = await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(estado.estado).toBe("sem_agente");
  });

  it("versão published que não é a publicada do agente não conta: sem_agente", async () => {
    const { admin } = supabaseStub({
      data: [linha({ published_version_id: "versao-nova" })],
      error: null,
    });
    const estado = await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(estado.estado).toBe("sem_agente");
  });

  it("filtra por organization_id e channel_session_id", async () => {
    const { admin, from, eq } = supabaseStub({ data: [], error: null });
    await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(from).toHaveBeenCalledWith("ai_agent_versions");
    expect(eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(eq).toHaveBeenCalledWith("channel_session_id", CONEXAO);
  });

  it("o embed de ai_agents nomeia a FK (são duas, e sem a dica o PostgREST devolve PGRST201)", async () => {
    // Medido na prova pela tela do #5234: sem a dica, toda leitura caía na falha aberta e a
    // janela nunca saía de `aberto`. O dublê não tem o schema, então a guarda é sobre o texto.
    const { admin, select } = supabaseStub({ data: [], error: null });
    await carregarAtendimento(admin, ORG, CONEXAO, TERCA_22H);
    expect(select.mock.calls[0]?.[0]).toContain("ai_agents!ai_agent_versions_agent_id_fkey(");
  });
});

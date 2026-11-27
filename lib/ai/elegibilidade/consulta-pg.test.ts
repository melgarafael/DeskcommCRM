/**
 * Loader pg do gate de elegibilidade — contagem do teto do visitante anônimo
 * (F4, Task 1).
 *
 * O dublê de `pool` intercepta duas queries:
 *  - a de elegibilidade (`from conversations …`) → devolve a linha da conversa;
 *  - a de contagem (`from messages`) → devolve o total de respostas da IA.
 *
 * Casos do plano (Step 5):
 *  - anônimo no teto → veta;
 *  - o mesmo contato com e-mail → não veta;
 *  - isolamento: a query de contagem filtra por `organization_id` (conversa de
 *    outra organização com 25 respostas da IA não afeta esta).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { decidirElegibilidadeDaConversa } from "./consulta-pg";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-08-27T12:00:00Z");
const TTL = 21 * 24 * 60 * 60 * 1000;

function linhaConversa(over: Record<string, unknown> = {}): unknown {
  return {
    channel_metadata: { provider: "webchat" },
    provider: "webchat",
    force_human: false,
    ai_opt_out: false,
    email: null,
    phone_number: null,
    assignee_kind: "ai",
    conversation_metadata: null,
    bot_silenced_until: null,
    ai_authorized_at: null,
    social_identity: null,
    contact_tags: null,
    org_status: "active",
    org_settings: {},
    ...over,
  };
}

/** Dublê mínimo do pool pg. `query(sql, params) -> Promise<{ rows }>`. */
function poolStub(
  linhaConversaRows: unknown[],
  contagem: number,
): { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn((sql: string) => {
    if (sql.includes("from messages")) {
      return Promise.resolve({ rows: [{ total: contagem }] });
    }
    return Promise.resolve({ rows: linhaConversaRows });
  });
  return { query };
}

describe("decidirElegibilidadeDaConversa (pg) — teto do visitante anônimo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const input = {
    organizationId: ORG,
    conversationId: CONV,
    agora: AGORA,
    ttlMs: TTL,
  };

  it("anônimo no teto: veta com teto_do_visitante_anonimo", async () => {
    const { query } = poolStub([linhaConversa()], 20);
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toMatchObject({
      permite: false,
      motivo: "teto_do_visitante_anonimo",
      bloqueioPorAllowlist: false,
    });
    // A contagem filtra por organização e conversa (isolamento).
    const chamadaDaContagem = query.mock.calls.find((c) => String(c[0]).includes("from messages"));
    expect(chamadaDaContagem?.[1]).toEqual([ORG, CONV]);
    const sqlDaContagem = String(chamadaDaContagem?.[0]);
    expect(sqlDaContagem).toContain("organization_id = $1");
    expect(sqlDaContagem).toContain("conversation_id = $2");
  });

  it("abaixo do teto: permite", async () => {
    const { query } = poolStub([linhaConversa()], 19);
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toMatchObject({ permite: true, motivo: "gate_aberto" });
  });

  it("contato com e-mail: não se aplica o teto do anônimo (não conta)", async () => {
    const { query } = poolStub([
      linhaConversa({ email: "cliente@exemplo.com" }),
    ], 100);
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toMatchObject({ permite: true, motivo: "gate_aberto" });
    // A contagem não é feita para não-anônimo: a query de messages não roda.
    expect(query.mock.calls.some((c) => String(c[0]).includes("from messages"))).toBe(
      false,
    );
  });

  it("contato com telefone: não se aplica o teto do anônimo", async () => {
    const { query } = poolStub([
      linhaConversa({ phone_number: "+5511999998888" }),
    ], 100);
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toMatchObject({ permite: true, motivo: "gate_aberto" });
    expect(query.mock.calls.some((c) => String(c[0]).includes("from messages"))).toBe(
      false,
    );
  });

  it("falha na contagem: respostasDaIa = null e o gate passa", async () => {
    // Só a contagem falha: a leitura da conversa responde normalmente.
    const query = vi.fn((sql: string) =>
      sql.includes("from messages")
        ? Promise.reject(new Error("banco fora"))
        : Promise.resolve({ rows: [linhaConversa()] }),
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toMatchObject({ permite: true, motivo: "gate_aberto" });
    // Nenhum chamador passa `log`: a guarda que abre precisa deixar a linha no
    // logger do projeto, com o erro que a abriu.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG,
      conversation_id: CONV,
      erro: "banco fora",
    });
  });

  it("falha na contagem com `log` do chamador: o aviso vai para ele", async () => {
    const query = vi.fn((sql: string) =>
      sql.includes("from messages")
        ? Promise.reject(new Error("banco fora"))
        : Promise.resolve({ rows: [linhaConversa()] }),
    );
    const global = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    await decidirElegibilidadeDaConversa({ query } as unknown as never, { ...input, log });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG,
      conversation_id: CONV,
    });
    expect(global).not.toHaveBeenCalled();
  });

  it("outro provedor (whatsapp): não se aplica o teto do anônimo", async () => {
    const { query } = poolStub([linhaConversa({ provider: "whatsapp" })], 100);
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toMatchObject({ permite: true, motivo: "gate_aberto" });
    expect(query.mock.calls.some((c) => String(c[0]).includes("from messages"))).toBe(
      false,
    );
  });

  it("conversa não encontrada: null", async () => {
    const { query } = poolStub([], 0);
    const d = await decidirElegibilidadeDaConversa({ query } as unknown as never, input);
    expect(d).toBeNull();
  });
});

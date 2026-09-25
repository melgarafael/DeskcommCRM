import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import {
  ehFalhaTransitoria,
  FalhaPermanenteDeIngestao,
  FalhaTransitoriaDeIngestao,
} from "@/lib/waha/falha-transitoria";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

/**
 * A ingestão NÃO engole mais a falha do banco.
 *
 * Era `console.error` + `return` nos quatro pontos em que a mensagem do cliente
 * depende de uma escrita (contato, conversa, a mensagem recebida e a enviada pelo
 * celular), e a rota devolvia 200 — o WAHA riscava o evento e a mensagem sumia.
 * Medido em produção: três mensagens de cliente perdidas em 14/09/2026 num dia de
 * `statement timeout`.
 *
 * Aqui só se mede a FRONTEIRA: qual classe sai de `dispatchWahaEvent` para cada
 * tipo de erro do banco. O que a rota e o cron fazem com ela está em
 * `tests/unit/webhook-waha-pede-reentrega.test.ts`.
 */

type Falha = { code: string; message: string } | null;

function banco(opts: { contato?: Falha; conversa?: Falha; insert?: Falha }) {
  const consulta = () => {
    const q = {
      eq: () => q,
      in: () => q,
      is: () => q,
      limit: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return q;
  };
  return {
    from: () => ({
      select: () => consulta(),
      update: () => consulta(),
      insert: () => ({
        select: () => ({
          maybeSingle: async () =>
            opts.insert ? { data: null, error: opts.insert } : { data: { id: "msg-1" }, error: null },
        }),
      }),
    }),
    rpc: async (fn: string) => {
      if (fn === "fn_upsert_wa_contact") {
        return opts.contato ? { data: null, error: opts.contato } : { data: "contato-1", error: null };
      }
      if (fn === "fn_upsert_wa_conversation") {
        return opts.conversa ? { data: null, error: opts.conversa } : { data: "conversa-1", error: null };
      }
      return { data: null, error: null };
    },
  };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };

const recebida: WahaEnvelope = {
  event: "message.any",
  session: "default",
  payload: { id: "false_5531988887777@c.us_3EB0AAA", from: "5531988887777@c.us", fromMe: false, body: "oi" },
};
const doCelular: WahaEnvelope = {
  event: "message.any",
  session: "default",
  payload: {
    id: "true_5531988887777@c.us_3EB0BBB",
    from: "5531900000000@c.us",
    to: "5531988887777@c.us",
    fromMe: true,
    body: "respondi pelo celular",
  },
};

const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const NOT_NULL = { code: "23502", message: "null value in column violates not-null constraint" };

const despacha = (admin: unknown, env: WahaEnvelope) =>
  dispatchWahaEvent(admin as never, SESSION as never, env, "req-1");

describe("a régua: transitória ou permanente", () => {
  it.each([
    ["57014", true], // statement timeout — o caso medido
    ["08006", true], // conexão caiu
    ["53300", true], // conexões esgotadas
    ["40001", true], // serialização
    ["PGRST000", true], // PostgREST sem banco
    ["PGRST002", true], // PostgREST sem cache de schema
    ["", true], // fetch failed / 5xx do gateway: sem código
    ["23502", false], // not-null: o mesmo corpo falha sempre
    ["22P02", false], // tipo inválido
    ["42501", false], // permissão
    ["P0001", false], // raise exception de regra
    ["PGRST116", false], // pedido malformado
  ])("código %s → transitória=%s", (code, esperado) => {
    expect(ehFalhaTransitoria({ code, message: "x" })).toBe(esperado);
  });

  it("erro sem campo `code` nenhum é transitório (na dúvida, reentrega)", () => {
    expect(ehFalhaTransitoria({ message: "TypeError: fetch failed" })).toBe(true);
  });
});

describe("a ingestão lança em vez de engolir", () => {
  it("timeout no INSERT da mensagem recebida → FalhaTransitoriaDeIngestao", async () => {
    await expect(despacha(banco({ insert: TIMEOUT }), recebida)).rejects.toBeInstanceOf(
      FalhaTransitoriaDeIngestao,
    );
  });

  it("timeout no upsert do contato → FalhaTransitoriaDeIngestao", async () => {
    await expect(despacha(banco({ contato: TIMEOUT }), recebida)).rejects.toBeInstanceOf(
      FalhaTransitoriaDeIngestao,
    );
  });

  it("PostgREST sem banco no upsert da conversa → FalhaTransitoriaDeIngestao", async () => {
    await expect(
      despacha(banco({ conversa: { code: "PGRST000", message: "could not connect" } }), recebida),
    ).rejects.toBeInstanceOf(FalhaTransitoriaDeIngestao);
  });

  it("timeout no INSERT da mensagem enviada pelo celular → FalhaTransitoriaDeIngestao", async () => {
    await expect(despacha(banco({ insert: TIMEOUT }), doCelular)).rejects.toBeInstanceOf(
      FalhaTransitoriaDeIngestao,
    );
  });

  it("erro de dado no INSERT → FalhaPermanenteDeIngestao (a rota não pede reentrega)", async () => {
    await expect(despacha(banco({ insert: NOT_NULL }), recebida)).rejects.toBeInstanceOf(
      FalhaPermanenteDeIngestao,
    );
  });

  it("23505 continua sendo dedup: não lança", async () => {
    await expect(
      despacha(banco({ insert: { code: "23505", message: "duplicate key" } }), recebida),
    ).resolves.toBeUndefined();
  });

  it("controle: banco saudável não lança", async () => {
    await expect(despacha(banco({}), recebida)).resolves.toBeUndefined();
  });
});

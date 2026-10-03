import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createLogger } from "../../obs/logger";

import { deveRetomarSessao, redriveQueued } from "./session-reconciler";

afterEach(() => vi.restoreAllMocks());

/**
 * A regra que decide se o watchdog RELIGA a sessão. Religar FAILED é o que o
 * vigia de saúde recusa (pode ser banimento); SCAN_QR_CODE e STARTING já têm
 * dono. Só STOPPED: credencial no disco, sessão parada depois de restart.
 */
describe("deveRetomarSessao", () => {
  it("retoma só STOPPED", () => {
    expect(deveRetomarSessao("STOPPED")).toBe(true);
    expect(deveRetomarSessao("stopped")).toBe(true);
  });

  it.each(["WORKING", "STARTING", "SCAN_QR_CODE", "FAILED", ""])(
    "não religa %s — ou já está no ar, ou precisa de humano",
    (status) => {
      expect(deveRetomarSessao(status)).toBe(false);
    },
  );
});

describe("redrive pré-go-live", () => {
  it("não envia se a releitura da configuração falha", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockRejectedValueOnce(new Error("banco indisponível"));

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("m.organization_id = $2"), ["message-test", "org-test"]);
  });
});

/**
 * O RESGATE ALCANÇA A MENSAGEM QUE A AUTOMAÇÃO DEIXOU NA FILA (#652).
 *
 * O carimbo novo só é honesto se o resgate de `queued` souber dele. O registro
 * da automação conta com este resgate quando diz que o envio ficou adiado
 * (`lib/automation/desfecho-do-envio.ts`): uma linha `'automation'` presa com o
 * canal fora ficaria `queued` para sempre enquanto a Atividade da regra diz que
 * a mensagem ainda vai sair.
 *
 * O banco falso abaixo APLICA o filtro de `sent_via` que está na consulta —
 * devolver a linha de qualquer jeito faria o teste passar nos dois mundos, e é
 * justamente o vocabulário da consulta que está sob teste.
 */
function vocabularioDeSentVia(sql: string): string[] | null {
  const igual = /sent_via\s*=\s*'([a-z_]+)'/i.exec(sql);
  if (igual) return [igual[1]!];
  const conjunto = /sent_via\s+in\s*\(([^)]*)\)/i.exec(sql);
  if (conjunto) return [...conjunto[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  return null;
}

interface LinhaPresa {
  id: string;
  organization_id: string;
  conversation_id: string;
  body: string;
  sent_via: string;
  waha_session_name: string;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

function bancoComFila(fila: LinhaPresa[]) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string) => {
    consultas.push(sql);
    if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
    if (/select\s+m\.id/i.test(sql)) {
      const vocabulario = vocabularioDeSentVia(sql);
      if (vocabulario === null) return { rows: [] };
      return { rows: fila.filter((l) => vocabulario.includes(l.sent_via)).map((l) => ({ ...l })) };
    }
    if (/select\s+s\.metadata/i.test(sql)) {
      return { rows: fila.length === 0 ? [] : [{ metadata: {}, phone_number: "+5531999998888", operante: true }] };
    }
    return { rows: [] };
  });
  return { query, consultas };
}

describe("resgate da fila — a mensagem da AUTOMAÇÃO é alcançada (#652)", () => {
  it("⭐ linha `sent_via='automation'` presa em queued é reenviada pelo watchdog", async () => {
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: { id: "3EB0ABCDEF" } }), { status: 200 }));
    const { query } = bancoComFila([
      {
        id: "m-automacao",
        organization_id: "org-1",
        conversation_id: "conversa-1",
        body: "Olá! Vi que você preencheu o formulário.",
        sent_via: "automation",
        waha_session_name: "default",
        wa_identity: null,
        wa_lid: null,
        phone_number: "+5531999998888",
        is_group: false,
        group_chat_id: null,
      },
    ]);

    const reenviadas = await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999",
      wahaApiKey: "test-key",
      intervalMs: 1,
      redriveMinAgeMs: 0,
      redriveBatchSize: 10,
      redriveSpacingMs: 0,
    }, createLogger());

    expect(
      reenviadas,
      "a mensagem da automação ficou presa em `queued`: o resgate só olha sent_via='ai'",
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE: a linha de dispositivo externo não é reenviada — quem a mandou não foi o CRM", async () => {
    // Sem esta direção, um resgate que ignorasse o filtro passaria — e reenviar
    // uma mensagem do celular é mandar de novo o que a pessoa já escreveu.
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { query } = bancoComFila([
      {
        id: "m-celular",
        organization_id: "org-1",
        conversation_id: "conversa-1",
        body: "oi, tudo bem?",
        sent_via: "external_device",
        waha_session_name: "default",
        wa_identity: null,
        wa_lid: null,
        phone_number: "+5531999998888",
        is_group: false,
        group_chat_id: null,
      },
    ]);

    expect(
      await redriveQueued({ query } as unknown as pg.Pool, {
        wahaBaseUrl: "http://127.0.0.1:9999",
        wahaApiKey: "test-key",
        intervalMs: 1,
        redriveMinAgeMs: 0,
        redriveBatchSize: 10,
        redriveSpacingMs: 0,
      }, createLogger()),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});


describe("redrive × organização parada", () => {
  it("org não operante: a mensagem vira failed/org_suspensa e nada sai para o WAHA", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockResolvedValueOnce({ rows: [{ metadata: {}, phone_number: "+5511999998888", operante: false }] })
      .mockResolvedValue({ rows: [] });

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query.mock.calls[2]?.[0]).toContain("public.fn_org_operante(m.organization_id)");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("error_code = 'org_suspensa'"), ["message-test", "org-test"]);
  });
});

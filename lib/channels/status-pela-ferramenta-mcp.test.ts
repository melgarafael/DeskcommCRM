/**
 * `crm_publish_whatsapp_status` pelo handler (#3397): o freio do número, a
 * idempotência e a auditoria medidos juntos, porque o defeito morava na ORDEM.
 *
 * O freio rodava antes da chave: um replay contava um envio que não aconteceu, e
 * o retry de uma publicação pronta no teto diário levava 429 em vez do recibo.
 * Só o transporte e o ledger são dublês; `segurarEnvioPorToken`,
 * `comIdempotencia` e o adapter são os de produção.
 *
 * Mora em `lib/channels/`, e não ao lado da ferramenta, porque o adapter de
 * verdade exige um transporte dublê, e só aqui a cerca de canal aceita o nome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { deModuloDesligado } from "@/lib/mcp/tools/catalog";
import { crmPublishWhatsappStatus as tool } from "@/lib/mcp/tools/status";
import type { McpContext } from "@/lib/mcp/types";
import type * as Ritmo from "@/lib/messaging/ritmo-do-envio-por-token";
import { bancoFalso, type Linha } from "@/tests/helpers/banco-falso-do-status";

const h = vi.hoisted(() => ({
  sendStatusImage: vi.fn(),
  decide: vi.fn(),
  registraEnvio: vi.fn(),
}));

vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({ sendStatusImage: h.sendStatusImage }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", async (original) => {
  const real = await original<typeof Ritmo>();
  const deps: Ritmo.DepsDoRitmo = {
    lerCanalDaConversa: async () => null,
    lerCanalDaSessao: async (_org, id) => ({ channelSessionId: id, provider: "waha" }),
    pacing: { decide: h.decide, registraEnvio: h.registraEnvio },
    sleep: async () => {},
    agora: () => new Date("2026-11-06T12:00:00Z"),
  };
  return { ...real, depsDoRitmo: async () => deps };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

const SESSAO: Linha = {
  id: CANAL,
  provider: "waha",
  status: "WORKING",
  archived_at: null,
  waha_session_name: "loja",
  meta_phone_number_id: null,
  zernio_account_id: null,
  datafy_phone_number_id: null,
  metadata: {},
};

const LIBERADO = { liberado: true };
const NO_TETO = {
  liberado: false,
  motivo: "teto_diario",
  liberaEm: new Date("2026-11-07T03:00:00Z"),
};

const entrada = (over: Partial<Parameters<typeof tool.handler>[0]> = {}) => ({
  channel_session_id: CANAL,
  image_base64: "A".repeat(200),
  image_mime: "image/jpeg" as const,
  contacts: ["5515999990000"],
  idempotency_key: "run-1",
  ...over,
});

const contexto = (db: McpContext["supabase"]): McpContext =>
  ({ organizationId: ORG, requestId: "req-1", supabase: db }) as McpContext;

beforeEach(() => {
  vi.clearAllMocks();
  h.sendStatusImage.mockReset().mockResolvedValue({ id: { id: "ST-1" } });
  h.decide.mockReset().mockResolvedValue(LIBERADO);
});

describe("crm_publish_whatsapp_status: o freio do número mora dentro do efeito", () => {
  it("publicar conta um envio no ledger", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    const r = await tool.handler(entrada(), contexto(db));

    expect(r).toMatchObject({ published: true, status_id: "ST-1", deduplicated: false });
    expect(h.registraEnvio).toHaveBeenCalledTimes(1);
  });

  it("replay devolve o recibo sem frear e sem contar outro envio", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    await tool.handler(entrada(), contexto(db));
    const r = await tool.handler(entrada(), contexto(db));

    expect(r).toMatchObject({ published: true, status_id: "ST-1", deduplicated: true });
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.registraEnvio).toHaveBeenCalledTimes(1);
    expect(h.sendStatusImage).toHaveBeenCalledTimes(1);
  });

  it("retry de publicação pronta com o número no teto recebe o recibo, não 429", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    await tool.handler(entrada(), contexto(db));
    h.decide.mockResolvedValue(NO_TETO);

    await expect(tool.handler(entrada(), contexto(db))).resolves.toMatchObject({ deduplicated: true });
  });

  it("429 na primeira tentativa libera a chave: nada saiu, e o retry publica", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });
    h.decide.mockResolvedValueOnce(NO_TETO);

    const erro = await tool.handler(entrada(), contexto(db)).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(429);
    expect(h.sendStatusImage).not.toHaveBeenCalled();
    expect(h.registraEnvio).not.toHaveBeenCalled();

    await expect(tool.handler(entrada(), contexto(db))).resolves.toMatchObject({ deduplicated: false });
    expect(h.sendStatusImage).toHaveBeenCalledTimes(1);
  });

  it("recusa de validação não gasta o freio", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, status: "SCAN_QR_CODE" } });

    await expect(tool.handler(entrada(), contexto(db))).rejects.toThrow(/canal_desconectado/);

    expect(h.decide).not.toHaveBeenCalled();
    expect(h.registraEnvio).not.toHaveBeenCalled();
  });

  it("recusa do canal não conta envio", async () => {
    h.sendStatusImage.mockRejectedValue(new Error("waha_status_400"));
    const { db } = bancoFalso({ sessao: SESSAO });

    await expect(tool.handler(entrada(), contexto(db))).rejects.toThrow(/publicacao_recusada/);

    expect(h.registraEnvio).not.toHaveBeenCalled();
  });

  it("sem resposta do canal conta o envio, porque pode ter saído, e o retry não republica", async () => {
    h.sendStatusImage.mockRejectedValue(new Error("waha_timeout: sem resposta em 30000ms"));
    const { db } = bancoFalso({ sessao: SESSAO });

    await expect(tool.handler(entrada(), contexto(db))).rejects.toThrow(/publicacao_incerta/);
    await expect(tool.handler(entrada(), contexto(db))).rejects.toThrow(/publicacao_incerta/);

    expect(h.sendStatusImage).toHaveBeenCalledTimes(1);
    expect(h.registraEnvio).toHaveBeenCalledTimes(1);
  });
});

describe("crm_publish_whatsapp_status: é módulo opcional da instalação", () => {
  it("desligado de fábrica: nenhum módulo ligado, nenhuma ferramenta", () => {
    expect(deModuloDesligado("crm_publish_whatsapp_status", [])).toBe(true);
  });

  it("ligar o módulo oferece a ferramenta", () => {
    expect(deModuloDesligado("crm_publish_whatsapp_status", ["status_whatsapp"])).toBe(false);
  });
});

describe("crm_publish_whatsapp_status: a auditoria", () => {
  it("guarda o modo e a contagem, nunca telefone, legenda ou imagem", () => {
    const fora = tool.redigirParaAuditoria!({
      channel_session_id: CANAL,
      image_base64: "A".repeat(200),
      contacts: ["5515999990000", "5515988887777"],
      caption: "Promo do João",
    });

    expect(fora).toEqual({
      channel_session_id: CANAL,
      audience: "contatos",
      contacts_count: 2,
      caption_present: true,
    });
  });

  it("publicar para todos fica dito como modo", () => {
    expect(tool.redigirParaAuditoria!({ all_contacts: true })).toMatchObject({
      audience: "todos",
      contacts_count: 0,
      caption_present: false,
    });
  });
});

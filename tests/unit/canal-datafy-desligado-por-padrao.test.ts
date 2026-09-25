import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/graph-parceiro/session", () => ({
  graphPartnerRefsDaSessao: vi.fn(async () => ({ phoneNumberId: "PN", wabaId: "WABA" })),
}));
vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaInbound: vi.fn(async () => ({ status: "ingested" })),
}));

import { CHANNEL_PROVIDER_DATAFY } from "@/lib/channels/capabilities";
import { canalGraphParceiroLigado } from "@/lib/channels/graph-parceiro/credentials";
import {
  acceptsInboundWebhook,
  handleInboundWebhook,
  verifyInboundWebhookSignature,
} from "@/lib/channels/inbound";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";

/**
 * O CANAL DATAFY NASCE DESLIGADO (decisão do dono, doc 54, opção b).
 *
 * "Quem não liga não vê nada": nem aba, nem rota, nem webhook aceitando, nem
 * envio. A aba e a rota estão provadas no teste da rota e no `ConexoesShell`;
 * aqui fica a regra do interruptor e a ENTRADA, que é onde um canal desligado
 * mais dói se vazar — mensagem forjada chegando na caixa de quem nem usa o canal.
 */
const ORIGINAL = process.env.DATAFY_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATAFY_ENABLED;
  else process.env.DATAFY_ENABLED = ORIGINAL;
  vi.clearAllMocks();
});

const SEGREDO = "whsec_segredo_do_painel_123";
const TS = "1700000000";

function envelope(phoneNumberId: string, wabaId = "WABA"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5531900000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Cliente" }, wa_id: "5531999998888" }],
              messages: [
                { from: "5531999998888", id: `wamid.${phoneNumberId}`, timestamp: TS, type: "text", text: { body: "oi" } },
              ],
            },
          },
        ],
      },
    ],
  });
}

function assinado(corpo: string, segredo = SEGREDO): Headers {
  const sig = createHmac("sha256", segredo).update(`${TS}.${corpo}`).digest("hex");
  return new Headers({ "x-datafy-signature-256": `sha256=${sig}`, "x-datafy-timestamp": TS });
}

const sessao = { id: "sess-1", organization_id: "org-1", provider: CHANNEL_PROVIDER_DATAFY };

describe("o interruptor da instalação", () => {
  it("vazio, ausente ou qualquer coisa que não seja `true` deixa DESLIGADO", () => {
    for (const v of [undefined, "", " ", "false", "1", "sim", "yes", "TRUE_"]) {
      expect(canalGraphParceiroLigado(v), String(v)).toBe(false);
    }
    expect(canalGraphParceiroLigado("true")).toBe(true);
    expect(canalGraphParceiroLigado(" TRUE ")).toBe(true);
  });

  it("o `.env.example` entrega o canal desligado", () => {
    const exemplo = readFileSync(".env.example", "utf8");
    expect(exemplo).toMatch(/^DATAFY_ENABLED=$/m);
  });
});

describe("a entrada do canal", () => {
  it("desligado: não aceita webhook nem com assinatura válida", async () => {
    process.env.DATAFY_ENABLED = "";
    const corpo = envelope("PN");
    expect(acceptsInboundWebhook(CHANNEL_PROVIDER_DATAFY)).toBe(false);
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_DATAFY, corpo, assinado(corpo), SEGREDO)).toBe(false);
    const r = await handleInboundWebhook({} as never, { session: sessao, rawBody: corpo, headers: assinado(corpo), secret: SEGREDO });
    expect(r.ok).toBe(false);
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it("ligado mas SEM o segredo do painel: recusa tudo (fail-closed)", async () => {
    process.env.DATAFY_ENABLED = "true";
    const corpo = envelope("PN");
    const provisorio = "b".repeat(64);
    const r = await handleInboundWebhook({} as never, {
      session: sessao,
      rawBody: corpo,
      headers: assinado(corpo, provisorio),
      secret: provisorio,
    });
    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });

  it("ligado e assinado: ingere na sessão do TOKEN, com a organização dela", async () => {
    process.env.DATAFY_ENABLED = "true";
    const corpo = envelope("PN");
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_DATAFY, corpo, assinado(corpo), SEGREDO)).toBe(true);
    const r = await handleInboundWebhook({} as never, { session: sessao, rawBody: corpo, headers: assinado(corpo), secret: SEGREDO });
    expect(r).toMatchObject({ ok: true, body: { outcomes: ["ingested"] } });
    expect(ingestMetaInbound).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ phoneNumberId: "PN" }),
      { organizationId: "org-1", channelSessionId: "sess-1" },
    );
  });

  it("evento de OUTRO número ou de outra conta não entra na sessão, mesmo bem assinado", async () => {
    process.env.DATAFY_ENABLED = "true";
    for (const corpo of [envelope("OUTRO"), envelope("PN", "OUTRA_WABA")]) {
      const r = await handleInboundWebhook({} as never, { session: sessao, rawBody: corpo, headers: assinado(corpo), secret: SEGREDO });
      expect(r.ok).toBe(true);
    }
    expect(ingestMetaInbound).not.toHaveBeenCalled();
  });
});

describe("a revisão do modelo volta pelo webhook", () => {
  it("atualiza o espelho DESTA conexão, sem precisar de sincronizar", async () => {
    process.env.DATAFY_ENABLED = "true";
    const filtros: [string, unknown][] = [];
    const patches: Record<string, unknown>[] = [];
    const admin = {
      from: (tabela: string) => {
        expect(tabela).toBe("meta_templates");
        const q = {
          update: (p: Record<string, unknown>) => {
            patches.push(p);
            return q;
          },
          eq: (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            return q;
          },
          then: (ok: (r: unknown) => unknown) => ok({ error: null }),
        };
        return q;
      },
    };
    const corpo = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "message_template_status_update",
              value: { event: "APPROVED", message_template_name: "boas_vindas", message_template_language: "pt_BR" },
            },
          ],
        },
      ],
    });
    const r = await handleInboundWebhook(admin as never, { session: sessao, rawBody: corpo, headers: assinado(corpo), secret: SEGREDO });
    expect(r).toMatchObject({ ok: true, body: { outcomes: ["modelo"] } });
    expect(patches[0]).toMatchObject({ status: "APPROVED" });
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["channel_session_id", "sess-1"],
        ["name", "boas_vindas"],
        ["language", "pt_BR"],
      ]),
    );
  });
});

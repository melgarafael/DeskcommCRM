import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumirComResultado,
  consumirRespostaDoSuporteNoWhatsApp,
} from "@/lib/escalacao/resposta-whatsapp-ao-caso";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { identidadeDoRemetente, parseChatId, type WahaPayload } from "@/lib/waha/ingest";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SESSAO_DE_VENDAS = "33333333-3333-4333-8333-333333333333";
const PHONE = "+5531998966398";
const CASE = "02920000-5555-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ externalId: "sent-ack" })),
  decide: vi.fn(async () => ({ liberado: true as const })),
  register: vi.fn(async () => undefined),
  config: vi.fn(async () => true),
  resolve: vi.fn(async () => ({ to: PHONE })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: async () => ({
    configurado: mocks.config,
    resolveDestino: mocks.resolve,
    envia: mocks.send,
  }),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: async () => ({ decide: mocks.decide, registraEnvio: mocks.register }),
}));

function db(options: { enabled?: boolean; result?: string; error?: boolean; jid?: string } = {}) {
  const cfg = {
    telefone_destino: PHONE,
    destino_jid: options.jid ?? null,
    resposta_whatsapp_habilitada: options.enabled ?? true,
    channel_session_id: SESSION,
  };
  const rpc = vi.fn(async (..._args: unknown[]) => ({
    data: options.result ?? "accepted",
    error: options.error ? { message: "db failed" } : null,
  }));
  const from = vi.fn((table: string) => {
    const resolvedCfg = table === "config_aviso_de_caso"
      ? { ...cfg, resposta_whatsapp_habilitada: options.enabled ?? true }
      : null;
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = async () => ({
      data: resolvedCfg,
      error: null,
    });
    builder.update = () => builder;
    builder.then = (resolve: (x: unknown) => unknown) => resolve({ error: null });
    return builder;
  });
  return { rpc, from, db: { rpc, from } as never };
}

function entry(text: string | null, externalId = "msg-1") {
  return {
    organizationId: ORG,
    channelSessionId: SESSION,
    identidade: { kind: "phone", phone: PHONE, lid: null },
    direction: "inbound" as const,
    texto: text,
    externalId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limparCacheDoNumeroInterno();
  mocks.decide.mockResolvedValue({ liberado: true });
});

describe("confirmações de comando pelo WhatsApp", () => {
  it("responde ao comando aceito e registra o envio no mesmo pacing", async () => {
    const { db: client } = db();
    const result = await consumirComResultado(client, entry(`RESPONDER ${CASE} Resolvido`));
    expect(result).toEqual({ consumed: true, result: "accepted" });
    expect(mocks.send).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: SESSION }), { to: PHONE }, "Recebido. A IA vai seguir com o cliente.");
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it("informa que o caso não existe ou já foi respondido", async () => {
    const { db: client } = db({ result: "case_unavailable" });
    await consumirComResultado(client, entry(`RESPONDER ${CASE} Resolvido`));
    expect(mocks.send).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: SESSION }), { to: PHONE }, "Não consegui: esse caso já foi respondido ou não existe.");
  });

  it("avisa sobre formato inválido de comando, sem responder mensagens comuns", async () => {
    const { db: client } = db();
    await consumirComResultado(client, entry("RESPONDER"));
    expect(mocks.send).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: SESSION }), { to: PHONE }, expect.stringContaining("Formato:"));
    vi.clearAllMocks();
    await consumirComResultado(client, entry("bom dia"));
    expect(mocks.send).not.toHaveBeenCalled();
    expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.map((call: unknown[]) => call[0]))
      .not.toContain("fn_responder_caso_por_whatsapp");
  });

  it("não envia recibo duplicado nem quando o opt-in está desligado", async () => {
    const duplicate = db({ result: "duplicate" });
    await consumirComResultado(duplicate.db, entry(`RESPONDER ${CASE} Resolvido`));
    expect(mocks.send).not.toHaveBeenCalled();
    const disabled = db({ enabled: false });
    limparCacheDoNumeroInterno();
    disabled.from.mockImplementation(((table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = async () => ({
        data: table === "config_aviso_de_caso"
          ? { telefone_destino: PHONE, destino_jid: null, resposta_whatsapp_habilitada: false, channel_session_id: SESSION }
          : null,
        error: null,
      });
      builder.update = () => builder;
      builder.then = (resolve: (x: unknown) => unknown) => resolve({ error: null });
      return builder;
    }) as never);
    await consumirComResultado(disabled.db, entry(`RESPONDER ${CASE} Resolvido`));
    expect((disabled.rpc as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0]))
      .not.toContain("fn_responder_caso_por_whatsapp");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("falha de envio da confirmação não derruba a ingestão", async () => {
    mocks.send.mockRejectedValueOnce(new Error("transport unavailable"));
    const { db: client } = db();
    await expect(consumirComResultado(client, entry(`RESPONDER ${CASE} Resolvido`)))
      .resolves.toEqual({ consumed: true, result: "accepted" });
  });

  it("a função pública consome mensagens do número interno sem abrir conversa", async () => {
    const { db: client } = db({ result: "unauthorized" });
    await expect(consumirRespostaDoSuporteNoWhatsApp(client, entry("mensagem comum")))
      .resolves.toBe(true);
    expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.map((call: unknown[]) => call[0]))
      .not.toContain("fn_responder_caso_por_whatsapp");
  });

  it("falha da RPC é registrada, não derruba o webhook nem cria conversa do suporte", async () => {
    const { db: client } = db({ error: true });
    await expect(consumirRespostaDoSuporteNoWhatsApp(
      client,
      entry(`RESPONDER ${CASE} Resolvido`),
    )).resolves.toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("o aceito vai para a auditoria sem usuário e com a origem; o duplicado não", async () => {
    const { db: client } = db();
    await consumirComResultado(client, entry(`PERGUNTAR ${CASE} Qual o pedido?`));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.case_replied",
      actorUserId: null,
      organizationId: ORG,
      resourceType: "agent_case",
      resourceId: CASE,
      metadata: expect.objectContaining({ case_action: "need_lead_info", source: "whatsapp" }),
    }));
    vi.clearAllMocks();
    limparCacheDoNumeroInterno();
    await consumirComResultado(db({ result: "duplicate" }).db, entry(`RESPONDER ${CASE} Resolvido`, "msg-2"));
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  // Payload na forma que o WAHA entrega (ver `telefone-alternativo-do-payload`):
  // `from` opaco em `@lid` e o telefone em `_data.key.remoteJidAlt`. O
  // `destino_jid` é o que o transporte grava — sempre `<tel>@c.us`, nunca `@lid`.
  function payloadLid(body: string, remoteJidAlt = "5531998966398@s.whatsapp.net"): WahaPayload {
    return {
      id: "false_100000000000777@lid_3A60443E83484256AF03",
      from: "100000000000777@lid",
      fromMe: false,
      body,
      timestamp: 1_760_000_000,
      _data: {
        key: {
          id: "3A60443E83484256AF03",
          fromMe: false,
          remoteJid: "100000000000777@lid",
          remoteJidAlt,
          addressingMode: "lid",
        },
      },
    };
  }
  const identidadeDe = (p: WahaPayload) => identidadeDoRemetente(p, parseChatId(p.from ?? ""));

  it("número em modo privacidade (@lid) responde pelo telefone do remoteJidAlt", async () => {
    const lid = db({ jid: "5531998966398@c.us" });
    const p = payloadLid(`RESPONDER ${CASE} Resolvido`);
    const result = await consumirComResultado(lid.db, {
      ...entry(p.body ?? null, p.id ?? ""),
      identidade: identidadeDe(p),
    });
    expect(result).toEqual({ consumed: true, result: "accepted" });
    expect(lid.rpc).toHaveBeenCalledWith(
      "fn_responder_caso_por_whatsapp",
      expect.objectContaining({ p_phone_variants: expect.arrayContaining([PHONE]) }),
    );
  });

  it("@lid de OUTRO telefone não é o número de avisos: segue o caminho de cliente", async () => {
    const lid = db({ jid: "5531998966398@c.us" });
    const p = payloadLid(`RESPONDER ${CASE} Resolvido`, "5511900000001@s.whatsapp.net");
    await expect(consumirRespostaDoSuporteNoWhatsApp(lid.db, {
      ...entry(p.body ?? null, p.id ?? ""),
      identidade: identidadeDe(p),
    })).resolves.toBe(false);
    expect(lid.rpc).not.toHaveBeenCalled();
  });

  it("mensagem comum do @lid continua contada como ignorada", async () => {
    const lid = db({ jid: "5531998966398@c.us" });
    const p = payloadLid("bom dia");
    const result = await consumirComResultado(lid.db, {
      ...entry(p.body ?? null, p.id ?? ""),
      identidade: identidadeDe(p),
    });
    expect(result).toEqual({ consumed: true, result: null });
    const chamadas = lid.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(chamadas).toContain("fn_contar_mensagem_ignorada");
    expect(chamadas).not.toContain("fn_responder_caso_por_whatsapp");
  });

  it("comando que chega pela conexão de VENDAS não é interpretado nem respondido", async () => {
    for (const texto of ["RESPONDER esse aqui", `RESPONDER ${CASE} Resolvido`]) {
      vi.clearAllMocks();
      limparCacheDoNumeroInterno();
      const vendas = db();
      const result = await consumirComResultado(vendas.db, {
        ...entry(texto),
        channelSessionId: SESSAO_DE_VENDAS,
      });
      // O corte de antes: ignorada e contada, como qualquer mensagem do número de avisos.
      expect(result).toEqual({ consumed: true, result: null });
      const chamadas = vendas.rpc.mock.calls.map((c: unknown[]) => c[0]);
      expect(chamadas).toEqual(["fn_contar_mensagem_ignorada"]);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
    }
  });
});

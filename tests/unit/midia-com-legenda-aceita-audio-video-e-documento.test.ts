/**
 * ÁUDIO, VÍDEO E DOCUMENTO NAS AUTOMAÇÕES E NO FOLLOW-UP (#2972).
 *
 * ═══ O que este arquivo prova ═══
 *
 * A régua de tipo do passo automático (`classificarMidiaComLegenda`,
 * `lib/messaging/media/midia-com-legenda.ts`) deixou de recusar tudo o que não
 * fosse imagem ou PDF. Este arquivo mede os três contratos que a issue pede, e
 * nos TRÊS níveis em que eles podem quebrar:
 *
 *  1. a CLASSIFICAÇÃO — áudio vira `audio`, vídeo vira `video`, planilha/docx
 *     vira `document`; imagem e PDF continuam como estavam;
 *  2. o ENDPOINT — quem traduz o tipo para o transporte é `wahaSendPlanFor`
 *     (`lib/waha/media-send.ts`), e é ele que manda áudio por `sendVoice` com
 *     `convert: true` (nota de voz), vídeo por `sendVideo` e documento por
 *     `sendFile`. Medir só o tipo seria não provar que o arquivo sai;
 *  3. a CADEIA — o passo da automação (`send_whatsapp_message`) chega ao
 *     `sendMessageHandler` com o `type` novo, o `media_url` e o texto como
 *     legenda; e a recusa fora da janela de 24 h continua valendo para os tipos
 *     novos (a cerca não foi afrouxada para caber o áudio).
 *
 * O "ANTES" de cada caso (o que a régua respondia com o recorte do #2734) está
 * na seção de sabotagem do PR: devolver a régua ao recorte antigo derruba os
 * casos de áudio, vídeo e documento deste arquivo, e nenhum dos de imagem/PDF.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { classificarMidiaComLegenda } from "@/lib/messaging/media/midia-com-legenda";
import { wahaSendPlanFor } from "@/lib/waha/media-send";

const sendMessageHandler = vi.fn();
const espacarEnvio = vi.fn();
const serviceForAutomation = vi.fn();
const assertAgendaEffectSupabase = vi.fn();
const reportarEnvio = vi.fn();

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => sendMessageHandler(...args),
}));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: (...args: unknown[]) => espacarEnvio(...args),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: (...args: unknown[]) => serviceForAutomation(...args),
}));
vi.mock("@/lib/agenda/efeito", () => ({
  assertAgendaEffectSupabase: (...args: unknown[]) => assertAgendaEffectSupabase(...args),
}));
vi.mock("@/lib/automation/desfecho-do-envio", () => ({
  reportarEnvio: (...args: unknown[]) => reportarEnvio(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-whatsapp";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const HORA = 3_600_000;

const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** Dublê do cliente admin: as duas leituras da régua da janela (conversa e sessão). */
function bancoFalso(input: { provider: string | null; ultimoInbound: string | null }) {
  const from = (tabela: string) => {
    const encadeavel: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "is", "in", "order", "limit", "update"]) {
      encadeavel[metodo] = () => encadeavel;
    }
    encadeavel.maybeSingle = async () => {
      if (tabela === "conversations") {
        return { data: { last_inbound_at: input.ultimoInbound, channel_session_id: CANAL }, error: null };
      }
      if (tabela === "channel_sessions") return { data: { provider: input.provider }, error: null };
      return { data: null, error: null };
    };
    encadeavel.single = encadeavel.maybeSingle;
    return encadeavel;
  };
  return { from } as unknown as ActionCtx["admin"];
}

function executar(config: Record<string, unknown>, admin: ActionCtx["admin"]): Promise<ActionResultDetail> {
  const acao = getAction("send_whatsapp_message");
  if (!acao) throw new Error("send_whatsapp_message não está registrada");
  const ctx: ActionCtx = {
    admin,
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Boas-vindas em áudio",
    event: { id: "evento-1" } as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: CONTATO, phone_number: "+551****8888" } },
  };
  return acao.execute(ctx, config);
}

/** O `input` que chegou ao handler de envio, na última chamada. */
function envio(): Record<string, unknown> {
  const chamada = sendMessageHandler.mock.calls.at(-1);
  if (!chamada) throw new Error("o handler de envio não foi chamado");
  return chamada[2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
  serviceForAutomation.mockResolvedValue(FRONTEIRA);
  assertAgendaEffectSupabase.mockResolvedValue(undefined);
  reportarEnvio.mockImplementation(async (_ctx, type: string) => ({
    type,
    status: "success" as const,
    detail: { message_id: "mensagem-1" },
  }));
});

describe("classificarMidiaComLegenda — os tipos novos (#2972)", () => {
  it("áudio: classificado como `audio`, com o MIME que a régua derivou", () => {
    for (const [url, mime] of [
      ["https://cdn.exemplo/recado.ogg", "audio/ogg"],
      ["https://cdn.exemplo/recado.opus", "audio/ogg"],
      ["https://cdn.exemplo/recado.mp3", "audio/mpeg"],
      ["https://cdn.exemplo/recado.m4a", "audio/mp4"],
    ] as const) {
      expect(classificarMidiaComLegenda(url), url).toEqual({ ok: true, type: "audio", mime });
    }
  });

  it("vídeo: classificado como `video`", () => {
    for (const [url, mime] of [
      ["https://cdn.exemplo/produto.mp4", "video/mp4"],
      ["https://cdn.exemplo/produto.3gp", "video/3gpp"],
      ["https://cdn.exemplo/produto.mov", "video/quicktime"],
    ] as const) {
      expect(classificarMidiaComLegenda(url), url).toEqual({ ok: true, type: "video", mime });
    }
  });

  it("documento qualquer: planilha, docx, pptx, zip e csv saem como `document`", () => {
    for (const url of [
      "https://cdn.exemplo/custos.xlsx",
      "https://cdn.exemplo/contrato.docx",
      "https://cdn.exemplo/catalogo.pptx",
      "https://cdn.exemplo/pacote.zip",
      "https://cdn.exemplo/dados.csv",
    ]) {
      expect(classificarMidiaComLegenda(url), url).toMatchObject({ ok: true, type: "document" });
    }
  });

  it("o MIME declarado continua vencendo a extensão nos tipos novos", () => {
    // Um `.ogg` servido como vídeo tem de sair como vídeo: quem declarou o tipo
    // sabe mais que o nome do arquivo — a mesma precedência do #2734.
    expect(classificarMidiaComLegenda("https://cdn.exemplo/x.ogg", "video/mp4")).toEqual({
      ok: true,
      type: "video",
      mime: "video/mp4",
    });
  });

  it("CONTROLE: imagem e PDF seguem idênticos ao que o #2856 publicou", () => {
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.png")).toEqual({
      ok: true,
      type: "image",
      mime: "image/png",
    });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/contrato.pdf")).toEqual({
      ok: true,
      type: "document",
      mime: "application/pdf",
    });
  });

  it("CONTROLE: o que não é um arquivo identificável continua RECUSADO", () => {
    for (const url of [
      "https://cdn.exemplo/arquivo-sem-extensao",
      "https://cdn.exemplo/relatorio.qzx",
      "nao-e-url",
      "https://cdn.exemplo/",
      // `.webm` é a MESMA extensão para áudio e vídeo: sem MIME declarado, mandar
      // um como o outro seria o envio errado que ninguém vê.
      "https://cdn.exemplo/gravacao.webm",
    ]) {
      const r = classificarMidiaComLegenda(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.motivo).toMatch(/imagem/);
    }
  });
});

describe("wahaSendPlanFor — o endpoint que cada tipo usa", () => {
  it("áudio sai por `sendVoice` com `convert: true` (mensagem de voz, não arquivo)", () => {
    expect(
      wahaSendPlanFor("audio", { url: "https://cdn.exemplo/recado.ogg", mime: "audio/ogg" }),
    ).toEqual({
      endpoint: "sendVoice",
      payload: { file: { url: "https://cdn.exemplo/recado.ogg", mimetype: "audio/ogg" }, convert: true },
    });
  });

  it("vídeo sai por `sendVideo`, com o texto de legenda quando há", () => {
    expect(
      wahaSendPlanFor("video", { url: "https://cdn.exemplo/produto.mp4", mime: "video/mp4", caption: "Olha o produto." }),
    ).toMatchObject({
      endpoint: "sendVideo",
      payload: { convert: true, caption: "Olha o produto." },
    });
  });

  it("documento sai por `sendFile`, com o texto de legenda quando há", () => {
    expect(
      wahaSendPlanFor("document", { url: "https://cdn.exemplo/custos.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", caption: "Segue a planilha." }),
    ).toMatchObject({
      endpoint: "sendFile",
      payload: { caption: "Segue a planilha." },
    });
  });

  it("áudio NÃO leva legenda: no WhatsApp a nota de voz não tem `caption`", () => {
    // O texto do passo não vira legenda aqui — e o desfecho é DECLARADO no PR,
    // não silencioso: o que sai é a nota de voz, sem um texto solto no lugar.
    const plano = wahaSendPlanFor("audio", {
      url: "https://cdn.exemplo/recado.ogg",
      mime: "audio/ogg",
      caption: "Escuta o recado.",
    });
    expect(plano.payload).not.toHaveProperty("caption");
  });
});

describe("send_whatsapp_message — os tipos novos saem pela MESMA cadeia do #2856", () => {
  it("áudio do operador: chega ao handler como `audio`, com URL, MIME e o texto de legenda", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Escuta o recado, {{primeiro_nome}}.", media_url: "https://cdn.exemplo/recado.ogg" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(envio()).toMatchObject({
      conversation_id: CONVERSA,
      type: "audio",
      media_url: "https://cdn.exemplo/recado.ogg",
      media_mime: "audio/ogg",
    });
    // A legenda é o texto da regra renderizado, não a marcação crua.
    expect(String(envio().body)).not.toContain("{{");
    expect(String(envio().body).length).toBeGreaterThan(0);
  });

  it("vídeo curto: chega ao handler como `video`", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Olha o produto.", media_url: "https://cdn.exemplo/produto.mp4" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ type: "video", media_url: "https://cdn.exemplo/produto.mp4", media_mime: "video/mp4" });
  });

  it("documento genérico: chega ao handler como `document`", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Segue a planilha.", media_url: "https://cdn.exemplo/custos.xlsx" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ type: "document", media_url: "https://cdn.exemplo/custos.xlsx" });
  });

  it("CONTROLE: o canal oficial com a janela FECHADA recusa os tipos novos — e o texto não sai sozinho", async () => {
    const trintaHorasAtras = new Date(Date.now() - 30 * HORA).toISOString();
    for (const media_url of [
      "https://cdn.exemplo/recado.ogg",
      "https://cdn.exemplo/produto.mp4",
      "https://cdn.exemplo/custos.xlsx",
    ]) {
      vi.clearAllMocks();
      const r = await executar(
        { channel_session_id: CANAL, template: "Olha isso.", media_url },
        bancoFalso({ provider: "meta_cloud", ultimoInbound: trintaHorasAtras }),
      );

      expect(r.status, media_url).toBe("failed");
      expect(String(r.error), media_url).toMatch(/janela de 24 horas/i);
      expect(sendMessageHandler, media_url).not.toHaveBeenCalled();
      expect(espacarEnvio, media_url).not.toHaveBeenCalled();
    }
  });

  it("CONTROLE: imagem e PDF continuam saindo igual, com a legenda", async () => {
    const imagem = await executar(
      { channel_session_id: CANAL, template: "Olha o catálogo.", media_url: "https://cdn.exemplo/oferta.png" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );
    expect(imagem.status).toBe("success");
    expect(envio()).toMatchObject({ type: "image", media_mime: "image/png" });
    expect(String(envio().body).length).toBeGreaterThan(0);

    vi.clearAllMocks();
    sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
    espacarEnvio.mockResolvedValue(undefined);
    serviceForAutomation.mockResolvedValue(FRONTEIRA);
    assertAgendaEffectSupabase.mockResolvedValue(undefined);
    reportarEnvio.mockImplementation(async (_ctx, type: string) => ({
      type,
      status: "success" as const,
      detail: { message_id: "mensagem-1" },
    }));

    const pdf = await executar(
      { channel_session_id: CANAL, template: "Segue a proposta.", media_url: "https://cdn.exemplo/proposta.pdf" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );
    expect(pdf.status).toBe("success");
    expect(envio()).toMatchObject({ type: "document", media_mime: "application/pdf" });
  });
});

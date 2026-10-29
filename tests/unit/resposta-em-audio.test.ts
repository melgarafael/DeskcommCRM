/**
 * RESPOSTA EM ÁUDIO — quando a IA responde com nota de voz, e o que acontece
 * quando a voz falha (`lib/agent-engine/agent/resposta-em-audio.ts`).
 *
 * Três coisas presas aqui, por comportamento:
 *
 *  1. o PEDIDO: só o que o cliente disse liga o áudio — pedir áudio ou dizer que
 *     não consegue ler —, e o pedido de volta ao texto desliga;
 *  2. o FALLBACK: voz ausente, síntese que falha, upload que falha, áudio vazio
 *     ou texto longo mandam o TEXTO, uma vez, e nunca um áudio;
 *  3. o ENVIO ÚNICO: o áudio tentado não vira um segundo envio em texto, mesmo
 *     quando o canal devolve falha.
 *
 * A síntese e o Storage são dublês: nenhuma chamada sai para a rede.
 */
import { describe, expect, it, vi } from "vitest";

import {
  caminhoDoAudio,
  enviarComoAudio,
  INSTRUCAO_DE_AUDIO,
  MIME_DA_VOZ,
  preferenciaDaMensagem,
  preferenciaDeAudio,
  textoParaFala,
} from "@/lib/agent-engine/agent/resposta-em-audio";
import { FalhaDaVoz } from "@/lib/agent-engine/edge/voz/sintese";

describe("preferenciaDaMensagem — o cliente pediu áudio?", () => {
  it.each([
    "Pode me mandar um áudio?",
    "manda audio por favor",
    "Me explica por áudio, fica mais fácil",
    "responde em áudio",
    "prefiro áudio",
    "Grava um áudio pra mim",
    "dá pra fazer um áudio explicando?",
    "Prefiro por audio",
    "pode ser por áudio?",
    "seria bom um áudio",
  ])("pedido de áudio: %s", (frase) => {
    expect(preferenciaDaMensagem(frase)).toBe("audio");
  });

  it.each([
    "Não sei ler",
    "eu nao consigo ler direito",
    "não tô conseguindo ler, a vista tá ruim",
    "tenho dificuldade para ler",
    "sou analfabeto",
    "Tenho baixa visão",
    "não enxergo bem as letras",
  ])("dificuldade de leitura: %s", (frase) => {
    expect(preferenciaDaMensagem(frase)).toBe("audio");
  });

  it.each([
    "Não manda áudio, estou no trabalho",
    "não precisa mandar audio",
    "não consigo ouvir áudio agora",
    "prefiro texto",
    "pode escrever, por favor",
    "sem áudio, por favor",
  ])("recusa de áudio vence: %s", (frase) => {
    expect(preferenciaDaMensagem(frase)).toBe("texto");
  });

  it.each([
    "Bom dia, quero saber do meu processo",
    "Recebi o áudio, obrigado",
    "não consigo ler o arquivo que você mandou",
    "não consigo ler o pdf",
    "qual o valor da consulta?",
    "",
  ])("não diz nada sobre áudio: %s", (frase) => {
    expect(preferenciaDaMensagem(frase)).toBeNull();
  });
});

describe("preferenciaDeAudio — a mensagem do cliente mais recente decide", () => {
  const m = (direction: "inbound" | "outbound", body: string) => ({ direction, body });

  it("sem pedido na janela, é texto", () => {
    expect(preferenciaDeAudio([m("inbound", "oi"), m("outbound", "Olá!"), m("inbound", "quanto custa?")])).toBe(false);
  });

  it("quem disse que não sabe ler segue recebendo áudio nos turnos seguintes", () => {
    expect(
      preferenciaDeAudio([
        m("inbound", "não sei ler, pode mandar áudio?"),
        m("outbound", "Claro!"),
        m("inbound", "e quanto custa?"),
      ]),
    ).toBe(true);
  });

  it("o pedido de volta ao texto, mais recente, desliga", () => {
    expect(
      preferenciaDeAudio([
        m("inbound", "manda áudio"),
        m("outbound", "Certo"),
        m("inbound", "agora prefiro texto"),
      ]),
    ).toBe(false);
  });

  it("o que a própria IA escreveu não é pedido do cliente", () => {
    expect(preferenciaDeAudio([m("outbound", "Posso te mandar um áudio?"), m("inbound", "oi")])).toBe(false);
  });
});

describe("textoParaFala e o caminho do arquivo", () => {
  it("tira a marcação do WhatsApp sem mudar o conteúdo", () => {
    expect(textoParaFala("*Olá*, _Maria_!\n\n\nO prazo é ~amanhã~ `10h`.")).toBe(
      "Olá, Maria!\nO prazo é amanhã 10h.",
    );
  });

  it("o caminho é da pasta da conversa e determinístico por job e seq", () => {
    const c = caminhoDoAudio({ tenantId: "org", conversationId: "conv", jobId: "job", seq: 2 });
    expect(c).toBe("org/conv/voz-ia-job-2.ogg");
    expect(caminhoDoAudio({ tenantId: "org", conversationId: "conv", jobId: "job", seq: 2 })).toBe(c);
  });

  it("a instrução pede texto falável numa chamada só", () => {
    expect(INSTRUCAO_DE_AUDIO).toMatch(/nota de voz/);
    expect(INSTRUCAO_DE_AUDIO).toMatch(/única chamada de\s+send_message/);
  });

  it("o mime é o da nota de voz que o canal aceita", () => {
    expect(MIME_DA_VOZ).toBe("audio/ogg;codecs=opus");
  });
});

describe("enviarComoAudio — áudio, ou o texto de sempre", () => {
  type R = { kind: string; messageId?: string | null };

  function montar(over: Partial<Parameters<typeof enviarComoAudio<R>>[1]> = {}) {
    const log = { info: vi.fn(), warn: vi.fn() };
    const enviarAudio = vi.fn(async (): Promise<R> => ({ kind: "sent", messageId: "m-audio" }));
    const enviarTexto = vi.fn(async (): Promise<R> => ({ kind: "sent", messageId: "m-texto" }));
    const guardar = vi.fn(async () => {});
    const sintetizar = vi.fn(async () => Buffer.from("OggS-fake-opus"));
    const opts = {
      sintetizar,
      guardar,
      caminho: "org/conv/voz-ia-job-1.ogg",
      enviarAudio,
      enviarTexto,
      log,
      ...over,
    };
    return { opts, log, enviarAudio, enviarTexto, guardar, sintetizar };
  }

  it("caminho feliz: sintetiza o texto falável, guarda e manda UM áudio", async () => {
    const t = montar();
    const r = await enviarComoAudio("*Olá*, tudo certo com o seu processo.", t.opts);
    expect(r).toEqual({ kind: "sent", messageId: "m-audio" });
    expect(t.sintetizar).toHaveBeenCalledWith("Olá, tudo certo com o seu processo.");
    expect(t.guardar).toHaveBeenCalledWith("org/conv/voz-ia-job-1.ogg", Buffer.from("OggS-fake-opus"));
    expect(t.enviarAudio).toHaveBeenCalledTimes(1);
    expect(t.enviarAudio).toHaveBeenCalledWith("org/conv/voz-ia-job-1.ogg");
    expect(t.enviarTexto).not.toHaveBeenCalled();
  });

  it("voz não configurada: texto, motivo no log, nada sintetizado", async () => {
    const t = montar({ sintetizar: null, motivoSemVoz: "nao_configurada" });
    await enviarComoAudio("Oi", t.opts);
    expect(t.enviarTexto).toHaveBeenCalledWith("Oi");
    expect(t.enviarAudio).not.toHaveBeenCalled();
    expect(t.guardar).not.toHaveBeenCalled();
    expect(t.log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "resposta_em_audio_fallback", motivo: "nao_configurada" }),
    );
  });

  it.each([
    ["erro HTTP da API", () => Promise.reject(new FalhaDaVoz("http", 403)), "http"],
    ["falha de rede", () => Promise.reject(new FalhaDaVoz("rede")), "rede"],
    ["áudio vazio", () => Promise.resolve(Buffer.alloc(0)), "audio_vazio"],
  ])("%s: texto, nunca áudio vazio", async (_nome, sintetizar, motivo) => {
    const t = montar({ sintetizar });
    await enviarComoAudio("Oi", t.opts);
    expect(t.enviarTexto).toHaveBeenCalledTimes(1);
    expect(t.enviarAudio).not.toHaveBeenCalled();
    expect(t.guardar).not.toHaveBeenCalled();
    expect(t.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ motivo }));
  });

  it("upload que falha: texto, e o áudio não é enviado sem arquivo", async () => {
    const t = montar({ guardar: vi.fn(async () => Promise.reject(new Error("bucket fora"))) });
    await enviarComoAudio("Oi", t.opts);
    expect(t.enviarTexto).toHaveBeenCalledTimes(1);
    expect(t.enviarAudio).not.toHaveBeenCalled();
    expect(t.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ motivo: "armazenamento" }));
  });

  it("texto longo demais para um áudio: texto, sem chamar a síntese", async () => {
    const t = montar();
    await enviarComoAudio("a".repeat(4600), t.opts);
    expect(t.sintetizar).not.toHaveBeenCalled();
    expect(t.enviarTexto).toHaveBeenCalledTimes(1);
  });

  it("o canal falhou o áudio: o desfecho volta como está, sem segundo envio em texto", async () => {
    const t = montar({ enviarAudio: vi.fn(async (): Promise<R> => ({ kind: "failed", messageId: "m" })) });
    const r = await enviarComoAudio("Oi", t.opts);
    expect(r.kind).toBe("failed");
    expect(t.enviarTexto).not.toHaveBeenCalled();
  });

  it("o log do fallback não leva o texto do cliente nem a resposta", async () => {
    const t = montar({ sintetizar: vi.fn(async () => Promise.reject(new FalhaDaVoz("http", 500))) });
    await enviarComoAudio("Seu CPF 123.456.789-00 foi recebido", t.opts);
    const registrado = JSON.stringify([...t.log.warn.mock.calls, ...t.log.info.mock.calls]);
    expect(registrado).not.toContain("123.456.789-00");
  });
});

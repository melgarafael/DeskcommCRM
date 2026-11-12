import { describe, expect, it, vi, beforeEach } from "vitest";

const { resolveOrgLlmConfigMock, aplicarOrcamentoMock, chaveDaTelaMock } = vi.hoisted(() => ({
  resolveOrgLlmConfigMock: vi.fn(),
  aplicarOrcamentoMock: vi.fn(),
  chaveDaTelaMock: vi.fn(),
}));

vi.mock("@/lib/instalacao/comportamento", () => ({ chaveDeOrcamentoDaInstalacao: chaveDaTelaMock }));

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: resolveOrgLlmConfigMock,
}));

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  aplicarOrcamento: aplicarOrcamentoMock,
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {
    constructor() {
      super("llm_budget_exceeded");
      this.name = "LlmBudgetExceededError";
    }
  },
}));

import { resolverVozDoTurno } from "@/lib/agent-engine/agent/voz-do-turno";
import { textosDoClienteNoHistorico, type MensagemDoHistorico } from "@/lib/agent-engine/agent/pedido-de-audio";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";

function pool(settings: Record<string, unknown> | null = { voz: { voice_id: "v1" } }) {
  return { query: vi.fn(async () => ({ rows: [{ settings }] })) } as never;
}

const base = { pool: pool(), tenantId: "org1", cfg: {}, voiceNote: "server-convert" as const };

beforeEach(() => {
  resolveOrgLlmConfigMock.mockReset();
  aplicarOrcamentoMock.mockReset();
  // Default: orçamento OK (não lança) — cada teste de orçamento sobrescreve.
  aplicarOrcamentoMock.mockResolvedValue(undefined);
  // Default: nada gravado na tela de admin — vale o piso que vem do env.
  chaveDaTelaMock.mockReset();
  chaveDaTelaMock.mockImplementation((piso: string) => piso);
});

describe("resolverVozDoTurno", () => {
  it("voz_enabled=false: nunca fala, nem consulta o banco", async () => {
    const db = pool();
    const r = await resolverVozDoTurno({
      ...base,
      pool: db,
      vozEnabled: false,
      vozQuando: "sempre",
      inboundType: "audio",
    });
    expect(r).toBeNull();
    expect((db as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it("canal que só aceita opus (o oficial): FALA, e pede a síntese em ogg/opus — o mp3 chegaria como anexo", async () => {
    // Até 02/11/2026 este caso devolvia `null` (texto sempre no número oficial).
    // A ElevenLabs sintetiza em opus num contêiner OGG (medido), então o canal
    // oficial também recebe nota de voz — desde que o formato venha daqui.
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk_elevenlabs" });
    const r = await resolverVozDoTurno({
      ...base,
      voiceNote: "opus-only",
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: "audio",
    });
    expect(r).toMatchObject({ apiKey: "sk_elevenlabs", voiceId: "v1", formato: "ogg_opus" });
  });

  it("canal que converte (o pareado) segue em mp3", async () => {
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk_elevenlabs" });
    const r = await resolverVozDoTurno({ ...base, vozEnabled: true, vozQuando: "sempre", inboundType: "audio" });
    expect(r).toMatchObject({ formato: "mp3" });
  });

  it("id que não está em catálogo nenhum: o turno usa o que está salvo, sem 'corrigir' (#4260)", async () => {
    // A razão do pedido: o cliente tem vozes próprias na conta ElevenLabs e
    // elas nunca apareceram na lista derivada da validação da credencial. Se o
    // turno filtrasse por lista, salvar um id livre não teria efeito nenhum.
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "chave-de-teste" });
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool({ voz: { voice_id: "vozPropriaDoCliente123" } }),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: "text",
    });
    expect(r).toMatchObject({ voiceId: "vozPropriaDoCliente123" });
  });

  it("vozQuando='nunca': não fala mesmo com voz_enabled=true", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "nunca",
      inboundType: "audio",
    });
    expect(r).toBeNull();
  });

  it("vozQuando='espelhar' e o cliente mandou TEXTO: não fala", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "espelhar",
      inboundType: "text",
    });
    expect(r).toBeNull();
  });

  it("vozQuando='espelhar' e o cliente mandou ÁUDIO: resolve a voz", async () => {
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk_elevenlabs" });
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool({ voz: { voice_id: "v1", model_id: "eleven_turbo_v2" } }),
      vozEnabled: true,
      vozQuando: "espelhar",
      inboundType: "audio",
    });
    expect(r).toEqual({ apiKey: "sk_elevenlabs", voiceId: "v1", modelId: "eleven_turbo_v2", formato: "mp3" });
    expect(resolveOrgLlmConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      {},
      "org1",
      { provider: "elevenlabs" },
    );
    // O gate de orçamento precisa ser CHAMADO — achado na revisão de código:
    // antes, a voz nunca passava por ele, e uma org sem teto continuava
    // chamando o ElevenLabs sem parar e sem avisar.
    expect(aplicarOrcamentoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        purpose: "sintese_de_voz",
        provider: "elevenlabs",
        model: "eleven_turbo_v2",
      }),
    );
  });

  it("vozQuando='sempre' sem mensagem inbound nenhuma (ex.: follow-up proativo): ainda fala", async () => {
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).not.toBeNull();
  });

  it("sem voice_id configurado (Fase 7 não existe ainda): fala em texto, não trava", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool({}),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).toBeNull();
    expect(resolveOrgLlmConfigMock).not.toHaveBeenCalled();
  });

  it("sem credencial ElevenLabs cadastrada: fala em texto, não lança", async () => {
    resolveOrgLlmConfigMock.mockRejectedValue(new Error("llm_not_configured"));
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).toBeNull();
  });

  it("falha de rede ao resolver credencial: fala em texto, não lança", async () => {
    resolveOrgLlmConfigMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).toBeNull();
  });

  describe("gate de orçamento", () => {
    it("orçamento esgotado: fala em texto, não lança — o aviso crítico já abriu dentro do gate", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      aplicarOrcamentoMock.mockRejectedValue(new LlmBudgetExceededError());

      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });

      expect(r).toBeNull();
    });

    it("chave de enforcement vem de cfg.budgetEnforcement, não hardcoded", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      await resolverVozDoTurno({
        ...base,
        cfg: { budgetEnforcement: "avisar" },
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(aplicarOrcamentoMock).toHaveBeenCalledWith(
        expect.objectContaining({ chave: "avisar" }),
      );
    });

    it("o interruptor da tela de admin vence o env, como no chat", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      chaveDaTelaMock.mockReturnValue("off");
      await resolverVozDoTurno({
        ...base,
        cfg: { budgetEnforcement: "on" },
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(chaveDaTelaMock).toHaveBeenCalledWith("on");
      expect(aplicarOrcamentoMock).toHaveBeenCalledWith(expect.objectContaining({ chave: "off" }));
    });

    it("sem cfg.budgetEnforcement, usa 'on' — o kill switch só AFROUXA, nunca força desligado por omissão", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      await resolverVozDoTurno({
        ...base,
        cfg: {},
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(aplicarOrcamentoMock).toHaveBeenCalledWith(expect.objectContaining({ chave: "on" }));
    });

    it("erro de orçamento que NÃO é LlmBudgetExceededError ainda cai pra texto (defesa contra erro inesperado)", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      aplicarOrcamentoMock.mockRejectedValue(new Error("boom"));
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(r).toBeNull();
    });
  });

  /**
   * #4345 — o quarto comportamento: falar quando o CLIENTE PEDIR.
   *
   * `espelhar` continua o PADRÃO e continua lendo só o canal (os controles
   * positivos no fim deste bloco são os mesmos casos de hoje, sem uma linha de
   * diferença). O modo novo acrescenta UMA leitura: o texto do turno. Quem pediu
   * por escrito recebe áudio; quem pediu texto — ou avisou que não consegue
   * ouvir — segue em texto, mesmo tendo mandado áudio.
   */
  describe("vozQuando='quando_pede' (#4345)", () => {
    it("cliente ESCREVEU pedindo áudio: fala", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "text",
        inboundText: "não consigo ler, me manda áudio",
      });
      expect(r).toMatchObject({ voiceId: "v1" });
    });

    it("cliente avisou que NÃO CONSEGUE LER, sem pedir explicitamente: fala", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "text",
        inboundText: "não consigo ler as mensagens",
      });
      expect(r).toMatchObject({ voiceId: "v1" });
    });

    it("cliente mandou ÁUDIO: continua falando (o modo soma espelhar + pedido)", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "audio",
        inboundText: null,
      });
      expect(r).toMatchObject({ voiceId: "v1" });
    });

    it("cliente escreveu sem pedir nada: TEXTO", async () => {
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "text",
        inboundText: "qual o horário de funcionamento?",
      });
      expect(r).toBeNull();
    });

    it("cliente pediu para continuar no texto: TEXTO, mesmo com 'áudio' na frase", async () => {
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "text",
        inboundText: "não consigo ler o boleto, pode escrever",
      });
      expect(r).toBeNull();
    });

    it("cliente MANDOU ÁUDIO dizendo que prefere texto: TEXTO — o pedido vence o espelho", async () => {
      // A credencial VALE aqui de propósito: sem ela o caminho espelhado já
      // devolveria `null` por falta de chave, e o caso passaria sem medir a
      // leitura do turno (o teste ficaria verde com o defeito plantado).
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "audio",
        inboundText: "prefiro texto, por favor",
      });
      expect(r).toBeNull();
    });
  });

  /**
   * A CONVERSA (#4345) — o arremate pedido pelo mantenedor em 12/11.
   *
   * A decisão não olha a mensagem atual: olha a janela de textos do cliente que
   * o turno já carrega. Estes dois casos são de CONVERSA, não de frase — é a
   * diferença entre "quem escreveu que não lê recebe áudio" e "quem escreveu que
   * não lê continua recebendo áudio na mensagem seguinte".
   */
  describe("vozQuando='quando_pede': a conversa, não a mensagem (#4345)", () => {
    function conversa(mensagens: MensagemDoHistorico[], atual: string): string[] {
      return textosDoClienteNoHistorico(mensagens, atual);
    }

    it("pedido de áudio de duas mensagens atrás continua valendo no turno de agora", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const textos = conversa(
        [
          { direction: "inbound", body: "oi, boa tarde" },
          { direction: "inbound", body: "não sei ler, manda áudio" },
          { direction: "outbound", body: "Claro! Te mando por áudio." },
          { direction: "inbound", body: "e quanto custa?" },
        ],
        "e quanto custa?",
      );
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "text",
        inboundTexts: textos,
      });
      expect(r).toMatchObject({ voiceId: "v1" });
    });

    it("'prefiro texto' depois do pedido volta ao texto", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const textos = conversa(
        [
          { direction: "inbound", body: "não sei ler, manda áudio" },
          { direction: "outbound", body: "Te mando por áudio." },
          { direction: "inbound", body: "pensando bem, prefiro texto" },
        ],
        "pensando bem, prefiro texto",
      );
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "quando_pede",
        inboundType: "text",
        inboundTexts: textos,
      });
      expect(r).toBeNull();
    });
  });

  /**
   * CONTROLE POSITIVO dos três modos que já existiam: os mesmos casos de hoje,
   * com o texto do turno preenchido de propósito. Se o modo novo tivesse
   * vazado para dentro de `espelhar`/`nunca`/`sempre`, é aqui que apareceria.
   */
  describe("controle positivo: nunca/espelhar/sempre não mudam", () => {
    it("'espelhar' com pedido por escrito continua TEXTO (a leitura não vaza)", async () => {
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "espelhar",
        inboundType: "text",
        inboundText: "não consigo ler, me manda áudio",
      });
      expect(r).toBeNull();
    });

    it("'espelhar' com áudio do cliente continua falando", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "espelhar",
        inboundType: "audio",
        inboundText: "prefiro texto",
      });
      expect(r).toMatchObject({ voiceId: "v1" });
    });

    it("'nunca' continua calado com pedido por escrito E com áudio do cliente", async () => {
      const porEscrito = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "nunca",
        inboundType: "text",
        inboundText: "não consigo ler, me manda áudio",
      });
      const comAudio = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "nunca",
        inboundType: "audio",
        inboundText: null,
      });
      expect(porEscrito).toBeNull();
      expect(comAudio).toBeNull();
    });

    it("'sempre' continua falando com texto sem pedido", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: "text",
        inboundText: "qual o horário de funcionamento?",
      });
      expect(r).toMatchObject({ voiceId: "v1" });
    });
  });
});

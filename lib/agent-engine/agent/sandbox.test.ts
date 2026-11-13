/**
 * O TESTE DO AGENTE É UMA CONVERSA (#4424).
 *
 * O "Testar agente" testava UMA mensagem por vez: cada disparo ia ao motor
 * sozinho, e não dava para ver o cliente levantar objeção, mudar de assunto ou
 * voltar ao preço. Esta fatia faz o turno novo viajar com os anteriores — sem
 * tabela nova, o rascunho vive no estado da tela e chega no corpo da requisição.
 *
 * O que este arquivo vigia:
 *
 *   1. a conversa chega ao motor NA ORDEM, com a mensagem nova por último;
 *   2. ela passa pelas MESMAS duas peneiras do turno real — a janela de
 *      mensagens da versão (`history_message_window`) e o orçamento de tokens
 *      (`history_token_window`) —, senão o teste viraria custo ilimitado;
 *   3. o corpo SEM histórico continua funcionando exatamente como antes.
 *
 * NÃO MEDIDO aqui: o modelo, as ferramentas e o custo de cada turno — o motor
 * de prévia é substituído por um dublê, porque o alvo é o recorte do contexto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const carregarConfig = vi.hoisted(() => vi.fn());
const rodarPrevia = vi.hoisted(() => vi.fn());

vi.mock("./agent-config", () => ({ loadAgentVersionConfig: carregarConfig }));
// `preview.ts` importa estas duas do mesmo módulo; o dublê precisa oferecê-las
// para o grafo carregar. O alvo do teste é o contexto montado, não a agenda.
vi.mock("./inbound-turn", () => ({
  runAgentPreview: rodarPrevia,
  ferramentasDeAgendaDoAgente: () => [],
  temFerramentaDeAgenda: () => false,
}));

import { testAgentVersion } from "./sandbox";

const POOL = {} as never;
const DEPS = { clock: () => new Date("2026-11-11T12:00:00.000Z") } as never;

type Mensagem = { direction: "inbound" | "outbound"; body: string };
type History = Array<{ direction: "inbound" | "outbound"; body: string }>;

function agente(extra: Record<string, unknown> = {}) {
  return { historyMessageWindow: 20, historyTokenWindow: 8000, ...extra } as never;
}

/** Roda a prévia e devolve as mensagens que chegaram ao motor. */
async function contextoDoTurno(history: History | undefined, config = agente()): Promise<Mensagem[]> {
  carregarConfig.mockResolvedValue(config);
  await testAgentVersion(POOL, DEPS, {
    organizationId: "org-1",
    agentId: "agente-1",
    versionId: "versao-1",
    runId: "run-1",
    sampleMessage: "e o prazo de entrega?",
    history,
    channelId: null,
  });
  const chamada = rodarPrevia.mock.calls.at(-1);
  return chamada?.[2].context.context.messages as Mensagem[];
}

describe("testAgentVersion — a conversa do teste chega ao motor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leva os turnos anteriores na ordem e a mensagem nova por último", async () => {
    const mensagens = await contextoDoTurno([
      { direction: "inbound", body: "quanto custa o clareamento?" },
      { direction: "outbound", body: "O clareamento custa R$ 600." },
      { direction: "inbound", body: "e quantas sessões são?" },
      { direction: "outbound", body: "São três sessões." },
    ]);

    expect(mensagens.map((m) => [m.direction, m.body])).toEqual([
      ["inbound", "quanto custa o clareamento?"],
      ["outbound", "O clareamento custa R$ 600."],
      ["inbound", "e quantas sessões são?"],
      ["outbound", "São três sessões."],
      ["inbound", "e o prazo de entrega?"],
    ]);
  });

  it("a janela de mensagens da versão corta os turnos mais antigos, nunca o novo", async () => {
    const mensagens = await contextoDoTurno(
      [
        { direction: "inbound", body: "um" },
        { direction: "outbound", body: "dois" },
        { direction: "inbound", body: "três" },
        { direction: "outbound", body: "quatro" },
      ],
      agente({ historyMessageWindow: 3 }),
    );

    expect(mensagens.map((m) => m.body)).toEqual(["três", "quatro", "e o prazo de entrega?"]);
    expect(mensagens.at(-1)?.direction).toBe("inbound");
  });

  it("o orçamento de tokens da versão corta o começo da conversa", async () => {
    const longa = "x".repeat(3000);
    const mensagens = await contextoDoTurno(
      [
        { direction: "inbound", body: longa },
        { direction: "outbound", body: "resposta curta" },
      ],
      agente({ historyTokenWindow: 50 }),
    );

    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]?.body).toBe("e o prazo de entrega?");
  });

  it("sem histórico, o turno leva só a mensagem nova (retrocompatível)", async () => {
    const mensagens = await contextoDoTurno(undefined);

    expect(mensagens).toEqual([
      expect.objectContaining({ direction: "inbound", body: "e o prazo de entrega?" }),
    ]);
  });
});

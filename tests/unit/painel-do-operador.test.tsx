import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PainelDoOperador } from "@/app/app/ai/agents/[id]/_components/PainelDoOperador";
import { apiClient } from "@/lib/api/client";

/**
 * Dublê POR URL, não por ordem de chamada: o painel e o ModelPicker buscam no
 * mesmo tick, e um `mockResolvedValueOnce` global seria consumido por quem
 * chegasse primeiro — teste que passa ou falha por corrida.
 */
const METRICAS_VAZIAS = {
  dias: 30,
  turnos: 0,
  agiu: 0,
  promessas: { declaradas: 0, assumidas: 0, semDono: 0 },
  quisAgirENaoPode: 0,
};
let metricas: unknown = METRICAS_VAZIAS;

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) =>
      url.includes("operator-metrics") ? { data: metricas } : { data: [] },
    ),
    put: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

/**
 * O painel do papel Operador (spec 16 §6).
 *
 * O que estes casos guardam não é layout — é **disciplina de informação**. A
 * spec pede que nada passe batido para quem configura, e a régua concreta disso
 * é: a tela diz a CONSEQUÊNCIA de uma escolha, não o nome interno da feature.
 * "Desabilitar agente operador" não informa nada a um dono de clínica.
 */
function renderPainel(overrides: Partial<React.ComponentProps<typeof PainelDoOperador>> = {}) {
  const props: React.ComponentProps<typeof PainelDoOperador> = {
    enabled: false,
    onEnabledChange: vi.fn(),
    model: "",
    onModelChange: vi.fn(),
    provider: "anthropic",
    toolIds: [],
    onToolIdsChange: vi.fn(),
    modeloDoConversador: "claude-sonnet-4-6",
    // A medida do papel é do agente DESTA página (ver
    // `operador-metrica-e-do-agente-da-tela.test.ts`): sem o id, o painel não
    // tem o que pedir.
    agentId: "aaaaaaaa-0000-4000-8000-00000000000a",
    ...overrides,
  };
  // O ModelPicker busca modelos por react-query; sem o provider ele estoura.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PainelDoOperador {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe("painel do Operador — disciplina de informação", () => {
  it("DESLIGADO: a tela diz o que se perde, antes de a pessoa decidir", () => {
    renderPainel({ enabled: false });
    const aviso = screen.getByTestId("operador-consequencia");
    // O que CONTINUA acontecendo (decisão da spec 16 §2.1: desligar não desliga
    // o registro básico). Sem esta frase, o usuário conclui que desligar deixa o
    // sistema cego — e liga por medo, não por escolha.
    expect(aviso.textContent).toMatch(/continua atendendo/i);
    expect(aviso.textContent).toMatch(/registrado sozinho/i);
    // E o que PARA de acontecer.
    expect(aviso.textContent).toMatch(/decidir sobre a operação/i);
  });

  it("DESLIGADO: não mostra configuração que não vai valer", () => {
    renderPainel({ enabled: false });
    // Mostrar modelo e capacidades de um papel desligado convida a pessoa a
    // configurar algo que nunca roda — e a concluir que o produto está quebrado
    // quando nada acontece.
    expect(screen.queryByTestId("operador-capacidades")).toBeNull();
  });

  it("LIGADO: mostra o que ele pode mexer, e diz que é lista SÓ dele", () => {
    renderPainel({ enabled: true });
    expect(screen.getByTestId("operador-capacidades")).toBeTruthy();
    // A frase que impede o modelo mental errado: o usuário precisa saber que
    // isto não é a mesma lista da aba de conversa.
    expect(screen.getByText(/só deste papel/i)).toBeTruthy();
  });

  it("LIGADO e sem capacidade: explica que ainda serve para algo", () => {
    renderPainel({ enabled: true, toolIds: [] });
    // Estado legítimo (o papel ainda avisa promessa não cumprida). Sem esta
    // frase o usuário liga, não marca nada, e conclui que quebrou.
    expect(screen.getByTestId("operador-sem-capacidade").textContent).toMatch(/prometer algo/i);
  });

  it("o texto NÃO usa o nosso vocabulário interno", () => {
    renderPainel({ enabled: true });
    // "Operador", "papel", "tool", "MCP" são como NÓS chamamos as coisas. Quem
    // configura é dono de clínica, de loja, de imobiliária.
    const corpo = document.body.textContent ?? "";
    for (const jargao of ["MCP", "tool_ids", "operator_", "job", "payload"]) {
      expect(corpo, `vocabulário interno na tela: ${jargao}`).not.toContain(jargao);
    }
  });

  it("o modelo herdado tem NOME, e o caminho de volta existe", async () => {
    // Um Select não oferece "nenhum" como item. Sem o botão, escolher um modelo
    // seria de mão única — e o usuário não teria como saber por quê.
    const props = renderPainel({ enabled: true, model: "claude-haiku-4-5-20251001" });
    const voltar = screen.getByTestId("operador-modelo-herdar");
    await userEvent.click(voltar);
    expect(props.onModelChange).toHaveBeenCalledWith("");
  });

  it("sem modelo escolhido, não oferece o botão de voltar — não há para onde voltar", () => {
    renderPainel({ enabled: true, model: "" });
    expect(screen.queryByTestId("operador-modelo-herdar")).toBeNull();
  });

  it("ligar e desligar chega a quem salva", async () => {
    const props = renderPainel({ enabled: false });
    await userEvent.click(screen.getByTestId("operador-liga"));
    expect(props.onEnabledChange).toHaveBeenCalledWith(true);
  });
});

/**
 * O RETORNO DO PAPEL — o que a auditoria disse não existir.
 *
 * O painel era 100% formulário: dizia o que o papel FARIA e nada sobre o que fez.
 * As três medidas que a spec 16 §7 prometeu ("taxa de ação por turno, promessas
 * declaradas vs quitadas, turnos em que quis agir e não pôde") não tinham nem
 * dado nem tela — e "se ele parar de agir, alguém vê" era falso.
 */
describe("o papel funcionando aparece na tela", () => {
  it("com o papel DESLIGADO não pergunta nem mostra — não há o que medir", () => {
    renderPainel({ enabled: false });
    expect(screen.queryByTestId("operador-como-esta-indo")).toBeNull();
  });

  it("zero conversas não vira '0' cru — num papel recém-ligado isso é o esperado", async () => {
    // Número solto num painel de configuração parece falha. A frase diz que o
    // estado é normal e o que vai acontecer.
    metricas = { dias: 30, turnos: 0, agiu: 0, promessas: { declaradas: 0, assumidas: 0, semDono: 0 }, quisAgirENaoPode: 0 };
    renderPainel({ enabled: true });
    const bloco = await screen.findByTestId("operador-como-esta-indo");
    expect(bloco.textContent).toContain("Nenhuma conversa passou por aqui");
    expect(bloco.textContent).not.toMatch(/\b0 de 0\b/);
  });

  it("cada número responde 'e daí?' — e o que pede configuração diz onde", async () => {
    metricas = {
        dias: 30,
        turnos: 40,
        agiu: 31,
        promessas: { declaradas: 12, assumidas: 9, semDono: 3 },
        quisAgirENaoPode: 2,
      };
    renderPainel({ enabled: true });

    expect((await screen.findByTestId("operador-metrica-acao")).textContent).toContain("31");
    const promessas = screen.getByTestId("operador-metrica-promessas");
    // "assumidas", nunca "cumpridas": o sistema não apura cumprimento.
    expect(promessas.textContent).toContain("responsável");
    expect(promessas.textContent?.toLowerCase()).not.toContain("cumprid");
    // O único número que aponta ação de configuração vem com o caminho.
    expect(screen.getByTestId("operador-metrica-sem-mao").textContent).toContain("marcar abaixo");
  });

  it("pede a medida do agente DESTA página, não da organização", async () => {
    // O agregado da organização na página de um agente manda configurar o agente
    // errado. Ver `operador-metrica-e-do-agente-da-tela.test.ts`.
    renderPainel({ enabled: true, agentId: "aaaaaaaa-0000-4000-8000-0000000000ff" });
    await screen.findByTestId("operador-como-esta-indo");
    const urls = vi.mocked(apiClient.get).mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.includes("operator-metrics"))).toContain(
      "/api/v1/ai/operator-metrics?agent_id=aaaaaaaa-0000-4000-8000-0000000000ff",
    );
  });

  it("sem agente (agente ainda não criado) não pergunta — não há de quem medir", () => {
    vi.mocked(apiClient.get).mockClear();
    renderPainel({ enabled: true, agentId: null });
    expect(vi.mocked(apiClient.get).mock.calls.some(([url]) => String(url).includes("operator-metrics"))).toBe(false);
  });

  it("sem promessa órfã, não inventa alarme", async () => {
    metricas = { dias: 30, turnos: 10, agiu: 10, promessas: { declaradas: 4, assumidas: 4, semDono: 0 }, quisAgirENaoPode: 0 };
    renderPainel({ enabled: true });
    await screen.findByTestId("operador-metrica-promessas");
    expect(screen.queryByTestId("operador-metrica-sem-mao")).toBeNull();
  });
});

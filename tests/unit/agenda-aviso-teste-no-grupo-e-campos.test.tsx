/**
 * A TELA DO AVISO DE AGENDAMENTO — os três ajustes que o dono pediu depois da
 * prova pela tela (issue #1):
 *
 * 1. "Enviar teste" diz que foi também para o grupo, e qual grupo;
 * 2. o número sem +55 ganha um aviso que não bloqueia;
 * 3. o botão "Receber avisos" travado diz o que falta.
 *
 * As regras puras estão em `lib/agenda/rascunho-do-aviso-de-agendamento.test.ts`
 * e `lib/agenda/teste-do-aviso-de-agendamento.test.ts`; este arquivo prova a
 * fiação na tela. Os hooks são mocados; o componente é renderizado de verdade.
 *
 * Roda com: pnpm vitest run tests/unit/agenda-aviso-teste-no-grupo-e-campos.test.tsx
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResultadoDoTesteDeAgendamento } from "@/hooks/agenda/useAvisoDeAgendamento";
import type { EstadoDaTelaDoAvisoDeAgendamento } from "@/lib/agenda/tela-do-aviso-de-agendamento";

const { consulta, testar, toast, resultado } = vi.hoisted(() => ({
  consulta: vi.fn(),
  testar: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  resultado: { atual: undefined as ResultadoDoTesteDeAgendamento | undefined },
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/hooks/agenda/useAvisoDeAgendamento", () => ({
  CHAVE_DO_AVISO_DE_AGENDAMENTO: ["agenda-aviso-de-agendamento"],
  useAvisoDeAgendamento: () => consulta(),
  useGruposDaConexao: (id: string | null) => ({
    data: id ? [{ chatId: GRUPO, subject: "Equipe da agenda", presente: true }] : [],
    isLoading: false,
    isError: false,
  }),
  useSalvarAvisoDeAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestarAvisoDeAgendamento: () => ({ mutateAsync: testar, isPending: false, data: resultado.atual }),
}));

import { AvisoDeAgendamento } from "@/app/app/agenda/avisos/_components/AvisoDeAgendamento";

const CONEXAO = "11111111-1111-4111-8111-111111111111";
const GRUPO = "120363000000000001@g.us";

function estado(config: Partial<NonNullable<EstadoDaTelaDoAvisoDeAgendamento["config"]>> | null = {}) {
  return {
    config:
      config === null
        ? null
        : {
            usa_numero_do_aviso_de_caso: false,
            channel_session_id: CONEXAO,
            telefone: "+5531998966398",
            grupo: GRUPO,
            ligado: true,
            atualizado_em: "2026-10-25T12:00:00.000Z",
            ...config,
          },
    aviso_de_caso: null,
    conexoes: [{ id: CONEXAO, nome: "Agenda", status: "WORKING", aceitaMensagemLivre: true }],
    entregas: [],
    fuso: "America/Sao_Paulo",
  } as EstadoDaTelaDoAvisoDeAgendamento;
}

function montar(e: EstadoDaTelaDoAvisoDeAgendamento = estado()) {
  consulta.mockReturnValue({ data: e, isLoading: false, error: null });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AvisoDeAgendamento />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resultado.atual = undefined;
});
afterEach(cleanup);

describe("'Enviar teste' diz para onde foi", () => {
  it("número e grupo: a mensagem fala dos dois e a linha nomeia o grupo", async () => {
    const r: ResultadoDoTesteDeAgendamento = { enviado: true, destinoMascarado: "••••6398", grupo: { enviado: true } };
    testar.mockResolvedValue(r);
    resultado.atual = r;
    montar();

    fireEvent.click(screen.getByRole("button", { name: /Enviar teste/ }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Aviso de teste enviado ao número e ao grupo. Confira o WhatsApp."),
    );
    expect(screen.getByTestId("teste-enviado-para").textContent).toBe(
      "Enviado para ••••6398 e para o grupo Equipe da agenda",
    );
  });

  it("grupo que falhou: o número segue enviado e a falha do grupo aparece à parte", async () => {
    testar.mockResolvedValue({
      enviado: true,
      destinoMascarado: "••••6398",
      grupo: { enviado: false, codigo: "falha_no_envio" },
    } satisfies ResultadoDoTesteDeAgendamento);
    montar();

    fireEvent.click(screen.getByRole("button", { name: /Enviar teste/ }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Aviso de teste enviado. Confira o WhatsApp desse número."),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0]?.[0])).toMatch(/^O teste não chegou ao grupo\. /);
  });

  // QA v3: o número não saiu e o grupo saiu — a tela não pode esconder o
  // grupo atrás do erro do número, nem dizer "Enviado para" um número que não recebeu.
  it("número que não saiu e grupo que saiu: o erro do número e o envio ao grupo aparecem os dois", async () => {
    const r: ResultadoDoTesteDeAgendamento = {
      enviado: false,
      codigo: "falha_no_envio",
      grupo: { enviado: true },
    };
    testar.mockResolvedValue(r);
    resultado.atual = r;
    montar();

    fireEvent.click(screen.getByRole("button", { name: /Enviar teste/ }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Aviso de teste enviado ao grupo. Confira o WhatsApp."),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0]?.[0])).not.toMatch(/grupo/);
    expect(screen.getByTestId("teste-enviado-para").textContent).toBe("Enviado para o grupo Equipe da agenda");
  });

  it("controle: sem grupo salvo, a linha fala só do número", () => {
    resultado.atual = { enviado: true, destinoMascarado: "••••6398", grupo: null };
    montar(estado({ grupo: null }));
    expect(screen.getByTestId("teste-enviado-para").textContent).toBe("Enviado para ••••6398");
  });
});

describe("o número sem +55 ganha um aviso que não bloqueia", () => {
  it("número de outro país mostra a pergunta e o Salvar continua livre", () => {
    montar(estado({ telefone: "+15551234567" }));
    expect(screen.getByTestId("telefone-fora-do-brasil").textContent).toContain("Ele é de fora do Brasil?");
    expect(screen.getByRole("button", { name: "Salvar" })).not.toHaveProperty("disabled", true);
  });

  it("controle: número com +55 não mostra a pergunta", () => {
    montar();
    expect(screen.queryByTestId("telefone-fora-do-brasil")).toBeNull();
  });
});

describe("o botão 'Receber avisos' travado diz o que falta", () => {
  it("sem configuração: faltam a conexão e o número", () => {
    montar(estado(null));
    expect(screen.getByRole("switch", { name: "Receber avisos de agendamento no WhatsApp" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("o-que-falta-para-ligar").textContent).toBe(
      "Para ligar, escolha a conexão que envia e preencha o número que recebe os avisos.",
    );
  });

  it("número incompleto: falta o número", () => {
    montar(estado({ telefone: "+55319" }));
    expect(screen.getByTestId("o-que-falta-para-ligar").textContent).toBe(
      "Para ligar, preencha o número completo que recebe os avisos.",
    );
  });

  it("número completo e nenhuma conexão escolhida: falta só a conexão", () => {
    montar(estado({ channel_session_id: null, grupo: null }));
    expect(screen.getByRole("switch", { name: "Receber avisos de agendamento no WhatsApp" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("o-que-falta-para-ligar").textContent).toBe(
      "Para ligar, escolha a conexão que envia os avisos.",
    );
  });

  it("controle: com conexão e número, nada aparece", () => {
    montar();
    expect(screen.queryByTestId("o-que-falta-para-ligar")).toBeNull();
  });
});

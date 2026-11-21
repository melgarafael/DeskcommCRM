/**
 * A TELA DO AVISO DE AGENDAMENTO — "Enviar o resumo do dia só quando houver
 * agendamento" (#4988, migration 9434).
 *
 * A regra do dia vazio está em `lib/agenda/aviso-de-agendamento.test.ts`; este
 * arquivo prova a fiação na tela: o interruptor mostra a escolha salva, o
 * Salvar a leva no corpo do PUT, e desligar os avisos não apaga a escolha.
 * Os hooks são mocados; o componente é renderizado de verdade.
 *
 * Roda com: pnpm vitest run tests/unit/agenda-aviso-resumo-so-com-agendamento.test.tsx
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EstadoDaTelaDoAvisoDeAgendamento } from "@/lib/agenda/tela-do-aviso-de-agendamento";

const { consulta, salvar, toast } = vi.hoisted(() => ({
  consulta: vi.fn(),
  salvar: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/hooks/agenda/useAvisoDeAgendamento", () => ({
  CHAVE_DO_AVISO_DE_AGENDAMENTO: ["agenda-aviso-de-agendamento"],
  useAvisoDeAgendamento: () => consulta(),
  useGruposDaConexao: () => ({ data: [], isLoading: false, isError: false }),
  useSalvarAvisoDeAgendamento: () => ({ mutateAsync: salvar, isPending: false }),
  useTestarAvisoDeAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false, data: undefined }),
}));

import { AvisoDeAgendamento } from "@/app/app/agenda/avisos/_components/AvisoDeAgendamento";

const CONEXAO = "11111111-1111-4111-8111-111111111111";
const ROTULO = "Enviar o resumo do dia só quando houver agendamento";

function estado(config: Partial<NonNullable<EstadoDaTelaDoAvisoDeAgendamento["config"]>> = {}) {
  return {
    config: {
      usa_numero_do_aviso_de_caso: false,
      channel_session_id: CONEXAO,
      telefone: "+5531998966398",
      grupo: null,
      ligado: true,
      atualizado_em: "2026-11-20T12:00:00.000Z",
      ...config,
    },
    aviso_de_caso: null,
    conexoes: [{ id: CONEXAO, nome: "Agenda", status: "WORKING", aceitaMensagemLivre: true }],
    entregas: [],
    fuso: "America/Sao_Paulo",
  } as EstadoDaTelaDoAvisoDeAgendamento;
}

function montar(e: EstadoDaTelaDoAvisoDeAgendamento) {
  consulta.mockReturnValue({ data: e, isLoading: false, error: null });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AvisoDeAgendamento />
    </QueryClientProvider>,
  );
}

const interruptor = () => screen.getByRole("switch", { name: ROTULO });

beforeEach(() => {
  vi.clearAllMocks();
  salvar.mockResolvedValue({});
});

afterEach(() => cleanup());

describe("resumo só quando houver agendamento — a tela", () => {
  it("nasce desligado para quem nunca escolheu, e o Salvar manda `false`", async () => {
    montar(estado());
    expect(interruptor().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]![0]).toMatchObject({ resumo_so_com_agendamento: false });
  });

  it("ligar o interruptor e salvar leva `resumo_so_com_agendamento: true` no PUT", async () => {
    montar(estado());
    fireEvent.click(interruptor());
    expect(interruptor().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]![0]).toMatchObject({ ligado: true, resumo_so_com_agendamento: true });
  });

  it("mostra a escolha salva", () => {
    montar(estado({ resumo_so_com_agendamento: true }));
    expect(interruptor().getAttribute("aria-checked")).toBe("true");
  });

  it("com os avisos desligados o interruptor trava, e salvar não apaga a escolha", async () => {
    montar(estado({ ligado: false, resumo_so_com_agendamento: true }));
    expect(interruptor().hasAttribute("disabled")).toBe(true);
    expect(interruptor().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]![0]).toMatchObject({ ligado: false, resumo_so_com_agendamento: true });
  });
});

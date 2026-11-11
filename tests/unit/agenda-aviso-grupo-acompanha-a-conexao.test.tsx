/**
 * A TELA DO AVISO DE AGENDAMENTO — o grupo escolhido não sobrevive à troca da
 * conexão que envia (R1 da revisão do PR #2, issue #1).
 *
 * `lib/agenda/rascunho-do-aviso-de-agendamento.test.ts` prova a REGRA
 * (`mudarRascunhoDoAviso` zera o grupo quando a conexão muda). Este arquivo
 * prova a FIAÇÃO: que o switch "usar o mesmo número do aviso de caso" passa
 * pela regra, e que o grupo que vai no PUT é o que a regra deixou. Se alguém
 * voltar o handler para `setRascunho((r) => ({ ...r, usaNumeroDoCaso: v }))`,
 * a regra continua verde e só este arquivo reprova.
 *
 * Os hooks são mocados; o componente é renderizado de verdade.
 *
 * Roda com: pnpm vitest run tests/unit/agenda-aviso-grupo-acompanha-a-conexao.test.tsx
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EstadoDaTelaDoAvisoDeAgendamento } from "@/lib/agenda/tela-do-aviso-de-agendamento";

const { consulta, salvar, grupos } = vi.hoisted(() => ({
  consulta: vi.fn(),
  salvar: vi.fn(),
  grupos: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/hooks/agenda/useAvisoDeAgendamento", () => ({
  CHAVE_DO_AVISO_DE_AGENDAMENTO: ["agenda-aviso-de-agendamento"],
  useAvisoDeAgendamento: () => consulta(),
  useGruposDaConexao: (id: string | null) => grupos(id),
  useSalvarAvisoDeAgendamento: () => ({ mutateAsync: salvar, isPending: false }),
  useTestarAvisoDeAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false, data: undefined }),
}));

import { AvisoDeAgendamento } from "@/app/app/agenda/avisos/_components/AvisoDeAgendamento";

const CONEXAO_PROPRIA = "11111111-1111-4111-8111-111111111111";
const CONEXAO_DO_CASO = "22222222-2222-4222-8222-222222222222";
const GRUPO_DA_PROPRIA = "120363000000000001@g.us";

function estado(): EstadoDaTelaDoAvisoDeAgendamento {
  return {
    config: {
      usa_numero_do_aviso_de_caso: false,
      channel_session_id: CONEXAO_PROPRIA,
      telefone: "+5531998966398",
      grupo: GRUPO_DA_PROPRIA,
      ligado: true,
      atualizado_em: "2026-10-25T12:00:00.000Z",
    },
    aviso_de_caso: { destino_mascarado: "+55 31 9****-6398", channel_session_id: CONEXAO_DO_CASO },
    conexoes: [
      { id: CONEXAO_PROPRIA, nome: "Agenda", status: "WORKING", aceitaMensagemLivre: true },
      { id: CONEXAO_DO_CASO, nome: "Plantão", status: "WORKING", aceitaMensagemLivre: true },
    ],
    entregas: [],
    fuso: "America/Sao_Paulo",
  } as EstadoDaTelaDoAvisoDeAgendamento;
}

function montar() {
  consulta.mockReturnValue({ data: estado(), isLoading: false, error: null });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AvisoDeAgendamento />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  salvar.mockResolvedValue({});
  grupos.mockImplementation((id: string | null) => ({
    data:
      id === CONEXAO_PROPRIA
        ? [{ chatId: GRUPO_DA_PROPRIA, subject: "Equipe da agenda", presente: true }]
        : [],
    isLoading: false,
    isError: false,
  }));
});
afterEach(cleanup);

describe("o grupo do aviso acompanha a conexão que envia", () => {
  it("controle: sem trocar a conexão, salvar manda o grupo salvo", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]?.[0]).toMatchObject({
      usa_numero_do_aviso_de_caso: false,
      channel_session_id: CONEXAO_PROPRIA,
      grupo: GRUPO_DA_PROPRIA,
    });
  });

  it("ligar 'usar o mesmo número do aviso de caso' troca a conexão e o PUT sai sem o grupo da conexão anterior", async () => {
    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Usar o mesmo número do aviso de caso" }));
    // A lista de grupos passa a ser pedida para a conexão do caso.
    expect(grupos).toHaveBeenLastCalledWith(CONEXAO_DO_CASO);

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]?.[0]).toMatchObject({
      usa_numero_do_aviso_de_caso: true,
      grupo: null,
    });
  });

  it("o grupo de outra conexão não aparece como 'Grupo salvo' depois da troca", () => {
    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Usar o mesmo número do aviso de caso" }));
    expect(screen.queryByText("Grupo salvo")).toBeNull();
  });
});

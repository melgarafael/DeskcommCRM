/**
 * O FORMULÁRIO DE EDIÇÃO NÃO MISTURA IDENTIDADE COM LEMBRETE.
 *
 * Nome, duração e quem atende vivem numa grade; cada aviso no WhatsApp é um
 * cartão próprio, com antecedência e mensagem, que se soma com um botão.
 * Esta suíte trava a separação e o "adicionar" — sem o segundo, a lista
 * dinâmica vira de novo os dois campos fixos de antes.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TiposDeAgendamentoClient,
  type TipoRow,
} from "@/app/app/settings/tenant/agenda/_client";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/components/agenda/AgendasConectadas", () => ({ AgendasConectadas: () => null }));
vi.mock("@/components/agenda/PrazosDePresenca", () => ({ PrazosDePresenca: () => null }));
vi.mock("@/components/agenda/ClientePelaAgenda", () => ({ ClientePelaAgenda: () => null }));
vi.mock("@/components/agenda/DiasBloqueados", () => ({ DiasBloqueados: () => null }));

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const TIPO: TipoRow = {
  id: ID,
  name: "Atendimento",
  slug: "atendimento",
  description: null,
  category: "consulta",
  duration_minutes: 60,
  location_kind: "in_person",
  location_details: null,
  default_owner_user_id: "user-1",
  requires_confirmation: false,
  is_active: true,
  default_price_cents: null,
  reminder_enabled: true,
  reminder_minutes_before: 1440,
  reminder_extra_offsets_minutes: [180],
  reminder_body: "Amanhã tem",
  reminder_bodies: { "180": "Falta pouco" },
};

afterEach(() => {
  cleanup();
});

describe("edição do tipo — lembretes dinâmicos", () => {
  it("os cartões de aviso não compartilham a grade com o nome do tipo", async () => {
    render(
      <TiposDeAgendamentoClient
        tiposIniciais={[TIPO]}
        pessoas={[{ id: "user-1", papel: "admin", nome: "Secretária" }]}
        podeEditar
        usuarioAtualId="user-1"
        podeConfigurarGoogle={false}
        clientePelaAgendaLigado={false}
        colegasPodemMexerNaAgendaLigado={true}
        podeMudarAgendaDosColegas={false}
        podeLigarClientePelaAgenda={false}
      />,
    );

    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    const nome = screen.getByTestId(`editar-nome-${ID}`);
    const minutos = screen.getByTestId(`editar-lembrete-minutos-${ID}`);
    const lista = minutos.closest("ul");

    expect(lista, "a lista de lembretes sumiu").toBeTruthy();
    expect(lista).toContainElement(minutos);
    expect(lista).not.toContainElement(nome);
  });

  it("cada aviso já gravado chega com o próprio texto, e dá para somar outro", async () => {
    render(
      <TiposDeAgendamentoClient
        tiposIniciais={[TIPO]}
        pessoas={[{ id: "user-1", papel: "admin", nome: "Secretária" }]}
        podeEditar
        usuarioAtualId="user-1"
        podeConfigurarGoogle={false}
        clientePelaAgendaLigado={false}
        colegasPodemMexerNaAgendaLigado={true}
        podeMudarAgendaDosColegas={false}
        podeLigarClientePelaAgenda={false}
      />,
    );

    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    expect(screen.getByTestId(`editar-lembrete-texto-${ID}`)).toHaveValue("Amanhã tem");
    expect(screen.getByTestId(`editar-lembrete-texto-${ID}-1`)).toHaveValue("Falta pouco");

    await userEvent.click(screen.getByTestId(`editar-lembrete-adicionar-${ID}`));
    expect(screen.getByTestId(`editar-lembrete-texto-${ID}-2`)).toBeInTheDocument();
    expect(screen.getByTestId(`editar-lembrete-texto-${ID}-2`)).toHaveValue("");
  });
});

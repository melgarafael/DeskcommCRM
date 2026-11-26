/**
 * O INTERRUPTOR POR DEGRAU EXISTE NA TELA — e chega ao servidor.
 *
 * A issue #5154 pede uma opção POR DEGRAU ("incluir o link da reunião neste
 * lembrete", ligada por padrão). Um campo no schema que a tela não mostra é
 * controle decorativo do lado do operador; um checkbox que não entra no corpo do
 * PATCH é pior, porque quem clica conclui que salvou. Esta suíte prende os dois
 * sentidos: o estado que chega do banco e o corpo que sai no "Salvar".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TiposDeAgendamentoClient, type TipoRow } from "@/app/app/settings/tenant/agenda/_client";
import { apiClient } from "@/lib/api/client";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/components/agenda/AgendasConectadas", () => ({ AgendasConectadas: () => null }));
vi.mock("@/components/agenda/PrazosDePresenca", () => ({ PrazosDePresenca: () => null }));
vi.mock("@/components/agenda/ClientePelaAgenda", () => ({ ClientePelaAgenda: () => null }));
vi.mock("@/components/agenda/DiasBloqueados", () => ({ DiasBloqueados: () => null }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    patch: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    get: vi.fn(async () => ({})),
  },
}));

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const COM_MEET: TipoRow = {
  id: ID,
  name: "Reunião comercial",
  slug: "reuniao-comercial",
  description: null,
  category: "reuniao",
  duration_minutes: 30,
  location_kind: "google_meet",
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
  // O degrau de 3 horas foi desligado; o principal continua ligado.
  reminder_sem_link_offsets_minutes: [180],
};

function renderizar(tipo: TipoRow) {
  return render(
    <TiposDeAgendamentoClient
      tiposIniciais={[tipo]}
      pessoas={[{ id: "user-1", papel: "admin", nome: "Secretária" }]}
      podeEditar
      usuarioAtualId="user-1"
      podeConfigurarGoogle={false}
      clientePelaAgendaLigado={false}
      colegasPodemMexerNaAgendaLigado={true}
      podeMudarAgendaDosColegas={false}
      podeLigarClientePelaAgenda={false}
      meetAbertoLigado={false}
      podeMudarMeetAberto={false}
    />,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.patch).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("o interruptor de link por degrau (#5154)", () => {
  it("aparece nos tipos com link da reunião, e chega marcado conforme o banco", async () => {
    renderizar(COM_MEET);
    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    const principal = screen.getByTestId(`editar-lembrete-link-${ID}`);
    const extra = screen.getByTestId(`editar-lembrete-link-${ID}-1`);

    expect(principal).toBeChecked();
    expect(extra).not.toBeChecked();
  });

  it("tipo presencial não mostra um interruptor que não muda nada", async () => {
    renderizar({ ...COM_MEET, location_kind: "in_person", reminder_sem_link_offsets_minutes: [] });
    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    expect(screen.queryByTestId(`editar-lembrete-link-${ID}`)).toBeNull();
  });

  it("Link de vídeo também tem a linha do link, então também tem o interruptor", async () => {
    // `linkDaReuniao` trata `video_link` com `meeting_url` https como link
    // pronto — o mesmo texto de "Link da reunião". Esconder o interruptor só
    // aqui deixaria uma lista gravada que ninguém vê nem consegue desfazer.
    renderizar({ ...COM_MEET, location_kind: "video_link" });
    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    expect(screen.getByTestId(`editar-lembrete-link-${ID}`)).toBeChecked();
  });

  it("desmarcar e salvar grava o degrau na lista que vai ao PATCH", async () => {
    renderizar(COM_MEET);
    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    // O principal estava ligado; desliga. O extra já vinha desligado do banco.
    await userEvent.click(screen.getByTestId(`editar-lembrete-link-${ID}`));
    await userEvent.click(screen.getByTestId(`salvar-${ID}`));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(apiClient.patch).toHaveBeenCalledWith(
      "/api/v1/agenda/tipos",
      expect.objectContaining({
        id: ID,
        reminder_sem_link_offsets_minutes: [1440, 180],
      }),
    );
  });
});

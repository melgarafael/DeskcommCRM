/**
 * EQUIPE › ATENDENTES: O LEITOR DE TELA FALA O IDIOMA DA INSTALAÇÃO (#4563).
 *
 * Dois controles tinham o `aria-label` escrito direto em português: a lixeira
 * de cada janela do horário ("Remover janela") e a caixa do modo de roteamento
 * ("Modo de roteamento"). Na tela em espanhol eles não aparecem como texto,
 * só como nome acessível, então quem enxerga não percebe e quem usa leitor de
 * tela ouve português. O dicionário já tinha as duas frases; faltava o `t()`.
 *
 * O caso acha cada controle PELO NOME em espanhol, que é o que o leitor de tela
 * lê. O controle em português fica junto: a frase de antes não pode mudar.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { RoutingCard, ScheduleDialog } from "@/app/app/team/_components/AttendantsClient";
import type { AttendantAvailability } from "@/hooks/team/useAttendants";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/hooks/team/useAttendants", async (original) => ({
  ...(await original<typeof import("@/hooks/team/useAttendants")>()),
  useRoutingConfig: () => ({
    data: { data: { mode: "round_robin", max_retries: 3, backoff_seconds: 30 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateRouting: () => ({ mutate: vi.fn(), isPending: false }),
}));

const FUSO = "America/Sao_Paulo";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const disponibilidade: AttendantAvailability = {
  user_id: USER_ID,
  role: "agent",
  name: "Ana",
  email: "ana@exemplo.com.br",
  is_available: true,
  capacity: 5,
  schedule: { timezone: FUSO, windows: [{ dow: 1, start: "08:00", end: "12:00" }] },
  updated_at: "2026-10-01T12:00:00.000Z",
  current_load: 0,
  last_heartbeat_at: null,
  present: false,
  sector_ids: [],
};

function noIdioma(locale: "pt-BR" | "es", children: React.ReactElement) {
  return render(createElement(IdiomaProvider, { locale, children }));
}

function horario(locale: "pt-BR" | "es") {
  return noIdioma(
    locale,
    <ScheduleDialog
      attendant={{ userId: USER_ID, name: "Ana", email: null, sectorIds: [], availability: disponibilidade }}
      open
      onOpenChange={vi.fn()}
      onSave={vi.fn(async () => [])}
      isPending={false}
      organizationTimezone={FUSO}
    />,
  );
}

afterEach(cleanup);

describe("Equipe › Atendentes no leitor de tela", () => {
  it("em espanhol, a lixeira da janela se chama Eliminar ventana", () => {
    horario("es");
    expect(screen.getByRole("button", { name: "Eliminar ventana" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remover janela" })).toBeNull();
  });

  it("em espanhol, a caixa do modo se chama Modo de enrutamiento", () => {
    noIdioma("es", <RoutingCard canManage />);
    expect(screen.getByRole("combobox", { name: "Modo de enrutamiento" })).toBeInTheDocument();
  });

  it("em português, os dois nomes seguem os de antes", () => {
    horario("pt-BR");
    expect(screen.getByRole("button", { name: "Remover janela" })).toBeInTheDocument();
    cleanup();
    noIdioma("pt-BR", <RoutingCard canManage />);
    expect(screen.getByRole("combobox", { name: "Modo de roteamento" })).toBeInTheDocument();
  });
});

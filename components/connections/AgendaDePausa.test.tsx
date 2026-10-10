/**
 * O diálogo "Agendar pausa" (#2388) — o que a tela converte e o que ela mostra.
 *
 * `paredeParaInstante` decide A QUE HORAS todas as conexões param: o operador
 * digita hora de parede num `datetime-local`, e ela vira instante no fuso DA
 * ORGANIZAÇÃO. O teste de horário de verão de `agenda-de-pausa-agendada` cobre
 * a lib `instanteDe`; este cobre a conversão do diálogo — trocar o `fuso` por
 * "UTC" dentro dela deixava a suíte inteira verde (medido na triagem do #2673).
 *
 * O seletor de escopo mostrava o UUID cru da conexão; quem escolhe lê o nome.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        fuso: "Asia/Tokyo",
        agendas: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            channel_session_id: LOJA,
            starts_at: "2026-10-10T18:00:00.000Z",
            ends_at: "2026-10-10T20:00:00.000Z",
            status: "scheduled",
          },
        ],
      },
    })),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { AgendaDePausa, paredeParaInstante } from "./AgendaDePausa";

const LOJA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEM_NOME = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não implementa.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

describe("paredeParaInstante — a hora digitada vira instante no fuso da organização", () => {
  it("03:00 em São Paulo é 06:00 UTC, e não 03:00 UTC", () => {
    expect(paredeParaInstante("2026-10-10T03:00", "America/Sao_Paulo")).toBe("2026-10-10T06:00:00.000Z");
  });

  it("03:00 em Tóquio é 18:00 UTC do dia anterior", () => {
    expect(paredeParaInstante("2026-10-10T03:00", "Asia/Tokyo")).toBe("2026-10-09T18:00:00.000Z");
  });

  it("valor fora do formato do datetime-local é null", () => {
    expect(paredeParaInstante("", "America/Sao_Paulo")).toBeNull();
    expect(paredeParaInstante("2026-10-10 03:00", "America/Sao_Paulo")).toBeNull();
  });
});

describe("AgendaDePausa — o que o operador lê", () => {
  it(
    "o seletor mostra o nome da conexão, e a lista mostra a hora no fuso da organização",
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup({ delay: null });
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AgendaDePausa
            canais={[
              { id: LOJA, display_name: "Loja Centro", phone_number: "5511999990000" },
              { id: SEM_NOME, display_name: null, phone_number: "5511888880000" },
            ]}
          />
        </QueryClientProvider>,
      );

      await user.click(screen.getByRole("button", { name: "Agendar pausa" }));

      // 18:00 UTC de 10/10 é 03:00 de 11/10 em Tóquio — o fuso que veio do GET.
      const linha = await screen.findByText(/Loja Centro/);
      expect(linha.textContent).toMatch(/11\/10\/2026.*03:00/);

      await user.click(screen.getByRole("combobox"));
      const opcoes = (await screen.findAllByRole("option")).map((o) => o.textContent);
      expect(opcoes).toEqual(["Para todas as conexões", "Loja Centro", "5511888880000"]);
      expect(opcoes.join(" ")).not.toContain(LOJA);
    },
  );
});

/**
 * #2676 — o diálogo "Agendar pausa" com o fuso da organização AINDA NÃO CHEGADO.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `const fuso = janelas.data?.fuso ?? "America/Sao_Paulo"` (linha 101) dava um
 * fuso PADRÃO enquanto o GET `/api/v1/channel-schedules` não respondia, e o
 * botão "Agendar" só ficava travado durante o salvamento. Organização em
 * `America/Manaus` que clicasse nesse intervalo gravava 03:00 como 06:00Z —
 * uma hora errada, sem erro nenhum na tela.
 *
 * ─── Os três casos que este arquivo cobre ────────────────────────────────────
 *
 *  1. GET pendente: nenhum campo de data/hora e nem o "Agendar" respondem, e
 *     NENHUM payload sai — nem digitando e clicando por cima do desabilitado.
 *     O que este caso prova é o `disabled`, NÃO a guarda `if (!fuso)` dentro de
 *     `agendar()`: o React não dispara `onClick` em botão desabilitado (o
 *     react-dom filtra eventos de mouse em button/input/select/textarea
 *     desabilitados), então o `fireEvent.click` nunca chega à guarda. Removendo
 *     a guarda, este caso segue verde. Ela fica como segunda defesa;
 *  2. Fuso chega (`America/Manaus`): tudo habilita, e 03:00 digitado vira
 *     `starts_at = 07:00Z` — a conversão do PRÓPRIO diálogo (`paredeParaInstante`
 *     → `instanteDe`), não a do navegador;
 *  3. GET falha: aparece o aviso (`role="alert"`) e a tela trava; fechar e
 *     reabrir o diálogo refaz o GET (com o `QueryClient` de PRODUÇÃO,
 *     `makeQueryClient`) e tudo destrava — a tela não fica presa no erro.
 *
 * A conta de fuso é a da lógica do componente, medida neste runtime:
 * `America/Manaus` é UTC-4 o ano inteiro (sem horário de verão desde 2019),
 * logo 03:00 de parede = 07:00Z. O fuso PADRÃO resolveria 06:00Z — é essa
 * diferença de uma hora que a issue pede para não acontecer.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { makeQueryClient } from "@/lib/query/client";

import { AgendaDePausa } from "./AgendaDePausa";

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não implementa.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
});

async function abrirDiálogo(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgendaDePausa canais={[]} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Agendar pausa" }));
}

describe("AgendaDePausa — o fuso da organização ainda não chegou (#2676)", () => {
  it(
    "com o GET pendente, data/hora e Agendar ficam travados e NENHUM payload sai",
    { timeout: 30_000 },
    async () => {
      // Nunca resolve: o diálogo vive com `janelas` pendente o tempo todo.
      getMock.mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup({ delay: null });
      await abrirDiálogo(user);

      const inicio = screen.getByLabelText("A pausa começa (hora local)");
      const fim = screen.getByLabelText("A pausa termina (hora local)");
      const agendar = screen.getByRole("button", { name: "Agendar" });

      // Sem fuso não existe conversão honesta: nada de editar nem de salvar.
      expect(inicio).toBeDisabled();
      expect(fim).toBeDisabled();
      expect(agendar).toBeDisabled();

      // Nem um clique forçado em cima de valores já digitados pode virar payload.
      fireEvent.change(inicio, { target: { value: "2026-10-10T03:00" } });
      fireEvent.change(fim, { target: { value: "2026-10-10T05:00" } });
      fireEvent.click(agendar);
      expect(postMock).not.toHaveBeenCalled();
    },
  );

  it(
    "quando o fuso chega (America/Manaus), tudo habilita e 03:00 vira 07:00Z",
    { timeout: 30_000 },
    async () => {
      getMock.mockResolvedValue({ data: { fuso: "America/Manaus", agendas: [] } });
      const user = userEvent.setup({ delay: null });
      await abrirDiálogo(user);

      // O fuso chegou — é ele que habilita a tela.
      await screen.findByText("America/Manaus", { exact: false });

      const inicio = screen.getByLabelText("A pausa começa (hora local)");
      const fim = screen.getByLabelText("A pausa termina (hora local)");
      const agendar = screen.getByRole("button", { name: "Agendar" });
      expect(inicio).toBeEnabled();
      expect(fim).toBeEnabled();
      expect(agendar).toBeEnabled();

      fireEvent.change(inicio, { target: { value: "2026-10-10T03:00" } });
      fireEvent.change(fim, { target: { value: "2026-10-10T05:00" } });
      await user.click(agendar);

      // 03:00 em Manaus (UTC-4) é 07:00Z; o padrão São Paulo teria gravado 06:00Z.
      expect(postMock).toHaveBeenCalledWith("/api/v1/channel-schedules", {
        starts_at: "2026-10-10T07:00:00.000Z",
        ends_at: "2026-10-10T09:00:00.000Z",
        channel_session_id: null,
      });
    },
  );

  // Caso acrescentado na triagem do #2708 (sobre o conserto de @webtecnica).
  it(
    "se o GET falha, aparece o aviso e tudo trava; fechar e reabrir refaz o GET e destrava",
    { timeout: 30_000 },
    async () => {
      getMock.mockRejectedValueOnce(new Error("GET falhou"));
      getMock.mockResolvedValue({ data: { fuso: "America/Manaus", agendas: [] } });
      const user = userEvent.setup({ delay: null });
      // O client de produção: é a política de retry/staleTime dele que decide
      // se reabrir o diálogo refaz o GET. Um `new QueryClient()` cru mediria outra coisa.
      render(
        <QueryClientProvider client={makeQueryClient()}>
          <AgendaDePausa canais={[]} />
        </QueryClientProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Agendar pausa" }));

      await screen.findByRole("alert");
      expect(screen.getByLabelText("A pausa começa (hora local)")).toBeDisabled();
      expect(screen.getByLabelText("A pausa termina (hora local)")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Agendar" })).toBeDisabled();

      // O X do Dialog também se chama "Fechar"; o primeiro é o botão do rodapé.
      await user.click(screen.getAllByRole("button", { name: "Fechar" })[0]!);
      await user.click(screen.getByRole("button", { name: "Agendar pausa" }));

      await screen.findByText("America/Manaus", { exact: false });
      expect(getMock).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("A pausa começa (hora local)")).toBeEnabled();
      expect(screen.getByLabelText("A pausa termina (hora local)")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Agendar" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(postMock).not.toHaveBeenCalled();
    },
  );
});

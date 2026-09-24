import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SecurityClient } from "./_client";

/**
 * As três ações desta tela (regenerar códigos, sair de todos os dispositivos,
 * desligar o MFA) usavam `window.confirm()` — bloqueado em iframe, ignora o
 * tema e não passa por `t()` (docs/doctrine, comentário original em
 * `app/app/tasks/_components/ListaDeTarefas.tsx`). Trocadas pelo `AlertDialog`
 * (mesmo padrão de `docs/doctrine/destrutivo-pede-confirmacao.md`): o clique
 * só ABRE o diálogo, a ação real só dispara no clique de DENTRO dele.
 */

const regenerar = vi.hoisted(() => vi.fn());
const sair = vi.hoisted(() => vi.fn());
const desligarMfa = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/settings/regenerateRecoveryCodes", () => ({
  regenerateRecoveryCodes: regenerar,
}));
vi.mock("@/app/actions/settings/signOutEverywhere", () => ({
  signOutEverywhere: sair,
}));
vi.mock("@/app/actions/auth/politicaDeMfa", () => ({
  definirExigenciaDeMfa: vi.fn(),
  desativarMfaDaConta: desligarMfa,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/auth/RecoveryCodesPanel", () => ({ RecoveryCodesPanel: () => null }));
vi.mock("@/components/auth/MfaEnrollModal", () => ({ MfaEnrollModal: () => null }));
vi.mock("@/components/voice/PainelDeChamadaDeVoz", () => ({ PainelDeChamadaDeVoz: () => null }));

const semReload = vi.fn();

beforeEach(() => {
  regenerar.mockReset().mockResolvedValue({ ok: true, recovery_codes: ["a", "b"] });
  sair.mockReset().mockResolvedValue(undefined);
  desligarMfa.mockReset().mockResolvedValue({ ok: true });
  semReload.mockReset();
  // `desativarMfaDaConta` recarrega a página no sucesso — jsdom não navega de
  // verdade, então só trocamos a implementação por um espião inofensivo.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: semReload },
  });
});

function renderTela(props: Partial<React.ComponentProps<typeof SecurityClient>> = {}) {
  return render(
    <SecurityClient
      mfaEnrolled={true}
      obrigatorio={false}
      podeExigirDaEquipe={false}
      empresaExige={false}
      {...props}
    />,
  );
}

describe("Configurações › Segurança — confirmação por AlertDialog", () => {
  it("desligar o MFA pede confirmação nomeada e só desliga no clique de dentro", async () => {
    const user = userEvent.setup();
    renderTela();

    await user.click(screen.getByRole("button", { name: "Desligar" }));

    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Desligar a verificação em duas etapas?")).toBeTruthy();
    expect(desligarMfa).not.toHaveBeenCalled();

    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(desligarMfa).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Desligar" }));
    const dialogo2 = await screen.findByRole("alertdialog");
    await user.click(within(dialogo2).getByRole("button", { name: "Desligar" }));

    await waitFor(() => expect(desligarMfa).toHaveBeenCalledTimes(1));
  });

  it("regenerar códigos só invalida os atuais depois de confirmar dentro do diálogo", async () => {
    const user = userEvent.setup();
    renderTela();

    await user.click(screen.getByRole("button", { name: "Regenerar códigos de recuperação" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Gerar novos códigos de recuperação?")).toBeTruthy();
    expect(regenerar).not.toHaveBeenCalled();

    await user.click(within(dialogo).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(regenerar).toHaveBeenCalledTimes(1));
  });

  it("sair de todos os dispositivos só acontece depois de confirmar dentro do diálogo", async () => {
    const user = userEvent.setup();
    renderTela();

    await user.click(screen.getByRole("button", { name: "Sair de todos os dispositivos" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Sair de todos os dispositivos?")).toBeTruthy();
    expect(sair).not.toHaveBeenCalled();

    await user.click(within(dialogo).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(sair).toHaveBeenCalledTimes(1));
  });
});

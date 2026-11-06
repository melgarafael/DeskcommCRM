/**
 * NOME REPETIDO NO DIÁLOGO "RENOMEAR" DA LISTA (#3952).
 *
 * `renameAgentAction` devolve `agent_name_taken` SEM `message` (quem traduz é a
 * tela). O diálogo caía no `toast.error(res.message ?? "Falha: <código>")` e a
 * pessoa lia "Falha: agent_name_taken" no canto. Este arquivo prende: a frase no
 * campo, o diálogo aberto com o nome digitado, nenhum toast — e o complemento do
 * "Salvar rascunho" existindo em es/en, porque a frase do editor é montada na tela.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const renomear = vi.hoisted(() => vi.fn());
const fechar = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/ai/agents/_actions", () => ({ renameAgentAction: renomear }));

import { toast } from "sonner";
import { RenameAgentDialog } from "@/app/app/ai/agents/_components/RenameAgentDialog";

beforeEach(() => {
  vi.clearAllMocks();
  renomear.mockResolvedValue({ ok: false, error: "agent_name_taken" });
});

function abrir() {
  render(
    <RenameAgentDialog
      agent={{ id: "agente-1", name: "Vendas" } as never}
      open
      onOpenChange={fechar}
    />,
  );
}

describe("renomear para um nome que já existe na organização", () => {
  it("a frase aparece no campo, o diálogo segue aberto com o nome digitado e não há toast", async () => {
    abrir();
    const campo = document.getElementById("agent-name") as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "Recepção" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(renomear).toHaveBeenCalledWith("agente-1", "Recepção"));

    const frase = await screen.findByRole("alert");
    expect(frase).toHaveTextContent("Já existe um agente com esse nome.");
    expect(campo.getAttribute("aria-describedby")).toBe(frase.id);
    expect(campo).toHaveAttribute("aria-invalid", "true");
    expect(campo.value).toBe("Recepção");
    expect(toast.error).not.toHaveBeenCalled();
    expect(fechar).not.toHaveBeenCalledWith(false);

    fireEvent.change(campo, { target: { value: "Recepção 2" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("outra falha continua indo para o toast", async () => {
    renomear.mockResolvedValue({ ok: false, error: "internal_error", message: "boom" });
    abrir();
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("o complemento do Salvar rascunho existe em es (dicionário) e en (catálogo)", () => {
  const frase = "O rascunho foi salvo; o nome do agente não mudou.";
  const dicionario = readFileSync(join(process.cwd(), "lib/i18n/dicionario.ts"), "utf8");
  expect(dicionario).toContain(`"${frase}": { es: "El borrador se guardó; el nombre del agente no cambió." }`);
  const en = JSON.parse(
    readFileSync(join(process.cwd(), "lib/i18n/traducoes/en.json"), "utf8"),
  ) as Record<string, string>;
  expect(en[frase]).toBe("The draft was saved; the agent's name did not change.");
});

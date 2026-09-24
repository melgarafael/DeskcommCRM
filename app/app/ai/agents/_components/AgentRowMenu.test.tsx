/**
 * Arquivar o agente PADRÃO da organização é recusado pela action com
 * `cannot_archive_default` e sem `message`. O menu mostrava o item habilitado e,
 * no clique, o toast dizia "Falha: cannot_archive_default" — código cru.
 *
 * Os dois lados guardados aqui: o item nem se oferece para o padrão (com o
 * motivo no title, alcançável por hover), e quando a recusa chega mesmo assim
 * (a lista estava velha e outro admin promoveu o agente) ela vira frase.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRow } from "@/hooks/ai/useAgent";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({
  archiveAgentAction: vi.fn(),
  duplicateAgentAction: vi.fn(),
  pauseAgentAction: vi.fn(),
  unpauseAgentAction: vi.fn(),
}));

import { toast } from "sonner";
import { archiveAgentAction } from "../_actions";
import { AgentRowMenu } from "./AgentRowMenu";

const FRASE = "O agent padrão da organização não pode ser arquivado.";

function agente(isDefault: boolean): AgentRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: "00000000-0000-4000-8000-000000000002",
    name: "Atendente",
    description: null,
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: "",
    is_active: true,
    is_default: isDefault,
    config: {},
    guardrails: null,
    active_kb_version_id: null,
    published_version_id: "00000000-0000-4000-8000-000000000003",
    archived_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
}

async function abreMenu(isDefault: boolean) {
  const user = userEvent.setup({ delay: null });
  render(<AgentRowMenu agent={agente(isDefault)} />);
  await user.click(screen.getByRole("button", { name: "Menu de ações" }));
  return { user, arquivar: await screen.findByRole("menuitem", { name: "Arquivar" }) };
}

describe("AgentRowMenu — o agente padrão não se arquiva", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(archiveAgentAction).mockReset();
  });

  it("desabilita Arquivar para o padrão e diz por quê, com hover possível", async () => {
    const { arquivar } = await abreMenu(true);

    expect(arquivar).toHaveAttribute("aria-disabled", "true");
    expect(arquivar).toHaveAttribute("title", FRASE);
    expect(arquivar.className).toContain("data-[disabled]:pointer-events-auto");
    expect(arquivar.className).not.toContain("data-[disabled]:pointer-events-none");
  });

  it("não desabilita Arquivar para agente comum", async () => {
    const { arquivar } = await abreMenu(false);

    expect(arquivar).not.toHaveAttribute("aria-disabled");
    expect(arquivar).not.toHaveAttribute("title");
  });

  it("recusa cannot_archive_default vira frase, nunca o código cru", async () => {
    vi.mocked(archiveAgentAction).mockResolvedValue({ ok: false, error: "cannot_archive_default" });
    const { user, arquivar } = await abreMenu(false);

    await user.click(arquivar);
    await user.click(await screen.findByRole("button", { name: "Arquivar" }));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(FRASE);
  });
});

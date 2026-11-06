import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ accept: vi.fn(), toast: vi.fn() }));
vi.mock("@/app/actions/onboarding/acceptWelcome", () => ({ acceptWelcome: f.accept }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("sonner", () => ({ toast: { error: f.toast } }));
import { WelcomeForm } from "@/app/onboarding/welcome/_form";

beforeEach(() => vi.clearAllMocks());

it.each([
  ["organization_changed", "A empresa ativa mudou. Recarregue a página antes de continuar."],
])(
  "envia o contexto exibido e explica %s sem descartar os dados digitados",
  async (error, message) => {
    const org = "11111111-1111-4111-8111-111111111111";
    f.accept.mockResolvedValue({ ok: false, error });
    const { container } = render(<WelcomeForm orgId={org} defaultOrgName="Empresa A" />);
    fireEvent.change(screen.getByLabelText("O que vocês fazem?"), {
      target: { value: "Serviços de teste" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(f.accept).toHaveBeenCalled());
    const submitted = f.accept.mock.calls[0]?.[0] as FormData;
    expect(submitted.get("organization_id")).toBe(org);
    expect(submitted.get("display_name")).toBe("Empresa A");
    await waitFor(() => expect(f.toast).toHaveBeenCalledWith(message));
    expect(screen.getByLabelText("O que vocês fazem?")).toHaveValue("Serviços de teste");
  },
);

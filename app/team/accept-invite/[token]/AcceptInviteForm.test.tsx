import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { acceptInviteAction } from "@/app/actions/team/acceptInvite";
import { AcceptInviteForm } from "./AcceptInviteForm";
vi.mock("@/app/actions/team/acceptInvite", () => ({ acceptInviteAction: vi.fn() }));
it("shows the plan explanation and retries the same invite", async () => {
  vi.mocked(acceptInviteAction).mockResolvedValue({ ok: false, error: "subscription_resource_limit" });
  render(<AcceptInviteForm token="signed-invite" label="Aceitar" pendingLabel="Confirmando" failureLabel="Convite vencido" limitLabel="Confira o plano com o administrador" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Aceitar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Confira o plano");
  expect(screen.queryByText("Convite vencido")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Aceitar" }));
  expect(acceptInviteAction).toHaveBeenNthCalledWith(2, "signed-invite");
});

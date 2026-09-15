import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";

/**
 * Tags do CONTATO sem sugestão (#852, item 1 da divisão). O editor de tags da
 * conversa já oferecia as tags em uso; o do contato obrigava a digitar do zero,
 * e cada operador criava a sua variação ("google", "gogle", "google ads").
 *
 * Dois lados, porque um sem o outro não resolve:
 *  - a ROTA precisa devolver as tags que existem, só da organização da sessão;
 *  - o EDITOR precisa oferecê-las e gravar a escolhida.
 */

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
const mutate = vi.fn();
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate, isPending: false }),
}));

const ORG = "org-1";

beforeEach(() => {
  get.mockReset();
  mutate.mockReset();
});

describe("ContactTagsEditor", () => {
  it("oferece as tags existentes que o contato ainda não tem, e clicar grava", async () => {
    get.mockResolvedValue({ data: ["google", "vip"] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContactTagsEditor contactId="c-1" orgId={ORG} tags={["vip"]} />
      </QueryClientProvider>,
    );

    const sugestao = await screen.findByRole("button", { name: "+ google" });
    expect(screen.queryByRole("button", { name: "+ vip" })).toBeNull();

    await userEvent.click(sugestao);

    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "google"] });
  });
});

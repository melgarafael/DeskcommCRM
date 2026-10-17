/**
 * A ETIQUETA DO FUNIL GRAVA NO NEGÓCIO — E SÓ NELE (#2979).
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * `crm_leads.tags` (a etiqueta do NEGÓCIO, que a automação lê por `contains`) e
 * `contacts.tags` (a etiqueta da PESSOA, marcada no Inbox e na ficha) são caixas
 * distintas, em rotas distintas. O editor do Inbox gravava em
 * `PATCH /api/v1/contacts/{id}`; trazer o MESMO editor para o funil sem trocar o
 * destino mandaria a etiqueta do negócio para o perfil do contato — e o PATCH
 * responderia 200 do mesmo jeito. É corrupção silenciosa: nenhuma tela pisca,
 * nenhum erro aparece, e a regra de automação que esperava a etiqueta no negócio
 * deixa de casar.
 *
 * Por isso o caso ⭐ mede a URL que o cliente chamou, não o texto na tela: é a
 * única asserção que distingue "gravou no lugar certo" de "gravou em algum
 * lugar". Sabotagem de referência — forçar o caminho de negócio a usar
 * `useUpdateContact` — deixa este arquivo vermelho (medido; saída no PR).
 *
 * O segundo caso é o CONTROLE na outra direção: no Inbox (sem `entityType`, o
 * padrão `contact`) a rota continua sendo a de contato, senão o conserto de um
 * lado viraria regressão do outro.
 */
import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";

/** O papel da sessão muda entre os casos (o clique na sugestão muda de rota). */
const sessao = vi.hoisted(() => ({ papel: "manager" as string }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: sessao.papel } }),
}));

const patch = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    patch: (...args: unknown[]) => patch(...args),
    post: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const ORG = "org-1";

function montar(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** As URLs que o editor chamou, na ordem — a medição do caso ⭐. */
const urlsChamadas = () => patch.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  sessao.papel = "manager";
  patch.mockReset();
  get.mockReset();
  patch.mockResolvedValue({ data: {} });
  get.mockResolvedValue({ data: [] });
});
afterEach(cleanup);

describe("ContactTagsEditor no contexto de NEGÓCIO (#2979)", () => {
  it("⭐ digitar uma etiqueta no negócio grava em /api/v1/leads/{id} — nunca no contato", async () => {
    montar(
      <ContactTagsEditor
        entityType="lead"
        entityId="l-9"
        pipelineId="p-4"
        orgId={ORG}
        tags={[]}
      />,
    );

    // O rótulo também diz de QUEM é a etiqueta — "ao contato" num formulário de
    // negócio ensinaria o operador a esperar o destino errado.
    await userEvent.type(screen.getByLabelText("Adicionar tag ao negócio"), "recompra");
    await userEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/leads/l-9", { tags: ["recompra"] });
    // A guarda explícita: nem a rota de contato do MESMO id, nem outra qualquer.
    expect(urlsChamadas().some((u) => u.startsWith("/api/v1/contacts/"))).toBe(false);
  });

  it("CONTROLE no Inbox: sem entityType o editor continua gravando no contato", async () => {
    montar(<ContactTagsEditor entityId="c-9" orgId={ORG} tags={[]} />);

    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "vip");
    await userEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/contacts/c-9", { tags: ["vip"] });
    expect(urlsChamadas().some((u) => u.startsWith("/api/v1/leads/"))).toBe(false);
  });

  it("clicar na sugestão do vocabulário, no negócio, também vai para o negócio", async () => {
    // Papel `agent`: quem pode pintar etiqueta passa pela caixa de cor antes de
    // gravar (#2789) — aqui a pergunta é o DESTINO, então o clique grava direto.
    sessao.papel = "agent";
    get.mockResolvedValue({ data: ["vip"] });
    montar(
      <ContactTagsEditor
        entityType="lead"
        entityId="l-9"
        pipelineId="p-4"
        orgId={ORG}
        tags={["cliente"]}
      />,
    );

    const sugestao = await screen.findByRole("button", { name: "+ vip" }, { timeout: 5000 });
    await userEvent.click(sugestao);

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/leads/l-9", { tags: ["cliente", "vip"] }),
    );
    expect(urlsChamadas().some((u) => u.startsWith("/api/v1/contacts/"))).toBe(false);
  });

  it("remover a etiqueta do negócio manda a lista sem ela para a rota do negócio", async () => {
    montar(
      <ContactTagsEditor
        entityType="lead"
        entityId="l-9"
        pipelineId="p-4"
        orgId={ORG}
        tags={["recompra", "vip"]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Remover tag recompra" }));

    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/leads/l-9", { tags: ["vip"] }));
    expect(urlsChamadas().some((u) => u.startsWith("/api/v1/contacts/"))).toBe(false);
  });
});

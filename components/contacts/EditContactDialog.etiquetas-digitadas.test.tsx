/**
 * O TEXTO DIGITADO NAS ETIQUETAS NÃO SOME AO SALVAR (issue #2732, PR #2831).
 *
 * ─── O defeito que este arquivo tranca ──────────────────────────────────────
 *
 * O texto em digitação mora num `useState` do `EtiquetasDoContato` (`draft`):
 * enquanto não vira chip, não está na lista que o diálogo lê ao salvar. Só o
 * Enter, o clique na sugestão e o clique em "Criar" chamavam `onChange` — quem
 * DIGITAVA e clicava em Salvar devolvia PATCH 200 com "Contato atualizado", o
 * diálogo fechava e a API gravava `tags: []`. O texto se perdia sem aviso.
 *
 * ─── Por que este arquivo roda o DIÁLOGO de verdade ─────────────────────────
 *
 * O caso que o revisor mediu é do campo PARA CIMA: quem decide o payload é o
 * `EditContactDialog`, sobre o `apiClient` de verdade, com o `fetch` devolvendo
 * o corpo EXATO da rota. Um dublê do campo provaria só que o dublê está ligado
 * — e é justamente no fio entre o campo e o `Salvar` que o texto se perdia.
 *
 * O que cada caso prova:
 *   1. texto NOVO digitado sem Enter entra no PATCH (o defeito medido);
 *   2. digitar uma etiqueta que JÁ EXISTE, sem Enter, grava UMA só — a mesma
 *      grafia, sem abrir uma segunda "cliente ouro";
 *   3. a grafia existente é REUSADA nesse caminho: com "são paulo" na
 *      organização, digitar "sao paulo" sem Enter grava "são paulo" (o acento
 *      sobrevive ao payload, então o caso distingue reuso de variante nova);
 *   4. o Enter continua como era: o chip aparece na ficha e vai UMA vez só.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/types/contacts";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, orgId: "org-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

/** O contato aberto no diálogo — sem telefone, para o payload ser só as tags. */
const CONTATO = {
  id: "ct-2732",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-09-14T10:00:00.000Z",
  updated_at: "2026-09-14T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** O `fetch` do PATCH, com o corpo que a rota devolveria. */
let buscar: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // O `fetch` responde por ROTA, e não com o mesmo corpo para todas: o diálogo
  // também lê o vocabulário de sugestões (`GET /api/v1/contact-tags`, a lista
  // sem texto) e a leitura COM busca (`?busca=`), que a #3144 trouxe para a
  // ficha. Devolver o corpo do contato para elas daria um objeto onde o campo
  // espera lista — o dublê estaria mentindo sobre a rota.
  buscar = vi.fn(async (entrada: unknown) => {
    const url = typeof entrada === "string" ? entrada : String((entrada as Request)?.url ?? "");
    const corpo = url.includes("/api/v1/contact-tags") ? { data: [] } : { data: { contact: CONTATO } };
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", buscar);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** O corpo do PATCH que o diálogo mandou (prova o que a rota receberia). */
function corpoDoPatch(): Record<string, unknown> {
  const chamada = buscar.mock.calls.find(([url]) => String(url).includes("/api/v1/contacts/"));
  expect(chamada, "o diálogo não mandou PATCH nenhum").toBeTruthy();
  const init = chamada?.[1] as RequestInit | undefined;
  expect(String(init?.method).toUpperCase()).toBe("PATCH");
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("EditContactDialog · etiquetas digitadas sem Enter (issue #2732)", () => {
  it("digitar uma etiqueta NOVA e salvar sem Enter grava a etiqueta", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog contact={CONTATO} open onOpenChange={vi.fn()} vocabulario={["vip"]} />,
    );

    await user.type(screen.getByLabelText("Adicionar etiqueta"), "cliente diamante");
    // A opção de criar apareceu — e é este o caso em que o texto sumia ao salvar.
    expect(screen.getByTestId("criar-etiqueta")).toHaveTextContent("cliente diamante");

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(buscar).toHaveBeenCalled());
    expect(corpoDoPatch().tags).toEqual(["cliente diamante"]);
  });

  it("digitar uma etiqueta que JÁ EXISTE, sem Enter, grava uma só", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog
        contact={CONTATO}
        open
        onOpenChange={vi.fn()}
        vocabulario={["cliente ouro"]}
      />,
    );

    await user.type(screen.getByLabelText("Adicionar etiqueta"), "cliente ouro");
    // Já existe: o campo nem oferece "Criar etiqueta".
    expect(screen.queryByTestId("criar-etiqueta")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(buscar).toHaveBeenCalled());
    // Uma só entrada: sem segunda "cliente ouro".
    expect(corpoDoPatch().tags).toEqual(["cliente ouro"]);
  });

  it("gravar reusa a grafia existente nesse caminho (acento sobrevive)", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog
        contact={CONTATO}
        open
        onOpenChange={vi.fn()}
        // A grafia que o banco da organização já guarda.
        vocabulario={["são paulo"]}
      />,
    );

    await user.type(screen.getByLabelText("Adicionar etiqueta"), "sao paulo");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(buscar).toHaveBeenCalled());
    // "são paulo" e não "sao paulo": prova o reuso, e não uma variante nova.
    expect(corpoDoPatch().tags).toEqual(["são paulo"]);
  });

  it("o Enter continua virando chip na ficha, com uma só entrada no PATCH", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog
        contact={CONTATO}
        open
        onOpenChange={vi.fn()}
        vocabulario={["são paulo"]}
      />,
    );

    await user.type(screen.getByLabelText("Adicionar etiqueta"), "sao paulo{Enter}");

    // O chip está na ficha (e só um): a sugestão some porque já foi escolhida.
    expect(screen.getByLabelText("Remover etiqueta são paulo")).toBeInTheDocument();
    expect(screen.queryByTestId("sugestao-sao paulo")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(buscar).toHaveBeenCalled());
    expect(corpoDoPatch().tags).toEqual(["são paulo"]);
  });
});

function montar(contact: Contact, open: boolean) {
  return (
    <QueryClientProvider client={qcFixo}>
      <EditContactDialog contact={contact} open={open} onOpenChange={vi.fn()} vocabulario={["vip"]} />
    </QueryClientProvider>
  );
}
const qcFixo = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** Os corpos dos PATCH do contato, na ordem em que saíram. */
function patches(): Record<string, unknown>[] {
  return buscar.mock.calls
    .filter(([url]) => String(url).includes("/api/v1/contacts/"))
    .map(([, init]) =>
      JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")),
    ) as Record<string, unknown>[];
}

describe("EditContactDialog · o pendente não sobrevive a fechar o diálogo (ficha, #2831)", () => {
  it("digitar, CANCELAR, reabrir e salvar NÃO grava o texto cancelado", async () => {
    const user = userEvent.setup();
    const r = render(montar(CONTATO, true));
    await user.type(screen.getByLabelText("Adicionar etiqueta"), "cliente cancelado");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    r.rerender(montar(CONTATO, false));
    r.rerender(montar(CONTATO, true));
    expect(screen.getByLabelText("Adicionar etiqueta")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(buscar).toHaveBeenCalled());
    expect(corpoDoPatch().tags).toEqual([]);
  });

  it("salvar sem Enter, reabrir, REMOVER o chip e salvar remove a etiqueta", async () => {
    const user = userEvent.setup();
    const r = render(montar(CONTATO, true));
    await user.type(screen.getByLabelText("Adicionar etiqueta"), "cliente diamante");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    // Os PATCHES, não o total de `fetch`: desde a #3144 a ficha também LÊ o
    // vocabulário a cada tecla, e contar tudo misturaria leitura com escrita.
    await waitFor(() => expect(patches()).toHaveLength(1));
    const salvo = { ...CONTATO, tags: ["cliente diamante"] };
    r.rerender(montar(salvo, false));
    r.rerender(montar(salvo, true));
    await user.click(screen.getByLabelText("Remover etiqueta cliente diamante"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]?.tags).toEqual([]);
  });
});

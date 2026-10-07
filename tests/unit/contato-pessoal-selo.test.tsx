import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ContactsTable } from "@/components/contacts/ContactsTable";
import type { Contact } from "@/lib/types/contacts";

/**
 * SELO "PESSOAL" VISÍVEL E DE COLUNA (spec 21, etapa 15 — critério 5).
 *
 * Marca e abre Contatos: selo "Pessoal" visível; edita as etiquetas: o selo
 * fica — porque ele lê a COLUNA `is_personal`, nunca a etiqueta. "Ativo" some
 * junto: pessoal está fora da operação, então chamar de ativo mentiria.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Ler o selo da etiqueta (`tags`) em vez da coluna: o caso "selo sobrevive
 *   sem etiqueta" cai — some ao editar, que é exatamente o defeito que a
 *   spec manda evitar.
 * - Tirar o `!c.is_personal` do "Ativo": pessoal aparece como ativo e o caso
 *   "pessoal não é ativo" cai.
 * Linha para reverter: `components/contacts/ContactsTable.tsx`,
 * `app/app/contacts/[id]/_client.tsx`.
 */

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => null,
  useAuth: () => ({ user: { id: "u-1", support: null }, activeOrg: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// O Link real precisa de contexto de roteador para prefetch; aqui ele é só
// âncora — o que está sob teste é o selo, não a navegação.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/contacts/useDeleteContact", () => ({
  useDeleteContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
  mensagemDeBloqueioPorVinculo: () => null,
}));

function contato(pessoal: boolean, tags: string[]): Contact {
  return {
    id: pessoal ? "ct-pessoal" : "ct-livre",
    organization_id: "org-1",
    name: null,
    display_name: pessoal ? "Mãe" : "Cliente",
    email: null,
    email_normalized: null,
    phone_number: "+5511999999999",
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_personal: pessoal,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags,
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    last_activity_at: null,
    first_service_at: null,
  };
}

function tabela(contatos: Contact[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactNode = (
    <QueryClientProvider client={qc}>
      <ContactsTable contacts={contatos} orderBy="last_activity_at" orderDir="desc" onSort={() => {}} />
    </QueryClientProvider>
  );
  return render(ui);
}

describe("selo Pessoal é de coluna (critério 5)", () => {
  it("pessoal com etiquetas: selo Pessoal visível, Ativo ausente", () => {
    const { unmount } = tabela([contato(true, ["vip"])]);
    expect(screen.getByText("Pessoal")).toBeTruthy();
    expect(screen.queryByText("Ativo")).toBeNull();
    // As etiquetas continuam lá — o selo convive com elas, não sai delas.
    expect(screen.getByText("vip")).toBeTruthy();
    unmount();
  });

  it("edita as etiquetas (some tudo): o selo fica", () => {
    const { unmount, rerender } = tabela([contato(true, ["vip"])]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <ContactsTable
          contacts={[contato(true, [])]}
          orderBy="last_activity_at"
          orderDir="desc"
          onSort={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Pessoal")).toBeTruthy();
    expect(screen.queryByText("Ativo")).toBeNull();
    unmount();
  });

  it("contato normal: Ativo visível, Pessoal ausente", () => {
    const { unmount } = tabela([contato(false, [])]);
    expect(screen.getByText("Ativo")).toBeTruthy();
    expect(screen.queryByText("Pessoal")).toBeNull();
    unmount();
  });
});

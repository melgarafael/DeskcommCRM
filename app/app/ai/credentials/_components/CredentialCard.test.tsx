/**
 * `models_available` é `text[]` no banco e chegava tipado como `number` no
 * hook. O card imprimia o array inteiro colado por vírgula ("claude-a,claude-b")
 * onde deveria haver uma contagem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialCard } from "./CredentialCard";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));

export function credencial(extra: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "c1",
    organization_id: "o1",
    provider: "anthropic",
    label: "Produção",
    api_key_last4: "abcd",
    validated_at: "2026-09-02T00:00:00Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...extra,
  };
}

export function montar(row: CredentialRow, props: { canWrite?: boolean; usageCount?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CredentialCard credential={row} canWrite={props.canWrite ?? true} usageCount={props.usageCount ?? 0} />
    </QueryClientProvider>,
  );
}

describe("CredentialCard — modelos", () => {
  it("mostra a CONTAGEM de modelos, nunca a lista colada", () => {
    montar(credencial({ models_available: ["claude-a", "claude-b", "claude-c"] }));
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText(/claude-a,claude-b/)).toBeNull();
  });

  it("mostra travessão quando ainda não há lista", () => {
    montar(credencial({ models_available: null }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("CredentialCard — erro de validação", () => {
  it("401 vira frase e link para pegar chave nova", () => {
    montar(credencial({ validated_at: null, validation_error: "auth_failed_401" }));
    expect(screen.getByText(/recusou a chave/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pegar chave em/ })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
    expect(screen.queryByText("auth_failed_401")).toBeNull();
  });

  it("erro de rede não oferece link: a chave não é o problema", () => {
    montar(credencial({ validated_at: null, validation_error: "network_error" }));
    expect(screen.queryByRole("link", { name: /Pegar chave em/ })).toBeNull();
  });
});

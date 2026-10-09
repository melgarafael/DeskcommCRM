/**
 * /admin/tenants/new (spec da cobrança §9). Desligada: o formulário de sempre,
 * com o rótulo "Plano". Ligada: "Plano de cobrança" no lugar, o padrão é
 * "Sem cobrança (isenta)" (nada é cobrado sem escolha explícita do dono), e o
 * rótulo antigo não vai no pedido. Escolher um plano pela tela é provado no e2e.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ criar: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/team/InterfaceEditor", () => ({ InterfaceEditor: () => null }));
vi.mock("@/hooks/useCreateTenant", () => ({ useCreateTenant: () => ({ mutateAsync: h.criar }) }));

import { NewTenantForm } from "@/app/admin/(protected)/tenants/new/_form";

const PLANO = { id: "cccccccc-0000-4000-8000-000000000001", nome: "Básico", preco_cents: 4990, intervalo: "mes", trial_dias: 14 };

beforeEach(() => {
  vi.clearAllMocks();
  h.criar.mockResolvedValue({ data: { id: "o1", slug: "loja-teste", display_name: "Loja Teste", owner_invitation: null } });
});

async function preencherEEnviar(): Promise<Record<string, unknown>> {
  const u = userEvent.setup();
  await u.type(screen.getByLabelText(/Nome de exibição/), "Loja Teste");
  await u.type(screen.getByLabelText(/E-mail do responsável/), "dono@loja.test");
  await u.click(screen.getByRole("button", { name: "Criar organização" }));
  await waitFor(() => expect(h.criar).toHaveBeenCalledTimes(1));
  return h.criar.mock.calls[0]![0] as Record<string, unknown>;
}

describe("/admin/tenants/new — os dois modos", () => {
  it("cobrança desligada: o formulário de sempre, com o rótulo de plano", async () => {
    render(<NewTenantForm cobranca={{ ligada: false, planos: [] }} />);
    expect(screen.getByRole("combobox", { name: "Plano" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Plano de cobrança" })).toBeNull();
    const enviado = await preencherEEnviar();
    expect(enviado.plan).toBe("standard");
    expect(enviado).not.toHaveProperty("plano_id");
  });

  it("cobrança ligada: plano de cobrança no lugar do rótulo; o padrão é isenta e o rótulo não vai", async () => {
    render(<NewTenantForm cobranca={{ ligada: true, planos: [PLANO] }} />);
    expect(screen.getByRole("combobox", { name: "Plano de cobrança" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Plano" })).toBeNull();
    const enviado = await preencherEEnviar();
    expect(enviado).not.toHaveProperty("plan");
    expect(enviado.plano_id).toBeUndefined();
  });
});

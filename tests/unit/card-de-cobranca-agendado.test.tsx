import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ patch: vi.fn(), refresh: vi.fn(), sucesso: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
// O card do PR 2 invalida o cache do react-query depois de cada ação (88d320480).
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: h.sucesso, error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), patch: h.patch, delete: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { CardDeCobranca } from "@/components/admin/tenants/CardDeCobranca";

const ORG = "17171717-0000-4000-8000-000000000001";
const BASICO = { id: "plano-a", nome: "Básico", arquivado_em: null };
const PRO = { id: "plano-b", nome: "Pro", arquivado_em: null };
const PAGANDO = {
  plano_id: BASICO.id, plano_agendado_id: PRO.id, estado: "ativa" as const, trial_ate: null, prazo_extra_ate: null,
  provedor: "stripe", proximo_vencimento: "2026-11-01T12:00:00Z",
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("card do tenant com a troca agendada", () => {
  it("⭐ mostra o plano novo e a partir de quando vale", () => {
    render(<CardDeCobranca orgId={ORG} planos={[BASICO, PRO]} assinatura={PAGANDO} suspensaPorCobranca={false} rotuloAntigo={null} />);
    expect(screen.getByText(/Pro, a partir de \d{2}\/\d{2}/)).toBeTruthy();
  });

  it("trocar com provedor, depois do teste: a mensagem diz que a troca foi agendada", async () => {
    h.patch.mockResolvedValue({ data: { changed: true, plano_id: BASICO.id, plano_agendado_id: PRO.id, vale_a_partir_de: PAGANDO.proximo_vencimento } });
    const u = userEvent.setup();
    render(<CardDeCobranca orgId={ORG} planos={[BASICO, PRO]} assinatura={{ ...PAGANDO, plano_agendado_id: null }} suspensaPorCobranca={false} rotuloAntigo={null} />);
    await u.selectOptions(screen.getByLabelText("Plano da empresa"), PRO.id);
    await u.click(screen.getByRole("button", { name: "Trocar plano" }));
    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Troca agendada: o novo plano vale a partir da próxima cobrança paga."));
  });
});

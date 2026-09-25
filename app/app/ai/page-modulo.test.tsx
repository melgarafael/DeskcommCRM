/**
 * B1 da revisão do #1573: a porta de "Fluxos de atendimento" aparecia no hub de
 * IA com o módulo DESLIGADO — a página não passava `modulosLigados` ao NavHub,
 * e ausente queria dizer "não filtra". O clique dava 404. Aqui o NavHub é o de
 * verdade (o `page.test.tsx` o substitui por um dublê e não via isto).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { modulosLigadosMock } = vi.hoisted(() => ({ modulosLigadosMock: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn().mockResolvedValue({ idioma: "pt-BR", is_platform_admin: false, support: false }),
  resolveActiveOrg: vi.fn().mockResolvedValue({ role: "admin", interface_settings: undefined }),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: modulosLigadosMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import AiHubPage from "./page";

afterEach(cleanup);

const porta = () => document.querySelector('a[href="/app/ai/atendimento"]');

describe("hub de IA × módulo de fluxos de atendimento", () => {
  it("desligado: o cartão NÃO aparece", async () => {
    modulosLigadosMock.mockResolvedValue([]);
    render(await AiHubPage());
    // Controle positivo: o hub desenhou (o roteador, vizinho do cartão, está lá).
    expect(document.querySelector('a[href="/app/ai/routers"]')).not.toBeNull();
    expect(porta()).toBeNull();
    expect(screen.queryByText("Fluxos de atendimento")).toBeNull();
  });

  it("ligado: o cartão aparece", async () => {
    modulosLigadosMock.mockResolvedValue(["fluxos_atendimento"]);
    render(await AiHubPage());
    expect(porta()).not.toBeNull();
  });
});

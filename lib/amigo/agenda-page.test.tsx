import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const deps = vi.hoisted(() => ({
  role: "manager",
  active: true,
  detailAuthority: "local",
  config: vi.fn(),
  local: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "staff" }),
  resolveActiveOrg: async () => ({ orgId: "org", role: deps.role, timezone: "America/Fortaleza" }),
}));
vi.mock("@/lib/amigo/agenda", () => ({
  agendaAuthority: async () => (deps.active ? { provider: "amigo" } : { provider: "local" }),
}));
vi.mock("@/lib/amigo/store", () => ({ getAmigoConfig: deps.config }));
vi.mock("@/app/app/integrations/amigo/_agenda", () => ({
  AmigoAgenda: () => <div data-testid="remote-agenda">Vagas e consultas Amigo</div>,
}));
vi.mock("@/app/app/agenda/_client", () => ({
  AgendaClient: (props: { podeMarcar: boolean }) => {
    deps.local(props);
    return <div data-testid="local-agenda">Histórico local</div>;
  },
}));
vi.mock("@/lib/agenda/google/config", () => ({
  enderecoDeRetorno: () => "/app/agenda",
  faltaParaConectarOGoogle: async () => [],
  googleEstaConfigurado: async () => false,
  origemLocalDosCabecalhos: () => null,
}));
vi.mock("@/lib/agenda/donos-da-agenda", () => ({ donosDaAgenda: async () => ({ donos: [] }) }));
vi.mock("@/lib/agenda/ocupacao-externa", () => ({
  lerOcupacaoExterna: async () => ({ blocos: [] }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "is", "gte", "lt", "order", "limit", "in"])
        q[method] = () => q;
      q.maybeSingle = async () => ({
        data: table === "calendar_appointments" ? { authority: deps.detailAuthority } : null,
      });
      q.then = (resolve: (value: unknown) => unknown) => resolve({ data: [] });
      return q;
    },
  }),
}));

import AgendaPage from "@/app/app/agenda/page";

beforeEach(() => {
  vi.clearAllMocks();
  deps.active = true;
  deps.role = "manager";
  deps.detailAuthority = "local";
  deps.config.mockResolvedValue({ active: true });
});
it("active mode presents the real Amigo flow with an explicit route to local history", async () => {
  render(await AgendaPage());
  expect(screen.getByTestId("remote-agenda")).toBeInTheDocument();
  expect(screen.queryByTestId("local-agenda")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Histórico da agenda local" })).toHaveAttribute(
    "href",
    "/app/agenda?origem=local",
  );
});
it("local history remains visible while creation stays with Amigo", async () => {
  render(await AgendaPage({ searchParams: Promise.resolve({ origem: "local" }) }));
  expect(screen.getByTestId("local-agenda")).toBeInTheDocument();
  expect(deps.local).toHaveBeenCalledWith(
    expect.objectContaining({ podeMarcar: false, autoridadeDaAgenda: "local" }),
  );
  expect(screen.getByRole("link", { name: "Voltar à agenda Amigo" })).toHaveAttribute(
    "href",
    "/app/agenda",
  );
});
it("existing local detail links resolve by appointment authority even without the origin query", async () => {
  render(
    await AgendaPage({
      searchParams: Promise.resolve({ compromisso: "af050000-0000-4000-8000-000000000031" }),
    }),
  );
  expect(screen.getByTestId("local-agenda")).toBeInTheDocument();
  expect(deps.local).toHaveBeenCalledWith(
    expect.objectContaining({ autoridadeDaAgenda: "local", podeMarcar: false }),
  );
});
it("external detail links keep their Amigo authority", async () => {
  deps.detailAuthority = "amigo";
  render(
    await AgendaPage({
      searchParams: Promise.resolve({ compromisso: "af050000-0000-4000-8000-000000000031" }),
    }),
  );
  expect(screen.getByTestId("remote-agenda")).toBeInTheDocument();
  expect(screen.queryByTestId("local-agenda")).not.toBeInTheDocument();
});
it("viewer sees guidance without receiving a mutation UI or loading configuration", async () => {
  deps.role = "viewer";
  render(await AgendaPage());
  expect(screen.queryByTestId("remote-agenda")).not.toBeInTheDocument();
  expect(deps.config).not.toHaveBeenCalled();
  expect(screen.getByText(/Peça à equipe/)).toBeInTheDocument();
});

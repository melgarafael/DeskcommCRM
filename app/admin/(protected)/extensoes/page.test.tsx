import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/admin/extensoes` e o atraso do módulo conectado (spec 33, F5 T3). A função do banco conta por organização;
 * aqui se prova o que a tela faz com o que ela devolve: sem módulo conectado nada muda, em dia não tem selo,
 * atrasado tem selo e a frase da LGPD, e a tela nunca nomeia a empresa.
 */

const mocks = vi.hoisted(() => ({
  instalacoes: [] as unknown[],
  rpc: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ is_platform_admin: true, locale: "pt-BR" })),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-interno-do-servidor-0123456789" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: (tabela: string) => {
      const dados = tabela === "extension_installations" ? mocks.instalacoes : [];
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "order", "is", "eq", "in"]) cadeia[m] = () => cadeia;
      cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
      return cadeia;
    },
  }),
}));

import Page from "./page";

const AGORA = Date.parse("2026-11-05T12:00:00.000Z");
const horasAtras = (h: number) => new Date(AGORA - h * 3_600_000).toISOString();

function instalacao(id: string, name: string, profile: "connected" | "declarative") {
  return {
    id,
    publisher: "acme",
    name,
    version: "1.0.0",
    installed_at: horasAtras(500),
    disabled_at: null,
    extension_artifacts: { manifest: { profile } },
  };
}

async function abrir() {
  render(await Page());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  mocks.rpc.mockReset();
  mocks.instalacoes = [];
});

describe("/admin/extensoes: atraso do módulo conectado", () => {
  it("sem módulo conectado a tela não lê atraso e não mostra leitura", async () => {
    mocks.instalacoes = [instalacao("i1", "guia", "declarative")];
    await abrir();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(screen.queryByText("Leitura dos avisos pelo módulo")).toBeNull();
    expect(screen.getByTestId("extensao-acme-guia")).toBeTruthy();
  });

  it("módulo em dia mostra o cursor e nenhum selo", async () => {
    mocks.instalacoes = [instalacao("i1", "servico", "connected")];
    mocks.rpc.mockResolvedValue({
      data: [{ last_event_id: 12, last_read_at: horasAtras(1), lag: 0, contacts_pending: 0, oldest_unread_at: null }],
      error: null,
    });
    await abrir();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_extensions_events_lag", { p_installation: "i1" });
    expect(screen.getByTestId("leitura-eventos-acme-servico-0").textContent).toContain("#12");
    expect(screen.getByTestId("leitura-eventos-acme-servico-0").textContent).toContain("em dia");
    expect(screen.queryByText("Atrasado")).toBeNull();
  });

  it("atraso recente (leu há 2 h) não tem selo", async () => {
    mocks.instalacoes = [instalacao("i1", "servico", "connected")];
    mocks.rpc.mockResolvedValue({
      data: [{ last_event_id: 3, last_read_at: horasAtras(2), lag: 4, contacts_pending: 2, oldest_unread_at: horasAtras(1) }],
      error: null,
    });
    await abrir();
    expect(screen.queryByText("Atrasado")).toBeNull();
    expect(screen.getByTestId("leitura-eventos-lgpd-acme-servico-0").textContent).toContain(
      "Este módulo ainda não apagou os dados de 2 contato(s) anonimizado(s).",
    );
  });

  it("atrasado (leu há 30 h e faltam eventos) tem selo e a frase da LGPD", async () => {
    mocks.instalacoes = [instalacao("i1", "servico", "connected")];
    mocks.rpc.mockResolvedValue({
      data: [{ last_event_id: 3, last_read_at: horasAtras(30), lag: 5, contacts_pending: 3, oldest_unread_at: horasAtras(29) }],
      error: null,
    });
    await abrir();
    expect(screen.getByTestId("selo-atrasado-acme-servico-0")).toBeTruthy();
    expect(screen.getByTestId("leitura-eventos-lgpd-acme-servico-0").textContent).toContain("3 contato(s)");
  });

  it("nunca leu e há evento com mais de 24 h: selo; nunca leu e evento de 1 h: sem selo", async () => {
    mocks.instalacoes = [instalacao("i1", "servico", "connected")];
    mocks.rpc.mockResolvedValue({
      data: [
        { last_event_id: null, last_read_at: null, lag: 2, contacts_pending: 2, oldest_unread_at: horasAtras(48) },
        { last_event_id: null, last_read_at: null, lag: 1, contacts_pending: 1, oldest_unread_at: horasAtras(1) },
      ],
      error: null,
    });
    await abrir();
    expect(screen.getByTestId("selo-atrasado-acme-servico-0")).toBeTruthy();
    expect(screen.queryByTestId("selo-atrasado-acme-servico-1")).toBeNull();
    expect(screen.getByTestId("leitura-eventos-acme-servico-0").textContent).toContain("ainda não leu nenhum aviso");
  });

  it("duas organizações: cada vínculo mostra o próprio atraso, sem misturar, e nenhuma é nomeada", async () => {
    mocks.instalacoes = [instalacao("i1", "servico", "connected")];
    mocks.rpc.mockResolvedValue({
      data: [
        { last_event_id: 1, last_read_at: horasAtras(30), lag: 7, contacts_pending: 7, oldest_unread_at: horasAtras(29) },
        { last_event_id: 9, last_read_at: horasAtras(1), lag: 0, contacts_pending: 0, oldest_unread_at: null },
      ],
      error: null,
    });
    await abrir();
    const a = screen.getByTestId("leitura-eventos-acme-servico-0").textContent ?? "";
    const b = screen.getByTestId("leitura-eventos-acme-servico-1").textContent ?? "";
    expect(a).toContain("7 aviso(s) por ler");
    expect(a).toContain("Atrasado");
    expect(b).toContain("em dia");
    expect(b).not.toContain("Atrasado");
    expect(screen.queryByTestId("selo-atrasado-acme-servico-1")).toBeNull();
  });

  it("falha ao ler o atraso: a tela segue sem inventar número", async () => {
    mocks.instalacoes = [instalacao("i1", "servico", "connected")];
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "x" } });
    await abrir();
    expect(screen.queryByText("Leitura dos avisos pelo módulo")).toBeNull();
    expect(screen.getByTestId("extensao-acme-servico")).toBeTruthy();
  });
});

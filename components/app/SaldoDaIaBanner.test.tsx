// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SaldoDaIaBanner } from "./SaldoDaIaBanner";

const estado = vi.hoisted(() => ({
  role: "agent",
  avisos: [{ provider: "openai", atendimento: true }],
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org", role: estado.role } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { avisos: estado.avisos } }),
}));

afterEach(cleanup);

describe("aviso de saldo da IA", () => {
  it("orienta a recepção a continuar pelo Inbox e oculta a faixa na recuperação", () => {
    estado.role = "agent";
    estado.avisos = [{ provider: "openai", atendimento: true }];
    const tela = render(<SaldoDaIaBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("OpenAI");
    expect(screen.getByRole("alert")).toHaveTextContent("responda pelo Inbox");
    expect(screen.queryByRole("link")).toBeNull();

    estado.avisos = [];
    tela.rerender(<SaldoDaIaBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("oferece acesso aos provedores à gerência e protege o aviso de quem não atende", () => {
    estado.role = "manager";
    estado.avisos = [{ provider: "anthropic", atendimento: false }];
    const tela = render(<SaldoDaIaBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Anthropic");
    expect(screen.getByRole("alert")).toHaveTextContent("em uma etapa da IA");
    expect(screen.getByRole("alert")).not.toHaveTextContent("responda pelo Inbox");
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/ai/providers");

    estado.role = "viewer";
    tela.rerender(<SaldoDaIaBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

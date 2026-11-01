import { beforeEach, describe, expect, it, vi } from "vitest";

const { marcaDaSaida } = vi.hoisted(() => ({ marcaDaSaida: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida }));
// Mantém a leitura isolada se o manifest também consumir o ícone configurado.
vi.mock("@/lib/branding/instalacao", () => ({
  marcaDaInstalacao: vi.fn().mockResolvedValue(null),
}));
// A descrição segue o Accept-Language; fora de uma requisição, cabeçalho vazio.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import manifest, { dynamic } from "@/app/manifest";

beforeEach(() => {
  marcaDaSaida.mockReset();
});

describe("nome do app instalado acompanha a instalação em runtime", () => {
  it("impede prerender com a marca de quem construiu a imagem", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("lê nome e nome curto da marca da instalação, sem escolher organização", async () => {
    marcaDaSaida.mockResolvedValue({ nome: "Central de atendimento" });
    const atual = await manifest();
    expect(atual.name).toBe("Central de atendimento");
    expect(atual.short_name).toBe("Central de atendimento");
    expect(marcaDaSaida).toHaveBeenCalledWith(null);
  });

  it("nova leitura acompanha troca de nome, preservando a identidade de navegação", async () => {
    marcaDaSaida.mockResolvedValueOnce({ nome: "Central anterior" });
    const antes = await manifest();
    marcaDaSaida.mockResolvedValueOnce({ nome: "Central atual" });
    const depois = await manifest();
    expect(antes.name).toBe("Central anterior");
    expect(depois.name).toBe("Central atual");
    expect(depois.short_name).toBe("Central atual");
    expect(depois.start_url).toBe(antes.start_url);
    expect(depois.scope).toBe(antes.scope);
  });

  it("declara cor de fundo e de tema da régua, sem media query (o manifest não aceita)", async () => {
    marcaDaSaida.mockResolvedValue({ nome: "Central" });
    const atual = await manifest();
    expect(atual.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(atual.theme_color).toBe(atual.background_color);
  });
});

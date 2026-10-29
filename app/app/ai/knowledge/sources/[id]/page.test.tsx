import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A PÁGINA DO MATERIAL (#3059) — o endereço que abre para LER o conteúdo.
 *
 * A lista do acervo só oferecia "Ver o que ele aprendeu" (os pedaços do índice):
 * não havia porta nenhuma para o texto legível do material, e a equipe mantinha
 * um sistema externo para consultar o que já estava guardado aqui.
 *
 * Este arquivo mede as duas metades que a página precisa cumprir:
 *
 *  1. **papel** — a MESMA régua da tela do acervo (`page.tsx:39`): quem é
 *     `manager` ou acima lê; abaixo disso vai para `/403`. Sem isso a leitura
 *     viraria uma porta lateral para o material da empresa.
 *  2. **render** — o conteúdo legível chega à tela: o texto guardado, ou os
 *     pares de pergunta e resposta com os rótulos certos.
 *
 * A leitura em si (blob, itens, índice) é medida em
 * `app/api/v1/ai/knowledge/sources/[id]/conteudo/route.test.ts` — aqui a função
 * é dublada para que o recorte seja a página, não o banco.
 */

const {
  requireAuthMock,
  resolveActiveOrgMock,
  createClientMock,
  redirectMock,
  notFoundMock,
  lerMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
  redirectMock: vi.fn(),
  notFoundMock: vi.fn(),
  lerMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock, notFound: notFoundMock }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={typeof href === "string" ? href : ""}>{children as never}</a>
  ),
}));
vi.mock("@/lib/ai/knowledge/conteudo-do-material", () => ({ lerConteudoDoMaterial: lerMock }));

import MaterialPage from "./page";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const FONTE = "66666666-6666-4666-8666-666666666666";

const MATERIAL_BASE = {
  nome: "Política de troca",
  tipo: "documento",
  origem: "arquivo",
  itens: null,
  conteudo: "Troca em até 7 dias.",
  total: 1,
  truncado: false,
  motivo: null,
};

async function renderizar(): Promise<string> {
  const el = await MaterialPage({ params: Promise.resolve({ id: FONTE }) });
  return renderToStaticMarkup(el as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // O `redirect()` do Next LANÇA: a execução não segue depois dele. Um dublê que
  // só registra a chamada deixaria a página continuar e LER o material — e o
  // vermelho seria do dublê, não do portão de papel.
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
  createClientMock.mockResolvedValue({ from: vi.fn() });
  requireAuthMock.mockResolvedValue({
    id: "user-1",
    idioma: "pt",
    is_platform_admin: false,
    support: false,
  });
  resolveActiveOrgMock.mockResolvedValue({ orgId: ORG_ID, role: "manager" });
  lerMock.mockResolvedValue({ ok: true, material: MATERIAL_BASE });
});

describe("ler o material na tela (#3059)", () => {
  it("papel manager abre o material e o texto legível chega à tela", async () => {
    const html = await renderizar();

    expect(redirectMock).not.toHaveBeenCalled();
    expect(lerMock).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_ID, sourceId: FONTE });
    expect(html).toContain("Troca em até 7 dias.");
    expect(html).toContain("Política de troca");
    // A porta de volta para o acervo: sem ela, a página é um beco sem saída.
    expect(html).toContain('href="/app/ai/knowledge/sources"');
  });

  it("o FAQ abre com os rótulos de pergunta e resposta", async () => {
    lerMock.mockResolvedValue({
      ok: true,
      material: {
        ...MATERIAL_BASE,
        tipo: "faq",
        origem: "faq",
        conteudo: null,
        itens: [{ question: "Qual o prazo?", answer: "7 dias." }],
        total: 1,
      },
    });

    const html = await renderizar();

    expect(html).toContain("Qual o prazo?");
    expect(html).toContain("7 dias.");
    const pergunta = html.indexOf("Pergunta");
    const resposta = html.indexOf("Resposta");
    expect(pergunta).toBeGreaterThan(-1);
    expect(resposta).toBeGreaterThan(pergunta);
  });

  it("papel abaixo de manager é mandado para /403, e a leitura nem acontece", async () => {
    resolveActiveOrgMock.mockResolvedValue({ orgId: ORG_ID, role: "agent" });

    await expect(MaterialPage({ params: Promise.resolve({ id: FONTE }) })).rejects.toThrow(
      "NEXT_REDIRECT:/403",
    );

    expect(redirectMock).toHaveBeenCalledWith("/403");
    expect(lerMock).not.toHaveBeenCalled();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("material de outra organização (ou inexistente) vira 404, e não tela vazia", async () => {
    lerMock.mockResolvedValue({ ok: false, falha: "nao_encontrado" });

    await MaterialPage({ params: Promise.resolve({ id: FONTE }) });

    expect(notFoundMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

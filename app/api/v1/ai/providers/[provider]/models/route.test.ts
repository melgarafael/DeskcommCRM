import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

/**
 * O SELETOR DE MODELO DO ATENDENTE NÃO OFERECE MODELO DE BUSCA.
 *
 * MEDIDO numa instalação fresca (issue #1694, item 1): IA › Agentes › Modelo
 * listava "Text Embedding 3 Small" — o modelo que indexa o material do RAG,
 * que não conversa. Um leigo escolhia e ficava com um atendente mudo.
 *
 * Esta rota é a ÚNICA fonte do `ModelPicker`, então o filtro mora aqui e
 * alcança todos os seletôres de uma vez. A régua é `supports_tools`, a mesma
 * que `escolherModeloDoProvedor` usa para escolher o modelo sozinho: sem
 * ferramenta o modelo devolve texto plausível e nada chega ao funil.
 *
 * O filtro é em memória (e não `eq` no banco) de propósito: o dublê abaixo
 * devolve a lista inteira, como o PostgREST devolveria sem where — assim o
 * teste enxerga a REGRA. Com `eq("supports_tools", true)` o verde seria do
 * dublê, não do código.
 */

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "33333333-3333-4333-8333-333333333333";

/** Uma linha de `ai_models` — só o que a rota lê. */
interface LinhaDeModelo {
  id: string;
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  is_default_for_provider: boolean;
}

/** O que o catálogo de `openai` devolve hoje, incluindo a linha do defeito. */
const CATALOGO: LinhaDeModelo[] = [
  {
    id: "m1",
    provider: "openai",
    model_id: "gpt-5-mini",
    display_name: "GPT-5 Mini",
    supports_tools: true,
    is_default_for_provider: true,
  },
  {
    id: "m2",
    provider: "openai",
    model_id: "text-embedding-3-small",
    display_name: "Text Embedding 3 Small",
    supports_tools: false,
    is_default_for_provider: false,
  },
  {
    id: "m3",
    provider: "openai",
    model_id: "text-embedding-3-large",
    display_name: "Text Embedding 3 Large",
    supports_tools: false,
    is_default_for_provider: false,
  },
];

/**
 * Dublê do cliente Supabase: uma query builder encadeável E thenável, porque a
 * rota faz `await supabase.from(...).select(...).eq(...).is(...).order(...)`.
 * Devolve o catálogo inteiro — é o banco, não o filtro, quem manda.
 */
function stubDoBanco(linhas: LinhaDeModelo[]) {
  return {
    from(tabela: string) {
      if (tabela !== "ai_models") throw new Error(`tabela inesperada: ${tabela}`);
      const cadeia: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "is", "order", "limit"]) {
        cadeia[metodo] = () => cadeia;
      }
      cadeia.then = (aoOk: unknown, aoErr: unknown) =>
        Promise.resolve({ data: linhas, error: null }).then(aoOk as never, aoErr as never);
      return cadeia;
    },
  };
}

function autorizado() {
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    email: "dono@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
  } as unknown as AuthUser);
  vi.mocked(resolveActiveOrg).mockResolvedValue({
    orgId: ORG_ID,
    role: "admin",
  } as unknown as Awaited<ReturnType<typeof resolveActiveOrg>>);
}

function listar(provider = "openai") {
  const req = new NextRequest(`http://localhost/api/v1/ai/providers/${provider}/models`);
  return import("./route").then(({ GET }) =>
    GET(req, { params: Promise.resolve({ provider }) }),
  );
}

describe("GET /api/v1/ai/providers/:provider/models — o que o agente pode escolher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autorizado();
    vi.mocked(createClient).mockResolvedValue(
      stubDoBanco(CATALOGO) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
  });

  it("não oferece modelo de busca ao atendente", async () => {
    const res = await listar();
    expect(res.status).toBe(200);

    const corpo = (await res.json()) as { data: { models: LinhaDeModelo[] } };
    const ids = corpo.data.models.map((m) => m.model_id);

    expect(ids, "embedding entrou na lista de modelos do agente").toEqual(["gpt-5-mini"]);
    expect(ids).not.toContain("text-embedding-3-small");
    expect(JSON.stringify(corpo)).not.toContain("Text Embedding");
  });

  it("o padrão do provedor continua vindo primeiro", async () => {
    const res = await listar();
    const corpo = (await res.json()) as { data: { models: LinhaDeModelo[] } };
    expect(corpo.data.models[0]?.is_default_for_provider).toBe(true);
  });

  it("catálogo só com modelos de busca devolve lista vazia, não o embedding", async () => {
    vi.mocked(createClient).mockResolvedValue(
      stubDoBanco(CATALOGO.filter((m) => !m.supports_tools)) as unknown as Awaited<
        ReturnType<typeof createClient>
      >,
    );

    const res = await listar();
    const corpo = (await res.json()) as { data: { models: LinhaDeModelo[] } };

    // Lista vazia é o estado em que o `ModelPicker` cai no campo de texto —
    // melhor do que oferecer um modelo que não conversa.
    expect(corpo.data.models).toEqual([]);
  });

  it("provedor que a lista não conhece continua 404", async () => {
    const res = await listar("provedor-fantasma");
    expect(res.status).toBe(404);
  });
});

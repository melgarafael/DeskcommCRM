import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LISTA DE MODELOS DA ASSINATURA SÓ É REGRAVADA A PARTIR DE UMA RESPOSTA QUE
 * SE ENTENDE (#2456, pedido do autor na triagem).
 *
 * `models_available` é o que o "Publicar" confere (0592). Um 200 da OpenAI num
 * formato que não conhecemos virava `[]` gravado por cima da lista válida, e
 * todo publish da empresa passava a responder `model_not_found`.
 *
 * Sabotagem que confirma: trocar o `return []` da guarda pelo antigo
 * `rows = []` deixa o primeiro caso vermelho (o `update` é chamado com `[]`).
 */

const update = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({ access_token: "at" })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) cadeia[m] = () => cadeia;
      cadeia.maybeSingle = async () => ({ data: { id: "cred-1" }, error: null });
      cadeia.update = (valores: unknown) => {
        update(valores);
        const filtro: Record<string, unknown> = {};
        filtro.eq = () => filtro;
        return filtro;
      };
      return cadeia;
    },
  }),
}));

import { listarModelosDaAssinatura } from "./modelos-da-assinatura";

function respondeCom(corpo: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(corpo), { status: 200 })));
}

beforeEach(() => update.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("listarModelosDaAssinatura", () => {
  it("200 em formato desconhecido não apaga a lista gravada", async () => {
    respondeCom({ data: [{ id: "gpt-x" }] });
    expect(await listarModelosDaAssinatura("org-1")).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("formato conhecido regrava a lista com os modelos listáveis (controle)", async () => {
    respondeCom({ models: [{ slug: "gpt-a", visibility: "list" }, { slug: "gpt-oculto", visibility: "hide" }] });
    const modelos = await listarModelosDaAssinatura("org-1");
    expect(modelos?.map((m) => m.model_id)).toEqual(["gpt-a"]);
    expect(update).toHaveBeenCalledWith({ models_available: ["gpt-a"] });
  });
});

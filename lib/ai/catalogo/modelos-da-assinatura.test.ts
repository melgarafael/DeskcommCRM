import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A listagem de modelos segue o contrato oficial Sign in with ChatGPT.
 *
 * A documentação da OpenAI orienta consultar `https://api.openai.com/v1/models`
 * com o mesmo token OAuth usado na inferência e filtrar `models` por
 * `visibility: "list"`:
 * https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 *
 * O QUE ESTE ARQUIVO PROVA (com fetch mockado):
 *   (a) a chamada usa o endpoint oficial e a resposta documentada grava a lista
 *       no espelho `models_available`;
 *   (b) falha HTTP continua visível e não toca o espelho;
 *   (c) um 200 em formato que não conhecemos não grava lixo — e também não
 *       engole o problema em `[]`.
 */

const update = vi.hoisted(() => vi.fn());
const semConta = vi.hoisted(() => vi.fn((): { access_token: string } | null => ({ access_token: "at" })));

vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => semConta()),
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

import {
  FalhaAoListarModelosDaAssinatura,
  listarModelosDaAssinatura,
  listarModelosDaAssinaturaOuVazio,
} from "./modelos-da-assinatura";

const ENDPOINT_OFICIAL = "https://api.openai.com/v1/models";

function stubDeFetch(resposta: () => Promise<Response>) {
  const chamada = vi.fn(resposta);
  vi.stubGlobal("fetch", chamada);
  return chamada;
}

function respondeCom(corpo: unknown, status = 200) {
  return stubDeFetch(async () => new Response(JSON.stringify(corpo), { status }));
}

beforeEach(() => {
  update.mockClear();
  semConta.mockImplementation(() => ({ access_token: "at" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("listarModelosDaAssinatura", () => {
  it("(a) consulta o catálogo oficial SIWC e regrava o espelho com a lista", async () => {
    const chamada = respondeCom({
      models: [
        { slug: "gpt-a", visibility: "list" },
        { slug: "gpt-oculto", visibility: "hide" },
      ],
    });

    const modelos = await listarModelosDaAssinatura("org-1");

    expect(chamada).toHaveBeenCalledTimes(1);
    const [url, init] = chamada.mock.calls[0] as unknown as [string, RequestInit];
    expect(url, "a listagem foi para o endpoint oficial SIWC").toBe(ENDPOINT_OFICIAL);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer at");
    expect(modelos?.map((m) => m.model_id)).toEqual(["gpt-a"]);
    expect(update).toHaveBeenCalledWith({ models_available: ["gpt-a"] });
  });

  it("(b) erro HTTP não silencia e mantém o espelho intacto", async () => {
    respondeCom(
      {
        error: { message: "Unauthorized" },
      },
      401,
    );

    const falha = await listarModelosDaAssinatura("org-1").then(
      () => null,
      (erro: unknown) => erro,
    );

    expect(falha).toBeInstanceOf(FalhaAoListarModelosDaAssinatura);
    expect((falha as FalhaAoListarModelosDaAssinatura).motivo).toBe("http_401");
    expect((falha as FalhaAoListarModelosDaAssinatura).status).toBe(401);
    expect(update, "uma falha não pode tocar no espelho").not.toHaveBeenCalled();
  });

  it("(c) 200 em formato desconhecido não grava lixo — e não engole o problema", async () => {
    respondeCom({ data: [{ id: "gpt-x" }] });

    const falha = await listarModelosDaAssinatura("org-1").then(
      () => null,
      (erro: unknown) => erro,
    );

    expect(falha).toBeInstanceOf(FalhaAoListarModelosDaAssinatura);
    expect((falha as FalhaAoListarModelosDaAssinatura).motivo).toBe("formato_de_resposta_desconhecido");
    expect(update).not.toHaveBeenCalled();
  });

  it("queda de rede também é erro visível, não um null que a rota lê como \"sem conta\"", async () => {
    stubDeFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const falha = await listarModelosDaAssinatura("org-1").then(
      () => null,
      (erro: unknown) => erro,
    );

    expect(falha).toBeInstanceOf(FalhaAoListarModelosDaAssinatura);
    expect((falha as FalhaAoListarModelosDaAssinatura).motivo).toBe("sem_resposta_da_api_de_modelos");
    expect(update).not.toHaveBeenCalled();
  });

  it("sem conta conectada continua sendo null — e nenhum fetch acontece", async () => {
    semConta.mockImplementation(() => null);
    const chamada = stubDeFetch(async () => new Response("{}", { status: 200 }));

    expect(await listarModelosDaAssinatura("org-1")).toBeNull();
    expect(chamada).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

});

describe("listarModelosDaAssinaturaOuVazio", () => {
  it("falha do backend vira lista vazia com o motivo no log — a rota não cai", async () => {
    respondeCom({ message: "denied" }, 403);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await listarModelosDaAssinaturaOuVazio("org-1")).toEqual([]);
    expect(aviso).toHaveBeenCalledWith("modelos-da-assinatura: listagem falhou", "http_403");
    expect(update).not.toHaveBeenCalled();
  });

  it("sem conta conectada continua lista vazia, sem log de falha", async () => {
    semConta.mockImplementation(() => null);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await listarModelosDaAssinaturaOuVazio("org-1")).toEqual([]);
    expect(aviso).not.toHaveBeenCalled();
  });
});

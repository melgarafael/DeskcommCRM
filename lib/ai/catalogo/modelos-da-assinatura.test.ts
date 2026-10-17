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
 *       engole o problema em `[]`;
 *   (d) o pedido leva o ID DA CONTA que o backend do Codex exige
 *       (`ChatGPT-Account-Id`), lido da credencial já gravada — sem ele uma
 *       credencial VÁLIDA respondia `http_401` (#2952).
 */

/** Um JWT de mentira: aqui só o payload interessa — quem assina é o login real. */
function jwtFalso(claims: Record<string, unknown>): string {
  const parte = (valor: unknown) => Buffer.from(JSON.stringify(valor)).toString("base64url");
  return `${parte({ alg: "none", typ: "JWT" })}.${parte(claims)}.nao-assinado`;
}

const CONTA_DO_ID_TOKEN = "conta-do-workspace-1";
const ID_TOKEN_DA_CONTA = jwtFalso({
  "https://api.openai.com/auth": { chatgpt_account_id: CONTA_DO_ID_TOKEN },
});
const ACCESS_TOKEN_DA_CONTA = jwtFalso({
  "https://api.openai.com/auth": { chatgpt_account_id: "conta-do-access-token" },
});
const TOKEN_SEM_CLAIM = jwtFalso({ sub: "user-1" });

const update = vi.hoisted(() => vi.fn());
const semConta = vi.hoisted(() =>
  vi.fn((): { access_token: string; id_token?: string } | null => ({
    access_token: "at",
    id_token: ID_TOKEN_DA_CONTA,
  })),
);

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

/** Os cabeçalhos do primeiro pedido da listagem, do jeito que saíram. */
function cabecalhosDoPedido(chamada: ReturnType<typeof stubDeFetch>): Headers {
  const [, init] = chamada.mock.calls[0] as unknown as [string, RequestInit];
  return new Headers(init.headers);
}

beforeEach(() => {
  update.mockClear();
  semConta.mockImplementation(() => ({ access_token: "at", id_token: ID_TOKEN_DA_CONTA }));
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

/**
 * (#2952) A credencial estava validada e a conversa funcionava; só a LISTAGEM
 * tomava 401, e com ela o espelho `models_available` ficava vazio — o botão
 * "Criar agente" desabilitado e todo "Publicar" em `model_not_found`. O que
 * faltava era o id da conta que o backend do Codex exige em todo pedido.
 */
describe("listarModelosDaAssinatura — o cabeçalho da conta (#2952)", () => {
  it("manda o ChatGPT-Account-Id lido da claim do id_token gravado", async () => {
    const chamada = respondeCom({ models: [{ slug: "gpt-a", visibility: "list" }] });

    await listarModelosDaAssinatura("org-1");

    const cabecalhos = cabecalhosDoPedido(chamada);
    expect(cabecalhos.get("ChatGPT-Account-Id")).toBe(CONTA_DO_ID_TOKEN);
    expect(cabecalhos.get("Authorization")).toBe("Bearer at");
  });

  it("sem a claim no id_token, o id sai do access_token da mesma sessão", async () => {
    semConta.mockImplementation(() => ({
      access_token: ACCESS_TOKEN_DA_CONTA,
      id_token: TOKEN_SEM_CLAIM,
    }));
    const chamada = respondeCom({ models: [{ slug: "gpt-a", visibility: "list" }] });

    await listarModelosDaAssinatura("org-1");

    expect(cabecalhosDoPedido(chamada).get("ChatGPT-Account-Id")).toBe("conta-do-access-token");
  });

  it("sem a claim em token nenhum o cabeçalho não é inventado — e a listagem segue", async () => {
    semConta.mockImplementation(() => ({ access_token: "at", id_token: TOKEN_SEM_CLAIM }));
    const chamada = respondeCom({ models: [{ slug: "gpt-a", visibility: "list" }] });

    const modelos = await listarModelosDaAssinatura("org-1");

    const cabecalhos = cabecalhosDoPedido(chamada);
    expect(cabecalhos.get("ChatGPT-Account-Id")).toBeNull();
    expect(cabecalhos.get("Authorization")).toBe("Bearer at");
    expect(modelos?.map((m) => m.model_id)).toEqual(["gpt-a"]);
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

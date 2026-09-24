import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As duas rotas do webhook do canal por QR — a GLOBAL (a sessão do corpo
 * resolve a organização) e a POR TOKEN (o token do caminho resolve) — e o
 * RASTRO que cada recusa deixa (issue #290).
 *
 * Até aqui só a rota global tinha teste de rota (`contrato-do-webhook-waha`),
 * e a por token, que é a de produção, só aparecia no caminho feliz do e2e. Os
 * três defeitos que este arquivo segura moram justamente na diferença entre
 * elas, ou no que as duas escreviam igual para desfechos diferentes:
 *
 *   1. a rota por token recusava, ANTES de arquivar, um campo (`session`) que
 *      ela nem usa — quem resolve ali é o token;
 *   2. a recusa do contrato gravava `received` no arquivo, a mesma palavra de
 *      um evento que deu certo;
 *   3. a recusa que acontece ANTES da autenticação saía como `error` no log,
 *      alcançável por qualquer um que conheça a URL.
 *
 * Tudo aqui é COMPORTAMENTO observado: a linha que chegou ao INSERT, o status
 * HTTP, o nível do log. Nenhum caso pergunta se um símbolo existe.
 */

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  waha_session_name: "default",
  webhook_secret_encrypted: "\\x00",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};

const TOKEN = "token-da-rota-de-producao-0001";

const arquivados: Record<string, unknown>[] = [];
const despachados: unknown[] = [];
let autenticacao: { ok: true; signatureVerified: boolean } | { ok: false; reason: string } = {
  ok: true,
  signatureVerified: true,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: async (linha: Record<string, unknown>) => {
        arquivados.push(linha);
        return { error: null };
      },
    }),
    rpc: async () => ({ data: "segredo-decifrado-longo", error: null }),
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

vi.mock("@/lib/waha/webhook-auth", () => ({
  authenticateWahaWebhook: () => autenticacao,
}));

vi.mock("@/lib/waha/ingest", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dispatchWahaEvent: async (_a: unknown, _s: unknown, envelope: unknown) => {
    despachados.push(envelope);
  },
}));

import { logger } from "@/lib/logger";
import { POST as postGlobal } from "@/app/api/v1/webhooks/waha/route";
import { POST as postPorToken } from "@/app/api/v1/webhooks/waha/[token]/route";

const pedido = (corpo: unknown) =>
  ({
    text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
    headers: new Headers({ "x-webhook-hmac": "sha512=abc" }),
  }) as never;

const ROTAS = [
  // `nivelDoEstagio1` difere por rota, e a razão está no comentário de cada uma:
  // o Caddy do kit responde 403 na rota global, então lá a recusa do estágio 1 só
  // pode vir do WAHA (o fio mudou → `error`); a rota por token é pública, e ali
  // qualquer um a provoca antes do gate de assinatura (→ `warn`).
  { nome: "global", nivelDoEstagio1: "error", chamar: (corpo: unknown) => postGlobal(pedido(corpo)) },
  {
    nome: "por token",
    nivelDoEstagio1: "warn",
    chamar: (corpo: unknown) => postPorToken(pedido(corpo), { params: Promise.resolve({ token: TOKEN }) }),
  },
] as const;

const EVENTO_VALIDO = {
  event: "message",
  session: "default",
  payload: { id: "wamid.OK", from: "5531988887777@c.us", body: "oi" },
};

/** Um telefone que, se aparecer no arquivo, é dado de cliente vazado. */
const TELEFONE = "5531988887777";

let avisos: ReturnType<typeof vi.spyOn>;
let erros: ReturnType<typeof vi.spyOn>;

/** Os níveis em que a recusa de um estágio foi registrada, na ordem. */
const niveisDoEstagio = (estagio: "roteamento" | "conteudo"): string[] => {
  const niveis: string[] = [];
  for (const [nivel, espiao] of [
    ["warn", avisos],
    ["error", erros],
  ] as const) {
    for (const chamada of espiao.mock.calls) {
      const ctx = chamada[1] as { estagio?: string } | undefined;
      if (ctx?.estagio === estagio) niveis.push(nivel);
    }
  }
  return niveis;
};

beforeEach(() => {
  arquivados.length = 0;
  despachados.length = 0;
  autenticacao = { ok: true, signatureVerified: true };
  avisos = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  erros = vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("item 1 — a rota por token não recusa, antes de arquivar, o que ela não usa", () => {
  it("`session` de tipo errado passa pelo estágio 1 e o corpo cru chega ao arquivo", async () => {
    // Na rota por token a sessão do corpo não resolve nada: quem resolve é o
    // token do caminho. Recusá-la no estágio 1 jogava fora o corpo cru antes
    // do INSERT — a evidência que a divisão em dois estágios existe para guardar.
    const corpo = { event: "message", session: 1, payload: { id: "wamid.SESS", from: "5531@c.us" } };

    await postPorToken(pedido(corpo), { params: Promise.resolve({ token: TOKEN }) });

    expect(arquivados, "o estágio 1 recusou a sessão e o corpo cru não foi arquivado").toHaveLength(1);
    expect(arquivados[0]).toMatchObject({
      raw_body: JSON.stringify(corpo),
      webhook_path_token: TOKEN,
      event_type: "message",
      external_id: "wamid.SESS",
    });
    expect(niveisDoEstagio("roteamento"), "a recusa veio do estágio 1").toEqual([]);
  });

  it("o que a sessão de tipo errado AINDA custa ali: o estágio 2 a recusa, e a linha diz isso", async () => {
    // O contrato completo (estágio 2) continua o mesmo nas duas rotas e tipa
    // `session`. A mudança do item 1 é só a ORDEM do prejuízo: agora o corpo
    // fica arquivado e marcado como recusado, em vez de sumir.
    const corpo = { event: "message", session: 1, payload: { id: "wamid.SESS" } };

    const res = await postPorToken(pedido(corpo), { params: Promise.resolve({ token: TOKEN }) });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { details: { campos: ["session"] } } });
    expect(arquivados).toHaveLength(1);
    expect(arquivados[0]).toMatchObject({ status: "error" });
    expect(String(arquivados[0]?.error_message)).toContain("session");
    expect(despachados).toHaveLength(0);
  });

  it("o estágio 1 da rota por token segue recusando o id, que vai numa coluna do arquivo", async () => {
    const res = await postPorToken(pedido({ event: "message", payload: { id: 2 } }), {
      params: Promise.resolve({ token: TOKEN }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { details: { campos: ["payload.id"] } } });
    expect(arquivados).toHaveLength(0);
  });

  it("a rota GLOBAL continua recusando a sessão no estágio 1 — lá é ela que resolve a organização", async () => {
    const res = await postGlobal(pedido({ event: "message", session: 1, payload: { id: "x" } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { details: { campos: ["session"] } } });
    expect(arquivados).toHaveLength(0);
  });

  it("nada é gravado antes da autenticação: assinatura recusada é 401 e arquivo vazio", async () => {
    autenticacao = { ok: false, reason: "invalid_signature" };

    const res = await postPorToken(pedido(EVENTO_VALIDO), { params: Promise.resolve({ token: TOKEN }) });

    expect(res.status).toBe(401);
    expect(arquivados).toHaveLength(0);
    expect(despachados).toHaveLength(0);
  });
});

describe.each(ROTAS)("rota $nome", ({ chamar, nivelDoEstagio1 }) => {
  describe("item 2 — a recusa do contrato deixa rastro distinguível no arquivo", () => {
    it("recusa do estágio 2: linha `error` com os NOMES dos campos, sem os valores", async () => {
      const corpo = {
        event: "message",
        session: "default",
        payload: { id: "wamid.RECUSADO", from: Number(TELEFONE), timestamp: TELEFONE.repeat(1500) },
      };

      const res = await chamar(corpo);

      expect(res.status).toBe(400);
      expect(arquivados, "o corpo cru se perdeu — o AC do PRD §3.3 manda arquivar").toHaveLength(1);
      const linha = arquivados[0] ?? {};
      expect(linha.raw_body).toBe(JSON.stringify(corpo));
      expect(linha.status, "a recusa gravou a mesma palavra de um evento que deu certo").toBe("error");
      const mensagem = String(linha.error_message);
      // O PREFIXO é contrato, não detalhe de formatação: a ressalva em
      // `docs/specs/03-spec-whatsapp-waha.md` manda quem for implementar o
      // `process-pending-webhooks` distinguir por ele o corpo que nunca vai
      // passar do que só falhou. `contrato-do-webhook-waha.test.ts` prende o
      // VALOR `contrato_violado` na origem; nada prendia a concatenação que
      // chega à coluna, então trocar a mensagem por só os campos quebraria a
      // spec sem nenhum vermelho.
      expect(mensagem, "o prefixo que a spec manda usar sumiu da linha arquivada").toMatch(
        /^contrato_violado: /,
      );
      expect(mensagem).toContain("payload.from");
      expect(mensagem).toContain("payload.timestamp");
      expect(mensagem, "o valor recusado (dado de cliente) vazou para o arquivo").not.toContain(TELEFONE);
      expect(despachados).toHaveLength(0);
    });

    it("evento dentro do contrato segue `received`, sem mensagem de erro", async () => {
      const res = await chamar(EVENTO_VALIDO);

      expect(res.status).toBe(200);
      expect(arquivados).toHaveLength(1);
      expect(arquivados[0]?.status).toBe("received");
      expect(arquivados[0]?.error_message ?? null).toBeNull();
      // O estágio 1 de cada rota é LOOSE: o dispatch recebe o corpo inteiro,
      // sem campo perdido no caminho.
      expect(despachados).toEqual([EVENTO_VALIDO]);
    });
  });

  describe("item 5 — o nível do log acompanha quem pode provocá-lo", () => {
    it("recusa do estágio 1 sai no nível de quem alcança AQUELA rota", async () => {
      // `payload.id` é conferido no estágio 1 das DUAS rotas, e o nível difere
      // por rota: a global é barrada pelo Caddy do kit (403), então lá a recusa
      // é sempre o fio tendo mudado e continua `error`; a rota por token é
      // pública de propósito, e ali qualquer um provoca a recusa — logo `warn`.
      const res = await chamar({ event: "message", session: "default", payload: { id: 2 } });

      expect(res.status).toBe(400);
      expect(niveisDoEstagio("roteamento")).toEqual([nivelDoEstagio1]);
    });

    it("recusa do estágio 2 (depois da autenticação) continua `error` — ali é o fio que mudou", async () => {
      const res = await chamar({ event: "message", session: "default", payload: { id: "x", from: 5 } });

      expect(res.status).toBe(400);
      expect(niveisDoEstagio("conteudo")).toEqual(["error"]);
    });
  });
});

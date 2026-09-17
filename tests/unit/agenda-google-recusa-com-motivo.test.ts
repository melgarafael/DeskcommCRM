// @vitest-environment node
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { googleTransport, GoogleHttpError } from "@/lib/agenda/google/transport";
import { classificarErroDoGoogle } from "@/lib/agenda/google/erros";
import { mensagemDaRecusaDePublicacao } from "@/lib/agenda/google/sync-executor";

/**
 * A recusa do Google na PUBLICAÇÃO volta a dizer o motivo (#950).
 *
 * O que se mede aqui é a frase que o caminho de publicação PERSISTE
 * (`google_sync_error`) quando o Google recusa uma escrita. Ela precisa dizer o
 * motivo que o Google mandou — e continuar não dizendo nada do corpo humano da
 * resposta (nome, e-mail de convidado, trecho de descrição): o motivo é o
 * identificador (`errors[].reason`), nunca o texto livre.
 */
let server: Server;
let base: string;
let respond: (res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("receiver");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(
  () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
);
beforeEach(() => {
  respond = (res) => {
    res.setHeader("content-type", "application/json; charset=UTF-8");
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "event /exact", etag: '"v2"' }));
  };
});

const api = () =>
  googleTransport("test-token", (url, init) =>
    fetch(`${base}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init),
  );

/** Publica uma escrita real contra o receiver e devolve o erro que ele lançou. */
async function recusaDaPublicacao(): Promise<unknown> {
  try {
    await api().write("primary/calendar@example.test", "event /exact", "PATCH", { summary: "x" }, '"v1"');
  } catch (e) {
    return e;
  }
  throw new Error("o receiver recusou e o transporte não lançou nada.");
}

/** O corpo de recusa do Google, com o texto humano que NÃO pode ser persistido. */
const CORPO_DA_RECUSA = {
  error: {
    code: 400,
    message: "Invalid attendee: maria.souza@exemplo.test não pode ser convidada",
    status: "INVALID_ARGUMENT",
    errors: [
      {
        domain: "global",
        reason: "invalid",
        message: "Invalid attendee: maria.souza@exemplo.test — Consulta de rotina",
      },
    ],
  },
};

describe("recusa do Google na publicação: o motivo volta para a frase persistida", () => {
  it("a frase persistida traz o motivo (invalid) e o status", async () => {
    respond = (res) => {
      res.setHeader("content-type", "application/json; charset=UTF-8");
      res.statusCode = 400;
      res.end(JSON.stringify(CORPO_DA_RECUSA));
    };
    const erro = await recusaDaPublicacao();
    const mensagem = mensagemDaRecusaDePublicacao(erro, "PATCH");
    expect(mensagem).toContain("invalid");
    expect(mensagem).toContain("HTTP 400");
  });

  it("nada do corpo humano do Google vaza para a frase persistida", async () => {
    respond = (res) => {
      res.setHeader("content-type", "application/json; charset=UTF-8");
      res.statusCode = 400;
      res.end(JSON.stringify(CORPO_DA_RECUSA));
    };
    const mensagem = mensagemDaRecusaDePublicacao(await recusaDaPublicacao(), "PATCH");
    expect(mensagem).not.toContain("maria.souza@exemplo.test");
    expect(mensagem).not.toContain("Invalid attendee");
    expect(mensagem).not.toContain("Consulta de rotina");
    expect(mensagem).not.toContain("@");
  });

  it("recusa de cota do Google é lida como esperar, não como falta de permissão", async () => {
    respond = (res) => {
      res.setHeader("content-type", "application/json; charset=UTF-8");
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          error: {
            code: 403,
            message: "Quota exceeded for quota metric 'Queries'",
            errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
          },
        }),
      );
    };
    const erro = await recusaDaPublicacao();
    expect(classificarErroDoGoogle(erro, "atualizar").desfecho).toBe("recuar");
    expect(mensagemDaRecusaDePublicacao(erro, "PATCH").toLowerCase()).toContain("ratelimitexceeded");
  });

  it("classificar o erro lançado pelo transporte enxerga status e motivo", async () => {
    respond = (res) => {
      res.setHeader("content-type", "application/json; charset=UTF-8");
      res.statusCode = 400;
      res.end(JSON.stringify(CORPO_DA_RECUSA));
    };
    const erro = await recusaDaPublicacao();
    expect(erro).toBeInstanceOf(GoogleHttpError);
    expect(classificarErroDoGoogle(erro, "atualizar")).toMatchObject({
      desfecho: "permanente",
      status: 400,
      motivo: "invalid",
    });
  });

  it("corpo de erro que não é JSON não quebra a recusa nem inventa motivo", async () => {
    respond = (res) => {
      res.setHeader("content-type", "text/html");
      res.statusCode = 502;
      res.end("<html><body>Bad gateway</body></html>");
    };
    const erro = await recusaDaPublicacao();
    expect(erro).toBeInstanceOf(GoogleHttpError);
    const mensagem = mensagemDaRecusaDePublicacao(erro, "PATCH");
    expect(mensagem).toContain("HTTP 502");
    expect(mensagem).not.toContain("Bad gateway");
    expect(classificarErroDoGoogle(erro, "atualizar").desfecho).toBe("transitorio");
  });

  it("corpo JSON que não é do Google não leva texto livre para a frase persistida", async () => {
    // Um proxy no meio pode responder JSON com a MESMA forma e texto humano no
    // lugar do identificador. Só o que tem formato de `reason` entra na frase.
    for (const corpo of [
      { error: "Maria maria@x.test recusou" },
      { errors: [{ reason: "Convidado joao@y.test inválido" }] },
    ]) {
      respond = (res) => {
        res.setHeader("content-type", "application/json; charset=UTF-8");
        res.statusCode = 400;
        res.end(JSON.stringify(corpo));
      };
      const mensagem = mensagemDaRecusaDePublicacao(await recusaDaPublicacao(), "PATCH");
      expect(mensagem).toContain("HTTP 400");
      expect(mensagem).not.toContain("@");
    }
  });

  it("404 do CALENDÁRIO depois do evento sumido não vira 'evento sumiu' nem 'já estava feito'", async () => {
    respond = (res) => {
      res.setHeader("content-type", "application/json; charset=UTF-8");
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 404, errors: [{ reason: "notFound" }] } }));
    };
    const leitura = await api()
      .get("primary/calendar@example.test", "event /exact")
      .then(() => null, (e: unknown) => e);
    expect(mensagemDaRecusaDePublicacao(leitura, "PATCH")).toContain("o calendário do Google não existe mais");
    const apagar = await api()
      .write("primary/calendar@example.test", "event /exact", "DELETE", undefined, '"v1"')
      .then(() => null, (e: unknown) => e);
    expect(mensagemDaRecusaDePublicacao(apagar, "DELETE")).toContain("o calendário do Google não existe mais");
  });
});

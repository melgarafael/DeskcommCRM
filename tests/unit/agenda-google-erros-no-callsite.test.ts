// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { mensagemDaRecusaDeLeitura } from "@/lib/agenda/google/calendar-executor";
import { GoogleHttpError, googleTransport } from "@/lib/agenda/google/transport";

const RAIZ = process.cwd();

function catchDaFuncao(caminho: string, nome: string, marcador: string): string {
  const texto = readFileSync(join(RAIZ, caminho), "utf8");
  const fonte = ts.createSourceFile(caminho, texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const catches: string[] = [];

  const visita = (no: ts.Node): void => {
    if (ts.isFunctionDeclaration(no) && no.name?.text === nome) {
      const procuraCatch = (filho: ts.Node): void => {
        if (ts.isCatchClause(filho)) catches.push(filho.getText(fonte));
        ts.forEachChild(filho, procuraCatch);
      };
      procuraCatch(no);
      return;
    }
    ts.forEachChild(no, visita);
  };

  visita(fonte);
  const resultado = catches.find((bloco) => bloco.includes(marcador)) ?? "";
  expect(
    resultado,
    `não encontrei em ${nome} o catch responsável por ${marcador}`,
  ).not.toBe("");
  return resultado;
}

async function recusaNaLeitura(): Promise<unknown> {
  const corpo = {
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "Invalid attendee: maria.souza@exemplo.test não pode ser convidada",
      errors: [
        {
          domain: "global",
          reason: "invalid",
          message: "Invalid attendee: maria.souza@exemplo.test — Consulta de rotina",
        },
      ],
    },
  };
  const api = googleTransport("test-token", async () =>
    new Response(JSON.stringify(corpo), {
      status: 400,
      headers: { "content-type": "application/json; charset=UTF-8" },
    }),
  );

  return api
    .page("primary/calendar@example.test", {
      generation: "00000000-0000-4000-8000-000000000001",
      mode: "incremental",
      base_sync_token: "sync-token",
      page_token: null,
      window_start: "2026-09-17T00:00:00.000Z",
      window_end: "2026-09-18T00:00:00.000Z",
    })
    .then(
      () => null,
      (erro: unknown) => erro,
    );
}

describe("erros do Google são sanitizados no ponto que os persiste", () => {
  it("a leitura incremental preserva motivo/status sem persistir texto humano", async () => {
    const erro = await recusaNaLeitura();
    expect(erro).toBeInstanceOf(GoogleHttpError);

    const mensagem = mensagemDaRecusaDeLeitura(erro);
    expect(mensagem).toContain("invalid");
    expect(mensagem).toContain("HTTP 400");
    expect(mensagem).not.toContain("maria.souza@exemplo.test");
    expect(mensagem).not.toContain("Invalid attendee");
    expect(mensagem).not.toContain("Consulta de rotina");
    expect(mensagem).not.toContain("@");
  });

  it("erro local de leitura continua com frase genérica, sem ecoar detalhe livre", () => {
    const mensagem = mensagemDaRecusaDeLeitura(
      new Error("segredo interno maria.souza@exemplo.test"),
    );
    expect(mensagem).toBe(
      "A leitura não terminou. Tente sincronizar novamente nas configurações.",
    );
    expect(mensagem).not.toContain("@");
  });

  it("a publicação persiste a função sanitizada no catch real, não e.message", () => {
    const catchReal = catchDaFuncao(
      "lib/agenda/google/sync-executor.ts",
      "reconcileAppointment",
      "mensagemDaRecusaDePublicacao",
    );
    expect(catchReal).toContain("mensagemDaRecusaDePublicacao(e, metodoEmVoo)");
    expect(catchReal).toContain('call("error", { message, failure_kind: classification })');
    expect(catchReal).not.toMatch(/\be\.message\b/);
  });

  it("a leitura persiste a função sanitizada no catch real, não e.message", () => {
    const catchReal = catchDaFuncao(
      "lib/agenda/google/calendar-executor.ts",
      "syncCalendar",
      "mensagemDaRecusaDeLeitura",
    );
    expect(catchReal).toContain("mensagemDaRecusaDeLeitura(e)");
    expect(catchReal).not.toMatch(/\be\.message\b/);
  });
});

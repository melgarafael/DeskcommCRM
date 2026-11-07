/**
 * RESPOSTA MONTADA À MÃO CARIMBA O X-Request-Id (#4107).
 *
 * Desde o #3991, `ok()`/`fail()` já devolvem o header; o que faltava eram as
 * montagens À MÃO (`new Response`, `new NextResponse`, `NextResponse.json`,
 * `NextResponse.redirect`) sob `/api/`, que saíam sem `X-Request-Id` — a
 * requisição ficava sem id correlacionável nem no registro nem na resposta.
 *
 * ═══ O que este arquivo prende ═══
 *
 *  1. O `comIdDaRequisicao()` carimba o id da REQUISIÇÃO (o `x-request-id` que o
 *     proxy pôs e que o audit grava) — não um UUID novo; preserva um id que a
 *     rota já carimbou ela mesma (é o id da auditoria dela); e reescreve a
 *     resposta quando os cabeçalhos são IMUTÁVEIS (todo `Response.redirect`).
 *  2. CATRACA ESTÁTICA: nenhuma montagem à mão sob `app/api` (todo `route.ts`) sai sem
 *     carimbo. Ou está dentro de `comIdDaRequisicao(...)`, ou o próprio bloco
 *     declara `X-Request-Id`. Lista de exceções vazia, como a da #3971.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextResponse } from "next/server";

const RAIZ = join(__dirname, "..", "..");

// Import DINÂMICO: na base (o caso do vermelho) o helper ainda não existe, e a
// importação estática derrubaria o arquivo inteiro ANTES da catraca rodar. O
// vermelho tem de chegar na lista de rotas e na falha do carimbo — não no
// crash do módulo — então o helper é resolvido dentro de cada caso.
async function comId(): Promise<
  (res: Response, reqOuId: Request | string | null | undefined) => Response
> {
  const mod = await import("@/lib/api/wrappers");
  if (typeof mod.comIdDaRequisicao !== "function") {
    throw new Error(
      "comIdDaRequisicao não existe em lib/api/wrappers — resposta montada à mão sem carimbo (#4107)",
    );
  }
  return mod.comIdDaRequisicao;
}

describe("comIdDaRequisicao", () => {
  it("carimba o id que veio na requisição — o mesmo que a rota grava no log", async () => {
    const req = new Request("http://x/api/v1/algo", {
      headers: { "x-request-id": "11111111-1111-4111-8111-111111111111" },
    });
    const res = (await comId())(new Response("csv", { status: 200 }), req);
    expect(res.headers.get("X-Request-Id")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("o id é o MESMO que ok() põe: header da resposta == id que a rota resolve", async () => {
    // A régua da issue: o header da montagem à mão tem de ser o id que a rota
    // já resolveu para auditoria. `ok()` com o MESMO requestId do header produz
    // o MESMO `X-Request-Id` que o carimbo — um segundo UUID na resposta é o
    // defeito da #3971, e aqui ele é impossível por construção.
    const mod = await import("@/lib/api/wrappers");
    const id = "6aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const req = new Request("http://x/api/v1/algo", { headers: { "x-request-id": id } });
    const aMao = await mod.comIdDaRequisicao(new Response("csv"), req);
    const wrapper = mod.ok({ ok: true }, { requestId: req.headers.get("x-request-id")! });
    expect(aMao.headers.get("X-Request-Id")).toBe(wrapper.headers.get("X-Request-Id"));
  });

  it("não troca o id que a rota já carimbou: o dela vale (é o que foi à auditoria)", async () => {
    const req = new Request("http://x/api/v1/algo", {
      headers: { "x-request-id": "22222222-2222-4222-8222-222222222222" },
    });
    const res = (await comId())(
      new Response("ok", { status: 200, headers: { "X-Request-Id": "33333333-3333-4333-8333-333333333333" } }),
      req,
    );
    expect(res.headers.get("X-Request-Id")).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("aceita o requestId resolvido pela rota direto, sem a requisição", async () => {
    const res = (await comId())(
      new Response(null, { status: 503 }),
      "44444444-4444-4444-8444-444444444444",
    );
    expect(res.headers.get("X-Request-Id")).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("cabeçalhos imutáveis (Response.redirect puro): reescreve mantendo status e location", async () => {
    const req = new Request("http://x/api/v1/algo", {
      headers: { "x-request-id": "55555555-5555-4555-8555-555555555555" },
    });
    // `Response.redirect()` da especificação devolve cabeçalhos IMUTÁVEIS — é o
    // caso que o `catch` do helper cobre (o avatar o documenta na própria rota).
    const base = Response.redirect("https://destino.exemplo/ok", 302);
    expect(() => base.headers.set("X-Request-Id", "x")).toThrow(); // premissa: imutável
    const res = (await comId())(base, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://destino.exemplo/ok");
    expect(res.headers.get("X-Request-Id")).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("NextResponse.redirect (cabeçalho mutável): carimba e continua aceitando cookie", async () => {
    const req = new Request("http://x/api/v1/algo", {
      headers: { "x-request-id": "77777777-7777-4777-8777-777777777777" },
    });
    const base = NextResponse.redirect("https://destino.exemplo/ok", 302);
    const res = (await comId())(base, req) as NextResponse;
    expect(res.headers.get("X-Request-Id")).toBe("77777777-7777-4777-8777-777777777777");
    // os callbacks de OAuth põem cookie de limpeza NA RESPOSTA devolvida:
    // se o helper a reconstruísse como `Response` puro, isto lançaria.
    expect(() => res.cookies.set("outro", "1", { path: "/" })).not.toThrow();
  });

  it("sem id na requisição nem na rota: nasce um, e a resposta sai com header", async () => {
    const req = new Request("http://x/api/v1/algo");
    const res = (await comId())(new Response(null, { status: 404 }), req);
    expect(res.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

/** Todo construtor de resposta à mão no arquivo (fora de comentário de doc). */
function montagensAMao(fonte: string): Array<{ linha: number; trecho: string }> {
  const linhas = fonte.split("\n");
  const construtor =
    /(?<![\w.])(new\s+(?:Next)?Response|(?:Next)?Response\.(?:json|redirect))\s*\(/g;
  const achadas: Array<{ linha: number; trecho: string }> = [];
  for (let m = construtor.exec(fonte); m; m = construtor.exec(fonte)) {
    const linha = fonte.slice(0, m.index).split("\n");
    const l = linha[linha.length - 1];
    // linha de comentário não é montagem: o doc do `health` cita os construtores.
    if (/^\s*(\/\/|\*)/.test(l)) continue;
    // Carimbada quando o construtor é o PRIMEIRO argumento de
    // `comIdDaRequisicao(` — o que vale é a posição no texto (chamada pode
    // começar na linha de cima), não a linha em si.
    const antes = fonte.slice(Math.max(0, m.index - 40), m.index).replace(/\s+$/, "");
    if (antes.endsWith("comIdDaRequisicao(")) continue;
    const idx = m.index;
    const janela = fonte.slice(idx, idx + 900);
    if (!/X-Request-Id|x-request-id/i.test(janela)) {
      achadas.push({ linha: linha.length, trecho: l.trim().slice(0, 80) });
    }
  }
  return achadas;
}

/** Todos os `route.ts` sob `app/api/`. */
function rotas(dir = join(RAIZ, "app", "api")): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...rotas(caminho));
    else if (entrada.name === "route.ts") saida.push(caminho);
  }
  return saida;
}

describe("catraca #4107: nenhuma resposta montada à mão sob app/api sai sem X-Request-Id", () => {
  it("toda montagem à mão está carimbada (lista de exceções vazia e só encolhe)", () => {
    const semCarimbo = rotas()
      .map((p) => ({
        arquivo: relative(RAIZ, p).split(sep).join("/"),
        montagens: montagensAMao(readFileSync(p, "utf8")),
      }))
      .filter((r) => r.montagens.length > 0)
      .map((r) => `${r.arquivo}: ${r.montagens.map((m) => `L${m.linha} (${m.trecho})`).join(", ")}`);

    expect(semCarimbo).toEqual([]);
  });
});

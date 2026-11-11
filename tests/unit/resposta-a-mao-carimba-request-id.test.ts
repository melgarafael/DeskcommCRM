// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextResponse } from "next/server";

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
 *  1. `comIdDaRequisicao()` carimba o id da REQUISIÇÃO (o `x-request-id` que o
 *     proxy pôs e que o audit grava) — não um UUID novo; preserva um id que a
 *     rota já carimbou ela mesma (é o id da auditoria dela); e reescreve a
 *     resposta quando os cabeçalhos são IMUTÁVEIS (`Response.redirect`).
 *  2. CATRACA ESTÁTICA: nenhuma montagem à mão nos `route.ts` sob `app/api/`
 *     sai sem carimbo — ou o construtor é o argumento direto de
 *     `comIdDaRequisicao(...)`, ou a própria chamada declara `X-Request-Id`.
 *     A lista de exceções é declarada em `EXCECOES`, cada uma com o motivo; uma
 *     exceção cujo arquivo suma da árvore (ou deixe de montar resposta) reprova.
 */
const RAIZ = join(__dirname, "..", "..");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function pedido(id?: string): Request {
  const headers = id ? { "x-request-id": id } : undefined;
  return new Request("http://x/api/v1/algo", { headers });
}

describe("comIdDaRequisicao", () => {
  it("carimba o id que veio na requisição — o mesmo que a rota grava no log", async () => {
    const carimbar = await comId();
    const id = "11111111-1111-4111-8111-111111111111";
    const res = carimbar(new Response("csv", { status: 200 }), pedido(id));
    expect(res.headers.get("X-Request-Id")).toBe(id);
  });

  it("o id é o MESMO que ok() põe: header da montagem à mão == id que a rota resolveu", async () => {
    // A régua da issue: o header da montagem à mão tem de ser o id que a rota
    // já resolveu para auditoria. `ok()` com o MESMO requestId do header produz
    // o MESMO `X-Request-Id` — um segundo UUID na resposta é o defeito da
    // #3971, e aqui ele é impossível por construção.
    const mod = await import("@/lib/api/wrappers");
    const id = "6aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const aMao = mod.comIdDaRequisicao(new Response("csv"), pedido(id));
    const wrapper = mod.ok({ ok: true }, { requestId: id });
    expect(aMao.headers.get("X-Request-Id")).toBe(wrapper.headers.get("X-Request-Id"));
  });

  it("não troca o id que a rota já carimbou: o dela vale (é o que foi à auditoria)", async () => {
    const carimbar = await comId();
    const res = carimbar(
      new Response("ok", {
        status: 200,
        headers: { "X-Request-Id": "33333333-3333-4333-8333-333333333333" },
      }),
      pedido("22222222-2222-4222-8222-222222222222"),
    );
    expect(res.headers.get("X-Request-Id")).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("aceita o requestId resolvido pela rota direto, sem a requisição", async () => {
    const carimbar = await comId();
    const res = carimbar(new Response(null, { status: 503 }), "44444444-4444-4444-8444-444444444444");
    expect(res.headers.get("X-Request-Id")).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("cabeçalhos imutáveis (Response.redirect): reescreve mantendo status e location", async () => {
    const carimbar = await comId();
    const id = "55555555-5555-4555-8555-555555555555";
    const base = Response.redirect("https://destino.exemplo/ok", 302);
    // Premissa do caso: é ESTE o tipo de resposta que não deixa pôr cabeçalho.
    expect(() => base.headers.set("X-Request-Id", "x")).toThrow(TypeError);

    const res = carimbar(base, pedido(id));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://destino.exemplo/ok");
    expect(res.headers.get("X-Request-Id")).toBe(id);
  });

  it("NextResponse.redirect com cookie: mantém status, location e cookies, e continua NextResponse", async () => {
    const carimbar = await comId();
    const id = "55555555-5555-4555-8555-555555555555";
    const base = NextResponse.redirect("https://destino.exemplo/ok", 302);
    base.cookies.set("vinculo", "valor", { path: "/" });

    const res = carimbar(base, pedido(id));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://destino.exemplo/ok");
    expect(res.headers.get("X-Request-Id")).toBe(id);
    // Quem chama ainda pode pôr cookie na saída (os callbacks de OAuth fazem).
    expect(() => (res as NextResponse).cookies.set("outro", "1", { path: "/" })).not.toThrow();
  });

  it("não mexe no corpo nem no status: só acrescenta o cabeçalho", async () => {
    const carimbar = await comId();
    const res = carimbar(new Response("corpo-original", { status: 418 }), pedido());
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("corpo-original");
  });

  it("sem id na requisição nem na rota: nasce um, e a resposta sai com header", async () => {
    const carimbar = await comId();
    const res = carimbar(new Response(null, { status: 404 }), pedido());
    expect(res.headers.get("X-Request-Id")).toMatch(UUID);
  });
});

// -----------------------------------------------------------------------------
// Catraca estática
// -----------------------------------------------------------------------------

/** Monta resposta sem passar pelos wrappers — a MESMA régua da issue (#4107). */
const MONTAGEM =
  /(?<![\w.$])(new\s+(?:Next)?Response|(?:Next)?Response\.(?:json|redirect))\s*\(/g;

/**
 * Exceções declaradas: arquivo → motivo. Cada entrada é uma decisão escrita,
 * não um "deixa passar".
 *
 * Critério para ficar de fora: a rota é chamada por um cliente que não lê
 * cabeçalho E não tem registro (log/auditoria) com o id da requisição — nesse
 * caso o header publicaria um id que não existe em lugar nenhum, que é o
 * defeito do #3971 ao contrário.
 */
const EXCECOES: Record<string, string> = {
  "app/api/v1/webhooks/cadencia-pixel/[token]/route.ts":
    "Pixel 1x1 carregado pelo cliente de e-mail do lead: a rota não grava requestId em log nem em auditoria, e quem recebe a imagem não lê cabeçalho. Carimbar aqui publicaria um id sem registro — o defeito do #3971 ao contrário.",
  "app/api/v1/webhooks/cadencia-descadastro/[token]/route.ts":
    "Página pública de descadastro (GET/HEAD/POST sem sessão, token assinado como credencial): o audit `lgpd.consent_changed` não carrega requestId e as linhas de log da rota também não. Diferente dos exports e callbacks, não há registro com que correlacionar — carimbar seria um id órfão.",
};

function rotas(dir = join(RAIZ, "app", "api")): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...rotas(caminho));
    else if (entrada.name === "route.ts") saida.push(caminho);
  }
  return saida;
}

/** Índice do `)` que fecha a chamada aberta em `abre` (ou -1). */
function fimDaChamada(fonte: string, abre: number): number {
  let fundura = 0;
  for (let i = abre; i < fonte.length; i++) {
    if (fonte[i] === "(") fundura++;
    else if (fonte[i] === ")") {
      fundura--;
      if (fundura === 0) return i;
    }
  }
  return -1;
}

type Montagem = { linha: number; trecho: string; carimbada: boolean };

/**
 * Cada construtor de resposta à mão do arquivo, com o veredito do carimbo.
 *
 * O carimbo é procurado no LUGAR CERTO — não numa janela de linhas em volta:
 *   (a) o construtor é o argumento direto de `comIdDaRequisicao(`, inclusive
 *       quando o `(` e o `new` caem em linhas diferentes; ou
 *   (b) a opção `headers` da PRÓPRIA chamada declara `X-Request-Id` (o caso dos
 *       exports, que resolvem o id junto com o audit).
 *
 * Uma janela de linhas deixaria um `return` sem carimbo passar só porque a
 * resposta anterior, duas linhas acima, estava carimbada.
 */
function montagensAMao(fonte: string): Montagem[] {
  const achadas: Montagem[] = [];
  MONTAGEM.lastIndex = 0;
  let achado: RegExpExecArray | null;
  while ((achado = MONTAGEM.exec(fonte)) !== null) {
    const indice = achado.index;
    const inicioDaLinha = fonte.lastIndexOf("\n", indice) + 1;
    const fimDaLinha = fonte.indexOf("\n", indice);
    const linha = fonte.slice(inicioDaLinha, fimDaLinha === -1 ? fonte.length : fimDaLinha);
    // Doc de rota cita construtores (`health` fala dos três); comentário não é montagem.
    if (/^\s*(\/\/|\*|\/\*)/.test(linha)) continue;

    const antes = fonte.slice(0, indice).replace(/\s+$/, "");
    const embrulhada = antes.endsWith("comIdDaRequisicao(");

    const abre = indice + achado[0].length - 1;
    const fecha = fimDaChamada(fonte, abre);
    const chamada = fecha === -1 ? achado[0] : fonte.slice(indice, fecha + 1);
    const carimbaNaChamada = /X-Request-Id/i.test(chamada);

    achadas.push({
      linha: fonte.slice(0, indice).split("\n").length,
      trecho: achado[0].replace(/\s+/g, " "),
      carimbada: embrulhada || carimbaNaChamada,
    });
  }
  return achadas;
}

function medir(arquivo: string) {
  const fonte = readFileSync(arquivo, "utf8");
  return {
    arquivo: relative(RAIZ, arquivo).split(sep).join("/"),
    montagens: montagensAMao(fonte),
  };
}

describe("catraca #4107: resposta montada à mão sob app/api carimba o X-Request-Id", () => {
  const medidas = rotas().map(medir);
  const comMontagem = medidas.filter((m) => m.montagens.length > 0);

  it("a varredura enxerga as rotas (senão o teste passaria sem medir nada)", () => {
    expect(medidas.length).toBeGreaterThan(100);
    expect(comMontagem.length).toBeGreaterThan(30);
  });

  it("nenhuma montagem à mão fica sem carimbo, fora as exceções declaradas", () => {
    const semCarimbo = comMontagem
      .filter((m) => !(m.arquivo in EXCECOES))
      .map((m) => {
        const soltas = m.montagens.filter((x) => !x.carimbada);
        if (soltas.length === 0) return null;
        return `${m.arquivo}: ${soltas.map((x) => `L${x.linha} (${x.trecho})`).join(", ")}`;
      })
      .filter((x): x is string => x !== null);

    expect(semCarimbo).toEqual([]);
  });

  it("toda exceção existe, tem motivo escrito e ainda monta resposta (senão a lista mente)", () => {
    const problemas = Object.entries(EXCECOES).flatMap(([arquivo, motivo]) => {
      const medida = medidas.find((m) => m.arquivo === arquivo);
      const erros: string[] = [];
      if (!medida) erros.push(`${arquivo}: arquivo não existe mais — remova a exceção`);
      else if (medida.montagens.length === 0)
        erros.push(`${arquivo}: não monta mais resposta à mão — remova a exceção`);
      if (motivo.trim().length < 40) erros.push(`${arquivo}: motivo curto demais para ser um critério`);
      return erros;
    });

    expect(problemas).toEqual([]);
  });
});

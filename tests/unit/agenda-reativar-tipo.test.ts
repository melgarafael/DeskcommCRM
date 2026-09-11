import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * REATIVAR TIPO DE AGENDAMENTO — e a travessia tela → rota que deixou o botão
 * nascer morto.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * O botão "Reativar" de Configurações › Agenda existe desde que a tela existe e
 * **nunca funcionou uma vez**. Ele mandava `PATCH /api/v1/agenda/tipos` com
 * `{ id, is_active: true }`; o `alterarSchema` daquela rota é
 * `criarSchema.partial().extend({ id })`, e `is_active` não está entre os doze
 * campos de `camposDoTipo`. Zod **descarta chave desconhecida em silêncio**,
 * então `campos` chegava `{}` e a rota respondia 422 "Nenhum campo para
 * alterar." — para um usuário que não pediu para alterar campo nenhum.
 *
 * O compilador teria acusado. Não acusou porque a chamada terminava em
 * `as never`, o único cast do arquivo da tela, exatamente em cima da travessia.
 *
 * ─── Por que este arquivo tem DUAS partes ───────────────────────────────────
 *
 * A parte de COMPORTAMENTO prova que a rota nova faz o que diz: grava
 * `is_active: true`, filtra o tenant pela sessão, audita com verbo próprio e
 * recusa o que não existe. Ela não alcança o defeito original — a rota antiga
 * também "funcionava", só que sobre um corpo vazio.
 *
 * Quem alcança o defeito é a TRAVESSIA. Ela mede as duas pontas no fonte: as
 * chaves que a tela manda no corpo e os campos que o schema da rota aceita. No
 * estado anterior a este commit ela reprova sozinha, nomeando `is_active`. E
 * ela vale para o campo que ainda não existe: qualquer chave futura que a tela
 * mande e a rota não conheça fica vermelha aqui, em vez de virar um 422 mudo na
 * mão de quem clicou.
 *
 * Ancorado no AST e não em regex de propósito — a prosa deste repositório cita
 * `is_active` e `apiClient.patch(` em comentário o tempo todo, e uma varredura
 * de texto acusaria o arquivo por ele falar de si mesmo.
 *
 * ─── Medir ──────────────────────────────────────────────────────────────────
 *
 *   npx vitest run tests/unit/agenda-reativar-tipo.test.ts
 *
 * Para ver a travessia morder, devolva `is_active: true` ao corpo do
 * `apiClient.patch("/api/v1/agenda/tipos", …)` da tela. Para ver o
 * comportamento morder, troque `is_active: true` por `false` na rota nova.
 */

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

const RAIZ = join(__dirname, "..", "..");
const ROTA_TIPOS = join(RAIZ, "app", "api", "v1", "agenda", "tipos", "route.ts");
const ROTA_REATIVAR = join(RAIZ, "app", "api", "v1", "agenda", "tipos", "reativar", "route.ts");
const TELA = join(RAIZ, "app", "app", "settings", "tenant", "agenda", "_client.tsx");

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const TIPO = "33333333-3333-4333-8333-333333333333";
const OUTRA_ORG_TIPO = "44444444-4444-4444-8444-444444444444";

/** O que a rota gravou, em que tabela, e sob quais filtros. */
let tabelaAlvo: string | null = null;
let atualizacao: Record<string, unknown> | null = null;
let filtros: Record<string, unknown> = {};
/** A linha que o banco devolve — `null` simula tipo inexistente nesta organização. */
let linha: { id: string } | null = null;

function pedido(corpo?: unknown): NextRequest {
  return new NextRequest("https://crm.exemplo/api/v1/agenda/tipos/reativar", {
    method: "POST",
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
}

beforeEach(() => {
  // `clearAllMocks` ANTES de configurar: os casos de recusa aserem que `audit`
  // NÃO foi chamado, e sem isto eles herdam as chamadas dos casos anteriores e
  // falham por vazamento de fixture, não por defeito da rota.
  vi.clearAllMocks();
  tabelaAlvo = null;
  atualizacao = null;
  filtros = {};
  linha = { id: TIPO };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ANA } as never,
    org: { orgId: ORG } as never,
  });
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => ({
      update: (valores: Record<string, unknown>) => {
        tabelaAlvo = tabela;
        atualizacao = valores;
        const cadeia = {
          eq: (coluna: string, valor: unknown) => {
            filtros[coluna] = valor;
            return cadeia;
          },
          select: () => cadeia,
          maybeSingle: async () => ({ data: linha, error: null }),
        };
        return cadeia;
      },
    }),
  } as never);
});

describe("POST /api/v1/agenda/tipos/reativar — comportamento", () => {
  it("liga o tipo de volta, na tabela certa", async () => {
    const { POST } = await import("@/app/api/v1/agenda/tipos/reativar/route");
    const r = await POST(pedido({ id: TIPO }));
    expect(r.status).toBe(200);
    expect(tabelaAlvo).toBe("calendar_event_types");
    expect(
      atualizacao,
      "a rota respondeu 200 sem gravar nada — que é exatamente o que o botão " +
        "antigo fazia, só que com 422 em vez de 200",
    ).toEqual({ is_active: true });
  });

  it("o tenant vem da SESSÃO — sem isto a service role reativa tipo de outra casa", async () => {
    const { POST } = await import("@/app/api/v1/agenda/tipos/reativar/route");
    await POST(pedido({ id: OUTRA_ORG_TIPO }));
    expect(filtros.organization_id).toBe(ORG);
    expect(filtros.id).toBe(OUTRA_ORG_TIPO);
  });

  it("audita com verbo PRÓPRIO, e não como uma alteração de campo qualquer", async () => {
    const { POST } = await import("@/app/api/v1/agenda/tipos/reativar/route");
    await POST(pedido({ id: TIPO }));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "agenda.tipo_reativado",
      organizationId: ORG,
      resourceType: "calendar_event_types",
      resourceId: TIPO,
      actorUserId: ANA,
    });
  });

  it("não diz que reativou o que não existe", async () => {
    // 404 e não 200: dizer "reativei" sobre o que não há é a mesma família de
    // mentira que o `DELETE` da rota irmã recusa do outro lado.
    linha = null;
    const { POST } = await import("@/app/api/v1/agenda/tipos/reativar/route");
    const r = await POST(pedido({ id: TIPO }));
    expect(r.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo sem `id` é recusado ANTES de qualquer escrita", async () => {
    const { POST } = await import("@/app/api/v1/agenda/tipos/reativar/route");
    const r = await POST(pedido({}));
    expect(r.status).toBe(422);
    expect(atualizacao, "a validação falhou e a rota gravou mesmo assim").toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("reativar exige `manager` — e a recusa de papel para antes da escrita", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }) as never,
    } as never);
    const { POST } = await import("@/app/api/v1/agenda/tipos/reativar/route");
    const r = await POST(pedido({ id: TIPO }));
    expect(r.status).toBe(403);
    expect(atualizacao).toBeNull();
  });

  it("CONTROLE: o dublê só registra quando a rota escreve", () => {
    // Sem esta asserção, um `update` que o dublê não interceptasse deixaria
    // `atualizacao` sempre `null` — e os dois casos de recusa acima passariam
    // por instrumento cego em vez de por comportamento.
    expect(atualizacao).toBeNull();
    expect(filtros).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRAVESSIA TELA → ROTA
// ─────────────────────────────────────────────────────────────────────────────

function ast(caminho: string): ts.SourceFile {
  const fonte = readFileSync(caminho, "utf8");
  return ts.createSourceFile(
    caminho,
    fonte,
    ts.ScriptTarget.Latest,
    true,
    caminho.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function percorre(no: ts.Node, visita: (n: ts.Node) => void): void {
  visita(no);
  no.forEachChild((filho) => percorre(filho, visita));
}

/** Os nomes declarados em `const <nome> = { … }` no arquivo dado. */
function chavesDaConstante(arquivo: ts.SourceFile, nome: string): string[] {
  let achadas: string[] | null = null;
  percorre(arquivo, (no) => {
    if (
      ts.isVariableDeclaration(no) &&
      ts.isIdentifier(no.name) &&
      no.name.text === nome &&
      no.initializer &&
      ts.isObjectLiteralExpression(no.initializer)
    ) {
      achadas = no.initializer.properties.flatMap((p) =>
        p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : [],
      );
    }
  });
  if (achadas === null) throw new Error(`não achei \`const ${nome} = { … }\` — a rota mudou de forma`);
  return achadas;
}

/**
 * Tira as cascas que não mudam o valor em runtime: `as T`, `<T>x`, `satisfies T`
 * e parênteses.
 *
 * ⚠️ Sem isto a trava não morde o defeito que ela existe para pegar. O corpo
 * infrator era `{ id, is_active: true } as never` — um `AsExpression`, não um
 * `ObjectLiteralExpression` —, então a primeira versão desta varredura
 * ATRAVESSAVA o corpo sem ver chave nenhuma e o caso passava verde. Medido: com
 * a tela sabotada de volta ao estado antigo, 10 casos passaram e o principal
 * foi um deles. O cast escondeu o campo do compilador E do guarda que existe
 * para vigiar o compilador.
 */
function desembrulha(no: ts.Expression): ts.Expression {
  let atual = no;
  for (;;) {
    if (ts.isAsExpression(atual) || ts.isSatisfiesExpression(atual) || ts.isTypeAssertionExpression(atual)) {
      atual = atual.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(atual)) {
      atual = atual.expression;
      continue;
    }
    return atual;
  }
}

/**
 * As chaves de todo corpo que a tela manda em `apiClient.<metodo>("<caminho>", { … })`.
 *
 * Espalhamento condicional (`...(x ? { campo: y } : {})`) conta: a chave chega
 * ao servidor nas mesmas condições que as outras.
 */
function chavesEnviadas(arquivo: ts.SourceFile, metodo: string, caminho: string): string[] {
  const chaves = new Set<string>();
  let achouChamada = false;

  const colhe = (obj: ts.ObjectLiteralExpression): void => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        percorre(prop.expression, (n) => {
          if (ts.isObjectLiteralExpression(n)) colhe(n);
        });
        continue;
      }
      if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        chaves.add(prop.name.text);
      }
    }
  };

  percorre(arquivo, (no) => {
    if (!ts.isCallExpression(no)) return;
    const alvo = no.expression;
    if (!ts.isPropertyAccessExpression(alvo)) return;
    if (!ts.isIdentifier(alvo.expression) || alvo.expression.text !== "apiClient") return;
    if (alvo.name.text !== metodo) return;
    const primeiro = no.arguments[0];
    if (!primeiro || !ts.isStringLiteral(primeiro) || primeiro.text !== caminho) return;
    achouChamada = true;
    const corpo = no.arguments[1];
    if (!corpo) return;
    const nu = desembrulha(corpo);
    if (ts.isObjectLiteralExpression(nu)) colhe(nu);
  });

  if (!achouChamada) {
    throw new Error(`não achei \`apiClient.${metodo}("${caminho}", …)\` na tela — a chamada mudou de forma`);
  }
  return [...chaves];
}

describe("travessia tela → rota: a tela não manda campo que a rota descarta", () => {
  const rota = ast(ROTA_TIPOS);
  const tela = ast(TELA);
  const camposDoTipo = chavesDaConstante(rota, "camposDoTipo");

  it("CONTROLE: as duas pontas foram realmente lidas", () => {
    // Sem isto, um `camposDoTipo` que o leitor não achasse viraria lista vazia e
    // TODA chave da tela apareceria como infratora — ou, na direção contrária,
    // um `chavesEnviadas` vazio faria os casos abaixo passarem sobre nada.
    expect(camposDoTipo.length, "camposDoTipo veio vazio — o leitor de AST cegou").toBeGreaterThan(5);
    expect(camposDoTipo).toContain("duration_minutes");
    expect(
      camposDoTipo,
      "`is_active` entrou em camposDoTipo — então o PATCH voltou a poder DESLIGAR " +
        "um tipo, e a trilha perdeu a distinção entre alterar e desativar",
    ).not.toContain("is_active");
  });

  it("PATCH: toda chave enviada é aceita pelo `alterarSchema`", () => {
    // `alterarSchema` é `criarSchema.partial().extend({ id })`.
    const aceitas = new Set([...camposDoTipo, "id"]);
    const enviadas = chavesEnviadas(tela, "patch", "/api/v1/agenda/tipos");
    expect(enviadas.length).toBeGreaterThan(1);
    expect(
      enviadas.filter((c) => !aceitas.has(c)),
      "Zod descarta chave desconhecida em SILÊNCIO: o campo some do corpo, o " +
        "`update` chega vazio e quem clicou recebe 422 sem saber por quê. Foi " +
        "assim que o botão Reativar passou a vida inteira sem funcionar.",
    ).toEqual([]);
  });

  it("POST: toda chave enviada na criação é aceita pelo `criarSchema`", () => {
    const aceitas = new Set(camposDoTipo);
    const enviadas = chavesEnviadas(tela, "post", "/api/v1/agenda/tipos");
    expect(enviadas.length).toBeGreaterThan(1);
    expect(enviadas.filter((c) => !aceitas.has(c))).toEqual([]);
  });

  it("o botão Reativar aponta para uma rota que EXISTE", () => {
    // O defeito original não foi rota errada, foi campo descartado — mas o
    // conserto trocou o endereço, e endereço sem arquivo é 404: o mesmo botão
    // morto, com outra causa.
    const enviadas = chavesEnviadas(tela, "post", "/api/v1/agenda/tipos/reativar");
    expect(enviadas).toEqual(["id"]);
    expect(existsSync(ROTA_REATIVAR), `sem arquivo em ${ROTA_REATIVAR}`).toBe(true);
    expect(readFileSync(ROTA_REATIVAR, "utf8")).toMatch(/export async function POST/);
  });

  it("nenhuma chamada da tela apaga o compilador com `as never`", () => {
    // Era o único cast do arquivo, e estava exatamente em cima desta travessia:
    // sem ele o `pnpm typecheck` teria acusado `is_active` no dia em que o botão
    // foi escrito. Um cast aqui desliga o tsc no lugar onde ele é a última
    // defesa — a própria trava acima só alcança chave literal.
    //
    // Pelo AST, e não por regex: a primeira versão deste caso procurava o texto
    // e reprovou o arquivo por causa do COMENTÁRIO que explica o cast, três
    // linhas acima da chamada. Varredura de texto acusa o repositório por ele
    // falar de si mesmo — é o mesmo motivo que ancora o resto deste arquivo.
    const infratoras: string[] = [];
    percorre(tela, (no) => {
      if (!ts.isCallExpression(no)) return;
      const alvo = no.expression;
      if (!ts.isPropertyAccessExpression(alvo)) return;
      if (!ts.isIdentifier(alvo.expression) || alvo.expression.text !== "apiClient") return;
      for (const arg of no.arguments) {
        percorre(arg, (n) => {
          if (ts.isAsExpression(n) && n.type.kind === ts.SyntaxKind.NeverKeyword) {
            infratoras.push(`apiClient.${alvo.name.text} — ${n.expression.getText().slice(0, 60)}`);
          }
        });
      }
    });
    expect(infratoras).toEqual([]);
  });
});

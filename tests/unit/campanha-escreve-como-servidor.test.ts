/**
 * A ESCRITA DE CAMPANHA É DO SERVIDOR — e este arquivo existe porque o contrário
 * passou por typecheck, lint, 56 testes unitários e pelos invariantes de RLS num
 * Postgres real, e só apareceu na TELA, em produção.
 *
 * ## O defeito, medido em 19/09/2026
 *
 * A migration 0375 concede ao papel `authenticated` apenas `SELECT` em
 * `campaigns` e `campaign_recipients` — a tela lê, só o servidor escreve. As
 * rotas de criar e editar usavam `createClient()` (a sessão do usuário, que fala
 * com o PostgREST como `authenticated`), e o banco respondia:
 *
 *     permission denied for table campaigns
 *
 * O operador via "Erro interno. Tente de novo em instantes." e nenhuma campanha
 * nascia. Nada no repositório pegava isso: os testes unitários usam mock, e os
 * invariantes de RLS exercitam POLICY (quem a linha deixa ver), não GRANT (se o
 * papel pode sequer tentar o comando).
 *
 * ## Por que a catraca é esta, e não um teste de banco
 *
 * Medir "o papel `authenticated` não tem INSERT" prenderia o GRANT, que está
 * certo e é defesa em profundidade: mesmo que uma policy afrouxe um dia, o
 * browser continua sem conseguir escrever direto. O que precisa ficar preso é o
 * outro lado — a ROTA tem de escrever como servidor, com `organization_id`
 * resolvido do papel conferido e aplicado à mão em toda consulta.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "app", "api", "v1", "campaigns");
const MUTANTES = ["POST", "PUT", "PATCH", "DELETE"];

function rotas(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? rotas(join(dir, item.name))
      : item.name === "route.ts"
        ? [join(dir, item.name)]
        : [],
  );
}

/** O corpo de cada handler mutante do arquivo, por nome. */
function handlersMutantes(fonte: string): Array<[string, string]> {
  const achados: Array<[string, string]> = [];
  for (const metodo of MUTANTES) {
    const marca = `export async function ${metodo}(`;
    const i = fonte.indexOf(marca);
    if (i === -1) continue;
    // Até o próximo `export async function` ou o fim — grosseiro de propósito:
    // o que importa é se o client admin aparece DENTRO do handler.
    const resto = fonte.slice(i + marca.length);
    const fim = resto.indexOf("\nexport async function ");
    achados.push([metodo, fim === -1 ? resto : resto.slice(0, fim)]);
  }
  return achados;
}

describe("campanha: quem escreve é o servidor", () => {
  it("CONTROLE: a varredura acha as rotas — zero arquivo seria verde por instrumento morto", () => {
    const encontradas = rotas(RAIZ);
    expect(encontradas.length).toBeGreaterThanOrEqual(4);
    expect(encontradas.some((p) => p.endsWith(join("campaigns", "route.ts")))).toBe(true);
  });

  it("todo handler que MUTA usa o client admin, nunca a sessão do usuário", () => {
    const infratores: string[] = [];
    for (const caminho of rotas(RAIZ)) {
      const fonte = readFileSync(caminho, "utf8");
      for (const [metodo, corpo] of handlersMutantes(fonte)) {
        if (!corpo.includes("createAdminClient(")) {
          infratores.push(`${caminho.replace(process.cwd() + "/", "")}:${metodo}`);
        }
      }
    }
    expect(
      infratores,
      "Handler de campanha que escreve com a sessão do usuário. O papel " +
        "`authenticated` só tem SELECT (migration 0375), então o banco recusa com " +
        '"permission denied for table campaigns" e o operador vê "Erro interno". ' +
        "Use `createAdminClient()` e filtre `organization_id` à mão, resolvido do " +
        "`requireRole()` — nunca do corpo da requisição.",
    ).toEqual([]);
  });

  it("todo handler que MUTA continua filtrando a organização à mão", () => {
    // O client admin ignora RLS: sem o filtro explícito, a rota alcançaria a
    // campanha de qualquer tenant. Uma coisa não vem sem a outra.
    const semFiltro: string[] = [];
    for (const caminho of rotas(RAIZ)) {
      const fonte = readFileSync(caminho, "utf8");
      for (const [metodo, corpo] of handlersMutantes(fonte)) {
        if (!corpo.includes("createAdminClient(")) continue;
        const filtra =
          corpo.includes("organization_id") || corpo.includes("authz.org.orgId") || corpo.includes("org.orgId");
        if (!filtra) semFiltro.push(`${caminho.replace(process.cwd() + "/", "")}:${metodo}`);
      }
    }
    expect(semFiltro).toEqual([]);
  });
});

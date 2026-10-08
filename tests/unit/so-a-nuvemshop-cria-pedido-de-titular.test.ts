// @vitest-environment node
/**
 * SÓ OS 3 WEBHOOKS DA NUVEMSHOP CRIAM PEDIDO DE TITULAR — até o PDF de acesso
 * cumprir o art. 15.º do RGPD (doc 88).
 *
 * Portugal entrou no seletor (doc 88) com um argumento que depende de uma
 * propriedade do código: hoje nenhum caminho cria pedido de titular para uma
 * organização portuguesa, porque o único escritor de `lgpd_requests` é
 * `createLgpdRequest`, chamado só pelos webhooks da Nuvemshop — e a Nuvemshop
 * não abre loja em Portugal (reconferido em 2026-10-05).
 *
 * O PDF de acesso ainda não traz o que o art. 15.º, n.º 1 do RGPD exige
 * (alíneas a) a h): finalidades, destinatários, conservação, direitos,
 * reclamação à autoridade de controlo, decisões automatizadas) nem a cópia
 * completa do n.º 3 (entrega uma amostra de 100 mensagens). Sem esta trava, o
 * primeiro PR que criasse pedido por tela, REST, MCP ou outro conector abriria
 * esse PDF incompleto a um titular português sem nenhum gate ficar vermelho.
 *
 * Se este teste reprovou porque você criou um caminho novo de pedido: primeiro
 * o PDF cumpre o art. 15.º (n.º 1, alíneas a) a h), e n.º 3), depois este teste
 * ganha o seu arquivo. Ver o doc 88 e o cabeçalho de `lib/legal/perfil-do-pais.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
/** Código que roda na instalação. `scripts/` fica de fora: é seed de e2e, não produto. */
const AREAS = ["app", "lib", "workers", "components", "hooks"];

const CHAMADORES_PERMITIDOS = [
  "app/api/v1/webhooks/nuvemshop/customer-data-request/route.ts",
  "app/api/v1/webhooks/nuvemshop/customer-redact/route.ts",
  "app/api/v1/webhooks/nuvemshop/store-redact/route.ts",
];

const AVISO =
  "caminho novo de pedido de titular: antes, o PDF de acesso precisa cumprir o art. 15.º, n.º 1 " +
  "(alíneas a) a h)) e a cópia completa do n.º 3 do RGPD — ver o doc 88. A trava vale para TODOS os " +
  "países, o Brasil inclusive (decisão do doc 88): um fluxo só de LGPD também espera o PDF; abrir " +
  "exceção para ele é decisão do dono do produto, não deste teste";

function arquivos(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acc);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const fontes = AREAS.flatMap((area) => arquivos(join(RAIZ, area))).map((caminho) => ({
  rel: relative(RAIZ, caminho).split(sep).join("/"),
  texto: readFileSync(caminho, "utf8"),
}));

/**
 * Quem CHAMA `createLgpdRequest` — pelo AST, para comentário e import não contarem.
 * Import com outro nome (`createLgpdRequest as criar`) conta como chamador: o
 * nome novo escaparia da busca pela chamada. Limite conhecido: escrita por
 * `from(VARIAVEL)` e por função SQL não são vistas.
 */
function chamadoresDe(nome: string, arquivosLidos: typeof fontes): string[] {
  const achados = new Set<string>();
  for (const { rel, texto } of arquivosLidos) {
    if (!texto.includes(nome)) continue;
    const fonte = ts.createSourceFile(rel, texto, ts.ScriptTarget.Latest, true);
    const visitar = (no: ts.Node): void => {
      if (ts.isImportSpecifier(no) && no.propertyName?.text === nome) achados.add(rel);
      if (ts.isCallExpression(no)) {
        const alvo = no.expression;
        const chamado = ts.isPropertyAccessExpression(alvo) ? alvo.name.text : alvo.getText(fonte);
        if (chamado === nome) achados.add(rel);
      }
      ts.forEachChild(no, visitar);
    };
    visitar(fonte);
  }
  return [...achados].sort();
}

describe("quem cria pedido de titular (doc 88)", () => {
  it("createLgpdRequest é chamado exatamente pelos 3 webhooks da Nuvemshop", () => {
    expect(chamadoresDe("createLgpdRequest", fontes), AVISO).toEqual(CHAMADORES_PERMITIDOS);
  });

  it("o único arquivo que grava em lgpd_requests é o repositório", () => {
    // Fecha o desvio: escrever na tabela sem passar por `createLgpdRequest`.
    const escritores = fontes
      .filter(({ texto }) =>
        /from\(\s*["'`]lgpd_requests["'`]\s*\)\s*\.\s*(insert|upsert)\s*\(/.test(texto),
      )
      .map(({ rel }) => rel);
    expect(escritores, AVISO).toEqual(["lib/lgpd/repository.ts"]);
  });

  it("a sonda enxerga um chamador novo (controle positivo)", () => {
    const falso = {
      rel: "app/api/v1/lgpd/requests/novo/route.ts",
      texto: 'import { createLgpdRequest } from "@/lib/lgpd/repository";\nawait createLgpdRequest({});',
    };
    expect(chamadoresDe("createLgpdRequest", [...fontes, falso])).toContain(falso.rel);
  });

  it("a sonda enxerga o chamador que importa com outro nome (controle positivo)", () => {
    const falso = {
      rel: "lib/lgpd/outro-caminho.ts",
      texto: 'import { createLgpdRequest as criarPedido } from "@/lib/lgpd/repository";\nawait criarPedido({});',
    };
    expect(chamadoresDe("createLgpdRequest", [...fontes, falso])).toContain(falso.rel);
  });
});

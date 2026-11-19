import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * TODA LINHA DE AUDITORIA DO FINANCEIRO E DOS HONORÁRIOS DIZ QUEM AGIU E EM QUE EMPRESA.
 *
 * `audit()` (lib/audit/index.ts) aceita `actorUserId` e `organizationId` como
 * opcionais, e as rotas de comanda, lançamento, fidelidade e honorários não os
 * passavam: a linha entrava em `api_audit_log` com as duas colunas nulas — um
 * estorno, um lançamento apagado ou uma parcela paga sem autor e sem empresa,
 * invisível para quem filtra a trilha pela própria organização.
 *
 * O conserto por instância deixa a próxima rota nascer igual, e o modo de falha
 * é mudo (nada quebra, a linha só sai sem dono). Por isso o guarda percorre o
 * AST de TODA `route.ts` sob `app/api/v1/financeiro/` e `app/api/v1/honorarios/`
 * — alcança também a rota que ainda não existe. Molde:
 * `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`.
 *
 * As rotas daqui autenticam por sessão (`requireRole`). Se uma delas passar a
 * aceitar token de integração, `actorApiTokenId` entra junto — e esta cerca
 * continua exigindo a empresa.
 */

const RAIZ = join(__dirname, "..", "..");
const DIRETORIOS = [
  join(RAIZ, "app", "api", "v1", "financeiro"),
  join(RAIZ, "app", "api", "v1", "honorarios"),
];
const CAMPOS_OBRIGATORIOS = ["actorUserId", "organizationId"] as const;

function rotasSob(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name === "route.ts")
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/**
 * Chamadas a `audit(...)` cujo argumento não declara `actorUserId` E
 * `organizationId`. Devolve `linha: campos que faltam`.
 *
 * Argumento que não é objeto literal também é infração: a cerca não consegue
 * ler o que ele carrega, e "não sei" não pode passar por "tem".
 *
 * AST e não regex: a prosa do repositório cita `audit({` em comentário, e um
 * regex acusaria o texto que descreve a regra.
 */
export function auditsSemAtorOuEmpresa(fonte: string, nomeDoArquivo: string): string[] {
  const arquivo = ts.createSourceFile(nomeDoArquivo, fonte, ts.ScriptTarget.Latest, true);
  const infracoes: string[] = [];

  const visitar = (no: ts.Node): void => {
    if (ts.isCallExpression(no) && ts.isIdentifier(no.expression) && no.expression.text === "audit") {
      const linha = arquivo.getLineAndCharacterOfPosition(no.getStart(arquivo)).line + 1;
      const arg = no.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        infracoes.push(`${linha}: argumento não é objeto literal`);
      } else {
        const declarados = new Set(
          arg.properties
            .filter((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
            .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : "")),
        );
        const faltam = CAMPOS_OBRIGATORIOS.filter((c) => !declarados.has(c));
        if (faltam.length > 0) infracoes.push(`${linha}: falta ${faltam.join(", ")}`);
      }
    }
    ts.forEachChild(no, visitar);
  };

  visitar(arquivo);
  return infracoes;
}

const ROTAS = DIRETORIOS.flatMap(rotasSob);

describe("financeiro e honorários × auditoria com ator e empresa (a CLASSE)", () => {
  it("o instrumento enxerga as rotas e as chamadas (controle positivo)", () => {
    // Sem isto, um diretório renomeado ou um AST que nunca casa `audit(` fariam
    // o caso abaixo passar por vacuidade.
    expect(ROTAS.length).toBeGreaterThanOrEqual(15);
    const chamadas = ROTAS.reduce(
      (n, r) => n + (readFileSync(r, "utf8").match(/\baudit\(\{/g)?.length ?? 0),
      0,
    );
    expect(chamadas).toBeGreaterThanOrEqual(17);
  });

  it.each(ROTAS.map((r) => relative(RAIZ, r)))("%s passa actorUserId e organizationId ao audit()", (rota) => {
    const infracoes = auditsSemAtorOuEmpresa(readFileSync(join(RAIZ, rota), "utf8"), rota);
    expect(
      infracoes,
      `${rota} chama audit() sem quem agiu ou sem a empresa (${infracoes.join("; ")}). ` +
        `A linha entra em api_audit_log com actor_user_id/organization_id nulos. ` +
        `Passe actorUserId: authz.user.id e organizationId: authz.org.orgId.`,
    ).toEqual([]);
  });

  it("o instrumento acusa a chamada sem ator e sem empresa (controle negativo)", () => {
    const sabotado = `
      import { audit } from "@/lib/audit";
      export async function POST() {
        await audit({ action: "comanda.aberta", resourceType: "sale" });
      }`;
    expect(auditsSemAtorOuEmpresa(sabotado, "sabotado.ts")).toEqual([
      "4: falta actorUserId, organizationId",
    ]);
  });

  it("um campo só não basta: a empresa sem o ator é infração", () => {
    const sabotado = `
      import { audit } from "@/lib/audit";
      export async function POST() {
        void audit({ action: "x", organizationId: org });
      }`;
    expect(auditsSemAtorOuEmpresa(sabotado, "sabotado-meio.ts")).toEqual(["4: falta actorUserId"]);
  });

  it("argumento montado fora da chamada é infração — a cerca não lê o que não vê", () => {
    const sabotado = `
      import { audit } from "@/lib/audit";
      export async function POST() {
        const entrada = { action: "x" };
        await audit(entrada);
      }`;
    expect(auditsSemAtorOuEmpresa(sabotado, "sabotado-variavel.ts")).toEqual([
      "5: argumento não é objeto literal",
    ]);
  });

  it("a forma abreviada conta, e comentário não é código (controle do controle)", () => {
    const certo = `
      // A regra: audit({ action }) sem ator é proibido.
      import { audit } from "@/lib/audit";
      export async function POST(actorUserId: string, organizationId: string) {
        await audit({ action: "x", actorUserId, organizationId });
      }`;
    expect(auditsSemAtorOuEmpresa(certo, "certo.ts")).toEqual([]);
  });
});

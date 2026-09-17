/**
 * NENHUM PRODUTOR DE AVISO DE COMPROMISSO ESCREVE SEM CHECAR ANONIMIZAÇÃO.
 *
 * ─── A classe, e a quarta instância (issue #701) ────────────────────────────
 *
 * `agent_inbox_items` com `ref_kind='appointment'` é o aviso que aponta para o
 * compromisso de um cliente. Quando o titular exerce o direito de ser
 * esquecido, a anonimização desliga esse vínculo — e um aviso novo para ele é o
 * vínculo ressuscitando, com mensagem saindo para quem pediu para não ser mais
 * procurado.
 *
 * A guarda existe em três portas, TODAS em SQL: o trigger `fn_meet_redact_contact`
 * resolve os avisos abertos, `fn_appointment_recover` tem
 * `and not exists (… is_anonymized)`, e há um bloco de cura no histórico. A
 * quarta porta é escrita pelo TypeScript, e nascia sem guarda nenhuma — porque
 * *"a guarda mora dentro de funções SQL; quem escreve o kind pelo TypeScript não
 * a encontra, e nenhum invariante a cobra"* (a issue, literalmente).
 *
 * Foi a mesma classe do #690 (nenhuma guarda reprova `useState` que lê o
 * navegador): o conserto pontual resolve o caso, e sem uma guarda a próxima
 * instância nasce igual. Este arquivo é a guarda.
 *
 * ─── Como a sonda reconhece um produtor ─────────────────────────────────────
 *
 * Dois formatos escrevem esse aviso, e os dois contam:
 *
 *   - PostgREST: `.from("agent_inbox_items").insert({ …, ref_kind: "appointment" })`
 *   - SQL: um literal com `insert into agent_inbox_items … ref_kind … 'appointment'`
 *
 * Um site é PRODUTOR quando o texto dele cita a tabela, o `ref_kind` e um valor
 * de compromisso. A guarda é exigida na FUNÇÃO que envolve o site — nela ou no
 * próprio texto do site, que é o caso do `insert ... select` do turn-bridge,
 * onde a condição `not c.is_anonymized` faz parte da escrita.
 *
 * ─── O que ela NÃO é ────────────────────────────────────────────────────────
 *
 * Ela não varre `supabase/baseline.sql`: ali a guarda e a escrita estão no mesmo
 * statement de funções que o `test:db` já exercita contra Postgres de verdade
 * (ver `tests/invariants/`). O buraco que a issue nomeia é o do TypeScript, e é
 * ele que esta sonda cobre — um produtor NOVO em `.ts` não passa daqui.
 *
 * A sonda também não julga outros `ref_kind`: `followup_enrollment`, `contact`,
 * `message` não apontam para compromisso e não têm esta obrigação. Controles nas
 * duas direções no fim do arquivo: um produtor sem guarda precisa reprovar, um
 * com guarda precisa passar, e um produtor de outro `ref_kind` precisa ser
 * ignorado.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const DIRS = ["app", "lib", "workers"];

/** Um site que escreve aviso de compromisso, com a guarda que ele tem (ou não). */
export interface Produtor {
  arquivo: string;
  /** 1-based, para a mensagem de falha levar direto ao ponto. */
  linha: number;
  /** Onde o site começa, para reconhecer o formato (PostgREST ou SQL). */
  trecho: string;
  /** Se a função que escreve consulta `is_anonymized` (no site ou no corpo dela). */
  temGuarda: boolean;
}

export function fontesVigiadas(): Map<string, string> {
  const mapa = new Map<string, string>();
  const descer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = posix.join(dir, e.name);
      if (e.isDirectory()) descer(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        mapa.set(rel, readFileSync(join(RAIZ, rel), "utf8"));
      }
    }
  };
  for (const d of DIRS) descer(d);
  return mapa;
}

/** A tabela, o `ref_kind` e um valor de compromisso, no MESMO texto. */
export function ehAvisoDeCompromisso(texto: string): boolean {
  if (!texto.includes("agent_inbox_items")) return false;
  if (!/\bref_kind\b/.test(texto)) return false;
  return /appointment_recovery_review|['"`]appointment['"`]/.test(texto);
}

function ehFuncao(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** O corpo onde a escrita mora — é nele que a guarda precisa estar (ou no site). */
function funcaoEnvolvente(node: ts.Node): ts.Node | null {
  let atual: ts.Node | undefined = node.parent;
  while (atual) {
    if (ehFuncao(atual)) return atual;
    atual = atual.parent;
  }
  return null;
}

function sitesDeAviso(sf: ts.SourceFile): ts.Node[] {
  const achados: ts.Node[] = [];
  const visitar = (node: ts.Node): void => {
    // Formato SQL: o próprio literal carrega a escrita.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (ehAvisoDeCompromisso(node.getText(sf))) achados.push(node);
    }
    // Formato PostgREST: `.from("agent_inbox_items").insert({ … })`.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "insert" &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node &&
      ehAvisoDeCompromisso(node.parent.getText(sf))
    ) {
      achados.push(node.parent);
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);
  return achados;
}

/** Os produtores de aviso de compromisso de um conjunto de fontes. */
export function produtores(fontes: Map<string, string>): Produtor[] {
  const saida: Produtor[] = [];
  for (const [arquivo, texto] of fontes) {
    const sf = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const site of sitesDeAviso(sf)) {
      const corpo = funcaoEnvolvente(site);
      const guardado =
        site.getText(sf).includes("is_anonymized") || (corpo?.getText(sf).includes("is_anonymized") ?? false);
      saida.push({
        arquivo,
        linha: sf.getLineAndCharacterOfPosition(site.getStart(sf)).line + 1,
        trecho: site.getText(sf).slice(0, 60).replace(/\s+/g, " "),
        temGuarda: guardado,
      });
    }
  }
  return saida.sort((a, b) => `${a.arquivo}:${a.linha}`.localeCompare(`${b.arquivo}:${b.linha}`));
}

/** Só os que escrevem sem guarda — é o que reprova. */
export function semGuarda(produtoresEncontrados: Produtor[]): Produtor[] {
  return produtoresEncontrados.filter((p) => !p.temGuarda);
}

const DESCRICAO = (p: Produtor) => `${p.arquivo}:${p.linha} — ${p.trecho}`;

describe("produtor de aviso de compromisso checa anonimização", () => {
  const reais = produtores(fontesVigiadas());

  it("a sonda enxerga os produtores que existem (sem isto, o verde seria vazio)", () => {
    // Guarda de vacuidade: uma sonda que deixasse de reconhecer os dois formatos
    // devolveria lista vazia e passaria — o pior resultado possível para uma
    // guarda, e o modo de falha que ela existe para não ter.
    expect(reais.length, "a sonda não reconheceu produtor nenhum").toBeGreaterThanOrEqual(2);
    expect(reais.map((p) => p.arquivo)).toEqual(
      expect.arrayContaining(["lib/followup/engine.ts", "lib/followup/turn-bridge.ts"]),
    );
    // Os dois formatos aparecem: o do PostgREST e o do SQL.
    expect(reais.some((p) => p.trecho.includes("insert into"))).toBe(true);
    expect(reais.some((p) => p.trecho.includes(".from("))).toBe(true);
  });

  it("⭐ nenhum deles escreve sem checar `is_anonymized`", () => {
    const soltos = semGuarda(reais);
    expect(soltos.map(DESCRICAO), "aviso de compromisso escrito sem olhar se o contato é anonimizado").toEqual([]);
  });

  it("⭐ controle positivo: um produtor sem guarda REPROVA", () => {
    const fontes = new Map<string, string>([
      [
        "lib/fixture/sem-guarda.ts",
        `async function abrir(admin: Admin) {
           await admin.from("agent_inbox_items").insert({
             organization_id: org,
             kind: "appointment_recovery_review",
             ref_kind: "appointment",
             ref_id: compromisso,
           });
         }`,
      ],
    ]);

    const achados = produtores(fontes);

    expect(achados).toHaveLength(1);
    expect(semGuarda(achados)).toHaveLength(1);
  });

  it("⭐ controle negativo: o mesmo produtor COM guarda passa", () => {
    const fontes = new Map<string, string>([
      [
        "lib/fixture/com-guarda.ts",
        `async function abrir(admin: Admin) {
           const contato = await admin.from("contacts").select("is_anonymized").eq("id", contatoId).maybeSingle();
           if (contato.is_anonymized) return;
           await admin.from("agent_inbox_items").insert({
             kind: "appointment_recovery_review",
             ref_kind: "appointment",
             ref_id: compromisso,
           });
         }`,
      ],
    ]);

    const achados = produtores(fontes);

    expect(achados).toHaveLength(1);
    expect(semGuarda(achados)).toEqual([]);
  });

  it("produtor de outro `ref_kind` não é cobrado — a obrigação é do vínculo com o compromisso", () => {
    const fontes = new Map<string, string>([
      [
        "lib/fixture/outro-ref-kind.ts",
        `async function abrir(admin: Admin) {
           await admin.from("agent_inbox_items").insert({
             kind: "followup_dead",
             ref_kind: "followup_enrollment",
             ref_id: matricula,
           });
         }`,
      ],
    ]);

    expect(produtores(fontes)).toEqual([]);
  });
});

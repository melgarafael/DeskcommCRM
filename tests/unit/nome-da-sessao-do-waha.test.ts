import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TETO_NOME_DE_SESSAO_WAHA, nomeCurtoDaSessao, nomeDaSessaoCabeNoWaha } from "@/lib/channels/nome-da-sessao";

const RAIZ = process.cwd();
const ORG = "20000000-0000-4000-8000-000000000001";
const AJUDANTE = join("lib", "channels", "nome-da-sessao.ts");
/** Montagem à mão do formato curto: `org_${…slice(0, 8)}` fora do helper. */
const MONTAGEM_A_MAO = /`org_\$\{[^}]*slice\(\s*0\s*,\s*8\s*\)/;
/** Construções à mão que ficam de fora, com o motivo escrito. */
const EXCECOES: Record<string, string> = {
  // Mesmo formato curto, mas para o WaCalls (voz), não para o WAHA: o nome já
  // nasce com 12 caracteres e não tem o defeito da #667. Trocar o motor de voz
  // não é assunto desta correção.
  [join("app", "api", "v1", "voice", "sessions", "pair", "route.ts")]: "WaCalls, não WAHA",
};

function varrer(dir: string, achados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (["node_modules", ".next", "dist", "coverage"].includes(entrada.name)) continue;
      varrer(caminho, achados);
    } else if (/\.(ts|tsx)$/.test(entrada.name) && !/\.(test|spec)\./.test(entrada.name)) achados.push(caminho);
  }
  return achados;
}

describe("nome da sessão do WAHA cabe no teto de 54", () => {
  it("o teto é o `@MaxLength(54)` do WAHA", () => {
    expect(TETO_NOME_DE_SESSAO_WAHA).toBe(54);
  });
  it("o formato curto do onboarding cabe com folga", () => {
    const nome = nomeCurtoDaSessao(ORG);
    expect(nome).toBe("org_20000000");
    expect(nome).toHaveLength(12);
    expect(nomeDaSessaoCabeNoWaha(nome)).toBe(true);
  });
  it("o limite é inclusivo: 54 cabe, 55 não", () => {
    expect(nomeDaSessaoCabeNoWaha("x".repeat(54))).toBe(true);
    expect(nomeDaSessaoCabeNoWaha("x".repeat(55))).toBe(false);
  });
  it("o formato antigo do banco (69) passava do teto; o de hoje (45) não", () => {
    const antigo = `org_${ORG.replaceAll("-", "")}_${ORG.replaceAll("-", "")}`;
    const hoje = `org_${ORG.replaceAll("-", "").slice(0, 8)}_${ORG.replaceAll("-", "")}`;
    expect(antigo).toHaveLength(69);
    expect(nomeDaSessaoCabeNoWaha(antigo)).toBe(false);
    expect(hoje).toHaveLength(45);
    expect(nomeDaSessaoCabeNoWaha(hoje)).toBe(true);
  });
  it("nenhuma superfície monta o nome à mão — a fonte é uma só", () => {
    const arquivos = [...varrer(join(RAIZ, "app")), ...varrer(join(RAIZ, "lib"))];
    // a varredura só vale alguma coisa se tiver varrido a árvore de verdade
    expect(arquivos.length).toBeGreaterThan(200);
    expect(arquivos.some((a) => a.endsWith(join("app", "onboarding", "connect-whatsapp", "page.tsx")))).toBe(true);
    const permitido = (a: string) => a.endsWith(AJUDANTE) || Object.keys(EXCECOES).some((e) => a.endsWith(e));
    expect(arquivos.filter((a) => !permitido(a) && MONTAGEM_A_MAO.test(readFileSync(a, "utf8")))).toEqual([]);
  });
  it("as duas superfícies derivam do helper", () => {
    const tela = readFileSync(join(RAIZ, "app", "onboarding", "connect-whatsapp", "page.tsx"), "utf8");
    const sessao = readFileSync(join(RAIZ, "lib", "channels", "onboarding-session.ts"), "utf8");
    expect(tela).toContain("nomeCurtoDaSessao(activeOrg.orgId)");
    expect(sessao).toContain("nomeCurtoDaSessao(organizationId)");
  });
});

/**
 * O RESUMO DO SEED DE DEMONSTRAÇÃO DIZ O QUE EXISTE, COM OS NOMES DA TELA.
 *
 * Na segunda rodada, com 3 execuções e 4 inscrições no banco, o seed imprimia
 * "0 execuções no histórico" e "0 inscrições" — contava o que a rodada gravou e
 * dizia que era o estado. E mandava olhar "as abas Regras e Atividade" numa tela
 * cuja aba se chama "Automações".
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TELAS_DA_DEMONSTRACAO,
  textoDoResumo,
  type EstadoDaDemonstracao,
} from "../../scripts/lib/resumo-do-seed-de-demonstracao";

const RAIZ = process.cwd();

const SEGUNDA_RODADA: EstadoDaDemonstracao = {
  regras: { existem: 3, ligadas: 3, criadasAgora: 0 },
  execucoes: { existem: 3, criadasAgora: 0 },
  fluxo: { nome: "Retomada de contato (demonstração)", ativo: true },
  inscricoes: { existem: 4, criadasAgora: 0 },
};

/** Os rótulos das abas como a tela os escreve: `<TabsTrigger …>{t("X")}</TabsTrigger>` ou texto cru. */
function abasDaRota(rota: string): string[] {
  const dir = path.join(RAIZ, "app", ...rota.split("/").filter(Boolean));
  const arquivos = [
    path.join(dir, "page.tsx"),
    ...readdirSync(path.join(dir, "_components"))
      .filter((n) => n.endsWith(".tsx"))
      .map((n) => path.join(dir, "_components", n)),
  ];
  const abas: string[] = [];
  for (const arquivo of arquivos) {
    const fonte = readFileSync(arquivo, "utf8");
    for (const m of fonte.matchAll(/<TabsTrigger\b[^>]*>\s*(?:\{t\("([^"]+)"\)\}|([^<{]+?))\s*<\/TabsTrigger>/g)) {
      abas.push((m[1] ?? m[2])!);
    }
  }
  return abas;
}

function rotuloNoMenu(rota: string): string | undefined {
  const catalogo = readFileSync(path.join(RAIZ, "lib/navigation/catalogo.ts"), "utf8");
  return new RegExp(`href: "${rota.replace(/\//g, "\\/")}",\\s*label: "([^"]+)"`).exec(catalogo)?.[1];
}

describe("resumo do seed de demonstração", () => {
  it("numa rodada repetida diz o que existe, e que nada foi criado agora", () => {
    const texto = textoDoResumo(SEGUNDA_RODADA);
    expect(texto).toContain("3 regras de demonstração, 3 ligadas (0 criadas nesta rodada)");
    expect(texto).toContain("3 execuções no histórico (0 criadas nesta rodada)");
    expect(texto).toContain("4 inscrições (0 criadas nesta rodada)");
    expect(texto).not.toMatch(/\b0 (execuções|inscrições)\b/);
  });

  it("não afirma fluxo ativo nem regra ligada que o banco não tem", () => {
    const texto = textoDoResumo({
      ...SEGUNDA_RODADA,
      regras: { existem: 3, ligadas: 1, criadasAgora: 0 },
      fluxo: { ...SEGUNDA_RODADA.fluxo, ativo: false },
    });
    expect(texto).toContain("3 regras de demonstração, 1 ligada");
    expect(texto).toContain('"Retomada de contato (demonstração)" NÃO ativo');
  });

  it("o instrumento lê as abas das telas (controle)", () => {
    // Sem isto, uma regex que deixasse de casar devolveria lista vazia e o caso
    // abaixo reprovaria por outro motivo — ou, afrouxado, passaria medindo nada.
    expect(abasDaRota("/app/webhooks")).toEqual(expect.arrayContaining(["Receber dados", "Automações"]));
    expect(abasDaRota("/app/webhooks")).not.toContain("Regras");
  });

  it("toda tela e toda aba que o resumo manda olhar existem com esse nome", () => {
    const texto = textoDoResumo(SEGUNDA_RODADA);
    for (const { tela, rota, abas } of TELAS_DA_DEMONSTRACAO) {
      expect(rotuloNoMenu(rota), `o menu não chama ${rota} de "${tela}"`).toBe(tela);
      const reais = abasDaRota(rota);
      for (const aba of abas) {
        expect(reais, `${tela} não tem a aba "${aba}"`).toContain(aba);
      }
      expect(texto).toContain(`${tela} › abas ${abas.join(" e ")} (${rota})`);
    }
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RAIZ_DO_REPO, arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * TODO ACESSO A DADOS DO GOOGLE TEM UMA FRASE NA POLÍTICA DE PRIVACIDADE.
 *
 * O Google recusou a verificação do app porque a política padrão
 * (`app/legal/privacy/page.tsx`) explicava a LGPD e não dizia nada sobre a conta
 * Google que o produto lê. A política de dados de usuário dos serviços de API do
 * Google exige que o texto diga, para cada acesso pedido, o que é lido e para
 * quê. Quem acrescenta um escopo novo no código e não acrescenta a frase deixa a
 * instalação de todo cliente sujeita à mesma recusa — e ninguém vê, porque o
 * código compila e a página continua abrindo.
 *
 * A cerca varre o código, descobre os escopos que ele de fato pede e exige que
 * cada um tenha o seu produto citado na seção da política. Escopo novo reprova
 * até alguém decidir, por escrito, em qual frase ele entra.
 */

const POLITICA = "app/legal/privacy/page.tsx";

/** Cada escopo conhecido → o rótulo que a política precisa conter por causa dele. */
const ESCOPOS_DECLARADOS: Record<string, string> = {
  "calendar.events": "Google Agenda:",
  "calendar.readonly": "Google Agenda:",
  adwords: "Google Ads:",
  datamanager: "Google Ads:",
};

function escoposPedidosPeloCodigo(): Map<string, string[]> {
  const achados = new Map<string, string[]>();
  for (const arquivo of arquivosDeCodigo(["app", "lib"])) {
    const texto = readFileSync(arquivo, "utf8");
    for (const m of texto.matchAll(/googleapis\.com\/auth\/([a-z][a-z0-9._-]*)/g)) {
      const escopo = m[1];
      if (!escopo) continue;
      achados.set(escopo, [...(achados.get(escopo) ?? []), caminhoRelativo(arquivo)]);
    }
  }
  return achados;
}

describe("a política de privacidade cobre os acessos ao Google", () => {
  const pedidos = escoposPedidosPeloCodigo();
  const politica = readFileSync(path.join(RAIZ_DO_REPO, POLITICA), "utf8");

  it("a varredura achou os escopos que o produto pede (controle contra zero vacuoso)", () => {
    expect([...pedidos.keys()].sort()).toEqual(
      expect.arrayContaining(["adwords", "calendar.events", "calendar.readonly", "datamanager"]),
    );
  });

  it("nenhum escopo do Google entra no código sem ter uma frase na política", () => {
    const sem = [...pedidos.entries()]
      .filter(([escopo]) => !(escopo in ESCOPOS_DECLARADOS))
      .map(([escopo, onde]) => `${escopo} (em ${onde[0]})`);
    expect(
      sem,
      `Escopo novo do Google sem frase na política de privacidade: ${sem.join(", ")}. ` +
        `Acrescente, na seção "Dados do Google" de ${POLITICA}, o que esse acesso lê e para quê, ` +
        `e declare o escopo em ESCOPOS_DECLARADOS neste teste.`,
    ).toEqual([]);
  });

  it("cada escopo declarado tem o seu produto citado na seção da política", () => {
    for (const rotulo of new Set(Object.values(ESCOPOS_DECLARADOS))) {
      expect(politica, `a política não cita "${rotulo}"`).toContain(rotulo);
    }
  });

  it("a seção carrega o selo de Uso Limitado e o caminho para revogar", () => {
    expect(politica).toContain("requisitos de Uso Limitado");
    expect(politica).toContain("myaccount.google.com/permissions");
  });
});

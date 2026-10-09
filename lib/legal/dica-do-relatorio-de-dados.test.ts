/**
 * A DICA DA TELA MARCA FALA A LÍNGUA DO PAÍS DA ORGANIZAÇÃO (#2503).
 *
 * Em Portugal, o campo que o Brasil chama de "Razão social" se chama
 * "Denominação social", e a lei é o RGPD — a dica continuava mandando conferir
 * "Razão social" e falando de LGPD, apontando para um campo com outro nome na
 * própria tela de Configurações. O #2502/#1946 puseram o vocabulário no perfil
 * do país; esta é a última frase da tela que ainda o escrevia em duro.
 *
 * O primeiro caso é a régua mais dura do PR: **no Brasil o texto não muda um
 * byte**. Os outros provam que em Portugal ele muda de verdade — e que nenhum
 * placeholder sobra.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { DICA_DO_RELATORIO, dicaDoRelatorio } from "./dica-do-relatorio-de-dados";

const BR = { lei: "LGPD", rotuloNomeLegal: "Razão social" };
const PT = { lei: "RGPD", rotuloNomeLegal: "Denominação social" };

/** A frase que a tela escrevia em duro até este PR — a régua do Brasil. */
const LITERAL_ANTIGO =
  'O relatório de LGPD entregue ao cliente traz a RAZÃO SOCIAL da sua empresa, e não o nome aqui de cima — é ela que responde legalmente pelos dados. Confira o campo "Razão social" em Configurações → Organização.';

describe("a dica do relatório fala a língua do país", () => {
  it("⭐ no Brasil o texto não muda um byte", () => {
    expect(dicaDoRelatorio((texto) => texto, BR)).toBe(LITERAL_ANTIGO);
  });

  it("⭐ em Portugal a dica nomeia a Denominação social e o RGPD", () => {
    const texto = dicaDoRelatorio((texto) => texto, PT);

    expect(texto).toContain("RGPD");
    expect(texto).toContain("DENOMINAÇÃO SOCIAL");
    expect(texto).toContain('"Denominação social"');
    expect(texto, "a dica ainda fala de LGPD para uma organização portuguesa").not.toContain("LGPD");
    expect(texto, "a dica ainda manda conferir Razão social").not.toContain("Razão social");
    expect(texto, "sobrou placeholder na frase").not.toContain("{");
  });

  it("o lugar do campo é o mesmo nos dois países (par de vacuidade)", () => {
    // Sem isto, uma frase que só trocasse a lei passaria no caso PT por acaso
    // (o `not.toContain("Razão social")` continuaria verdadeiro) e a régua do
    // Brasil não provaria que o VOCABULÁRIO entra na frase. Normaliza os TRÊS
    // pontos variáveis (lei, caixa alta e rótulo) e exige o mesmo esqueleto.
    const normalizar = (texto: string) =>
      texto
        .replace("LGPD", "L").replace("RGPD", "L")
        .replace("RAZÃO SOCIAL", "X").replace("DENOMINAÇÃO SOCIAL", "X")
        .replace('"Razão social"', "Y").replace('"Denominação social"', "Y");
    expect(normalizar(dicaDoRelatorio((texto) => texto, BR))).toBe(
      normalizar(dicaDoRelatorio((texto) => texto, PT)),
    );
  });
});

describe("a chave do dicionário é o template, e o espanhol o cobra", () => {
  it("o template está no dicionário com os três placeholders preservados", () => {
    const es = DICIONARIO[DICA_DO_RELATORIO]?.es;
    expect(es, "a chave nova ficou sem espanhol").toBeTruthy();
    for (const marca of ["{lei}", "{campo_alto}", "{campo}"]) {
      expect(DICA_DO_RELATORIO).toContain(marca);
      expect(es, `a tradução perdeu ${marca}`).toContain(marca);
    }
  });
});

describe("no Brasil, fora do português, o texto é o da main", () => {
  // O rótulo do campo passa por `t` como na tela de Organização
  // (`app/app/settings/tenant/_form.tsx`): sem isso, a organização brasileira
  // com a tela em espanhol leria "RAZÃO SOCIAL"/"Razão social" no meio da frase
  // em espanhol, apontando para um campo que ali se chama "Razón social".
  it("⭐ em espanhol, byte a byte a frase de antes do #2503", () => {
    const es = (texto: string) => DICIONARIO[texto]?.es ?? texto;
    expect(dicaDoRelatorio(es, BR)).toBe(
      'El informe de LGPD que se entrega al cliente incluye la RAZÓN SOCIAL de tu empresa, no el nombre de arriba, porque es ella quien responde legalmente por los datos. Revisa el campo "Razón social" en Configuración → Organización.',
    );
  });

  it("em inglês (catálogo em construção), byte a byte a frase de antes do #2503", () => {
    const catalogo = JSON.parse(
      readFileSync(path.join(process.cwd(), "lib/i18n/traducoes/en.json"), "utf8"),
    ) as Record<string, string>;
    const en = (texto: string) => catalogo[texto] ?? texto;
    expect(dicaDoRelatorio(en, BR)).toBe(
      'The LGPD report delivered to the client shows your company\'s LEGAL NAME, not the name above — it\'s the legal name that\'s liable for the data. Check the "Legal name" field in Settings → Organization.',
    );
  });
});

describe("o call site usa a dica com o vocabulário do país", () => {
  // Teste de função pura que passasse com a tela escrevendo o literal de novo
  // não provaria nada: o defeito morava no CALL SITE. A régua da tela inteira
  // (render) é da revisão do mantenedor; aqui se mede o elo que o diff toca.
  const FORM = readFileSync(
    path.join(process.cwd(), "app/app/settings/marca/_form.tsx"),
    "utf8",
  );
  const PAGINA = readFileSync(
    path.join(process.cwd(), "app/app/settings/marca/page.tsx"),
    "utf8",
  );

  it("o formulário renderiza `dicaDoRelatorio(t, vocabulario)` e não guarda a frase", () => {
    expect(FORM).toContain("dicaDoRelatorio(t, vocabulario)");
    expect(FORM, "a frase literal voltou para a tela").not.toContain(LITERAL_ANTIGO);
  });

  it("a página lê `country` da organização e resolve o perfil do país", () => {
    expect(PAGINA).toContain("perfilDoPais(");
    expect(PAGINA, "a página não lê a coluna do país").toMatch(/select\("settings, country"\)/);
    expect(PAGINA).toContain("vocabulario={{");
  });
});

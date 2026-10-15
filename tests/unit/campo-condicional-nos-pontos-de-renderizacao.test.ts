import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A FIAÇÃO DOS QUATRO PONTOS QUE RENDERIZAM CAMPOS PERSONALIZADOS (#2728).
 *
 * O filtro mora num lugar só — `CustomFieldsEditor`, o renderizador único que
 * os quatro pontos compartilham — e é ISSO que esta suíte protege: o dia em que
 * alguém renderizar `fieldDefs` direto num deles (um `fields.map` novo), o
 * campo condicional volta a aparecer e nenhum teste de DOM do editor percebe,
 * porque o editor continua filtrando os campos que passam por ele.
 *
 * O segundo fio é a PRESERVAÇÃO DO DADO: os três editores entregam o objeto de
 * valores INTEIRO ao editor (`value={...}`), então o que está escondido segue
 * dentro do estado — e vai para o save. Um deles montando `value` só com os
 * campos visíveis apagaria o dado gravado toda vez que a condição mudasse.
 */
const EDITORES = [
  "components/contacts/EditContactDialog.tsx",
  "components/inbox/CRMSidePanel.tsx",
  "components/kanban/LeadFieldsForm.tsx",
];

function fonte(arquivo: string): string {
  return readFileSync(join(process.cwd(), arquivo), "utf8");
}

describe("o filtro vive no renderizador único", () => {
  it("CustomFieldsEditor decide visibilidade com camposVisiveis, sobre a lista inteira", () => {
    const texto = fonte("components/contacts/CustomFieldsEditor.tsx");
    expect(texto, "CustomFieldsEditor não chama camposVisiveis").toMatch(/camposVisiveis\(/);
    expect(texto, "o filtro precisa olhar o valor atual, não uma lista fixa").toMatch(
      /camposVisiveis\(fields,\s*value\)/,
    );
  });

  for (const arquivo of EDITORES) {
    it(`${arquivo} renderiza pelo CustomFieldsEditor`, () => {
      const texto = fonte(arquivo);
      expect(texto, `${arquivo} não importa o CustomFieldsEditor`).toMatch(
        /from "@\/components\/contacts\/CustomFieldsEditor"/,
      );
      // Nenhum ponto pode mapear as definições por conta própria.
      expect(texto, `${arquivo} mapeia fieldDefs sem passar pelo filtro`).not.toMatch(
        /fieldDefs\.map\(|customFieldDefs\.map\(|fields\.map\(/,
      );
    });
  }

  it("LeadDossier renderiza os campos do lead pelo LeadFieldsForm", () => {
    const texto = fonte("components/kanban/LeadDossier.tsx");
    expect(texto).toMatch(/<LeadFieldsForm\b/);
    expect(texto).not.toMatch(/fieldDefs\.map\(/);
  });
});

describe("o valor escondido segue dentro do estado de cada editor", () => {
  const CASOS: Array<{ arquivo: string; valor: RegExp }> = [
    { arquivo: "components/contacts/EditContactDialog.tsx", valor: /value=\{customFields/ },
    { arquivo: "components/inbox/CRMSidePanel.tsx", valor: /value=\{customFields/ },
    { arquivo: "components/kanban/LeadFieldsForm.tsx", valor: /value=\{customFields/ },
  ];

  for (const caso of CASOS) {
    it(`${caso.arquivo} entrega o objeto de valores inteiro`, () => {
      expect(fonte(caso.arquivo)).toMatch(caso.valor);
    });
  }

  it("a ficha do contato grava o custom_fields completo — o campo oculto viaja no PATCH", () => {
    const texto = fonte("components/contacts/EditContactDialog.tsx");
    expect(texto).toMatch(/payload\.custom_fields\s*=\s*values\.custom_fields/);
  });
});

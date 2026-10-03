/**
 * FRASE MONTADA EM PEDAÇOS: A CONJUNÇÃO E A ORDEM VÊM DO DICIONÁRIO.
 *
 * ─── Os dois defeitos que estes casos prendem ──────────────────────────────
 *
 * 1. O editor da ação do follow-up dizia `{t("{{volta}}")} e {t("{{voltas}}")}`:
 *    o "e" era texto cru de JSX entre duas chamadas `t()`, e quem usa em
 *    espanhol lia "{{volta}} e {{voltas}}" no meio de uma frase em espanhol.
 *    O guarda do espanhol não vê uma letra solta, então o verde dele não prova
 *    nada aqui — quem prova é a tela montada com `idioma="es"`.
 * 2. "há N dias" era `t("há")` + número + unidade. Em português e em espanhol
 *    o marcador vem antes ("hace 3 días"); em inglês vem depois ("3 days ago"),
 *    e nenhuma tradução de `t("há")` sozinho conserta a ordem. Virou uma chave
 *    com lacuna, `há {tempo}`, e cada língua põe a lacuna onde precisa.
 *
 * O que NÃO pode mudar: o português sai byte a byte igual a antes, e o espanhol
 * também (`hace` já vinha antes do número).
 *
 *     pnpm vitest run tests/unit/frase-em-pedacos-segue-a-lingua.test.tsx
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ActionForm } from "@/app/app/ai/followups/[id]/_components/forms/ActionForm";
import { SuspendedBanner } from "@/components/admin/tenants/SuspendedBanner";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { Idioma } from "@/lib/i18n/idiomas";

afterEach(cleanup);

function dicaDaAcaoDeTexto(idioma: Idioma): string {
  const { container } = render(
    <IdiomaProvider locale={idioma}>
      <ActionForm config={{ mode: "text", body: "Oi" }} onChange={() => {}} />
    </IdiomaProvider>,
  );
  const dica = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("{{voltas}}"));
  expect(dica, "a dica do laço não foi achada no modo texto").toBeTruthy();
  return dica?.textContent ?? "";
}

function faixaDeSuspensao(idioma: Idioma, diasAtras: number): string {
  // Meio-dia a mais, para o `Math.floor` dos dias não depender do relógio do teste.
  const em = new Date(Date.now() - (diasAtras + 0.5) * 24 * 60 * 60 * 1000).toISOString();
  const { container } = render(
    <IdiomaProvider locale={idioma}>
      <SuspendedBanner suspendedAt={em} reason="motivo" />
    </IdiomaProvider>,
  );
  return container.textContent ?? "";
}

describe("a conjunção entre as duas variáveis do laço passa por t()", () => {
  it("em espanhol, a dica diz 'y' entre as variáveis", () => {
    expect(dicaDaAcaoDeTexto("es")).toContain("{{volta}} y {{voltas}}");
  });

  it("em português, a dica segue igual", () => {
    expect(dicaDaAcaoDeTexto("pt-BR")).toContain(
      "Sai exatamente assim, sem IA. No laço, {{volta}} e {{voltas}} viram o número da volta.",
    );
  });
});

describe("'há' + duração é uma chave com lacuna", () => {
  it("o dicionário tem a chave com lacuna, e não o 'há' solto", () => {
    expect(DICIONARIO["há {tempo}"]?.es).toBe("hace {tempo}");
    expect(DICIONARIO["há"]).toBeUndefined();
  });

  it("em português, a faixa de suspensão sai como antes", () => {
    expect(faixaDeSuspensao("pt-BR", 3)).toContain("há 3 dias");
    expect(faixaDeSuspensao("pt-BR", 14)).toContain("há 2 semanas");
  });

  it("em espanhol, o marcador continua antes do número", () => {
    expect(faixaDeSuspensao("es", 3)).toContain("hace 3 días");
  });
});

import { describe, expect, it } from "vitest";

import {
  BUMP_DO_IMPACTO,
  calcularBump,
  FragmentoInvalido,
  Impacto,
  parseFragmento,
  proximaVersao,
} from "./fragmento";

const bom = [
  "---",
  "impacto: nada_mudou",
  "secao: corrigido",
  "titulo: A IA avisa antes de chamar uma pessoa",
  "---",
  "",
  "Quando o atendimento parava, o cliente não recebia mensagem nenhuma.",
].join("\n");

describe("fragmento — o que o PR declara", () => {
  it("lê frontmatter e corpo", () => {
    const f = parseFragmento("x.md", bom);
    expect(f.impacto).toBe("nada_mudou");
    expect(f.secao).toBe("corrigido");
    expect(f.titulo).toBe("A IA avisa antes de chamar uma pessoa");
    expect(f.corpo).toContain("não recebia mensagem");
    expect(f.atencao).toBeNull();
  });

  it("aceita comentário depois de ` #`, mas não corta um `#` colado no valor", () => {
    const f = parseFragmento("x.md", bom.replace("impacto: nada_mudou", "impacto: nada_mudou # patch"));
    expect(f.impacto).toBe("nada_mudou");
    const t = parseFragmento("x.md", bom.replace("titulo: A IA", "titulo: Conserta o #351 da"));
    expect(t.titulo).toContain("#351");
  });

  it.each([
    ["sem frontmatter", "só o corpo"],
    ["frontmatter aberto e não fechado", "---\nimpacto: nada_mudou\nsem fim"],
    ["impacto fora do vocabulário", bom.replace("nada_mudou", "minor")],
    ["seção fora do vocabulário", bom.replace("secao: corrigido", "secao: removido")],
    ["título vazio", bom.replace("titulo: A IA avisa antes de chamar uma pessoa", "titulo:   ")],
    ["corpo vazio", bom.split("\n").slice(0, 5).join("\n")],
  ])("recusa: %s", (_nome, texto) => {
    expect(() => parseFragmento("x.md", texto)).toThrow(FragmentoInvalido);
  });

  // Cada caso abaixo é um defeito que apareceria na TELA do dono da VPS, não no
  // repositório — por isso a recusa é na entrada, não na revisão.
  it.each([
    ["heading no corpo decapita a seção", "## Adicionado à força"],
    ["um segundo ⚠️ desloca o bloco de atenção", "⚠️ cuidado"],
    ["referência de link no meio aparece crua", "[a]: https://exemplo.test"],
    ["`**` que não fecha vaza asterisco para a tela", "isto é **importante"],
  ])("recusa corpo que quebra o parser da tela: %s", (_nome, linha) => {
    expect(() => parseFragmento("x.md", `${bom}\n${linha}`)).toThrow(FragmentoInvalido);
  });

  it("exige_acao sem bloco de aviso é recusado — e o contrário também", () => {
    const semAviso = bom.replace("impacto: nada_mudou", "impacto: exige_acao");
    expect(() => parseFragmento("x.md", semAviso)).toThrow(/Requer atenção/);

    const avisoSemAcao = `${bom}\n\n## Requer atenção\n\nEdite o .env antes.`;
    expect(() => parseFragmento("x.md", avisoSemAcao)).toThrow(/exige_acao/);
  });

  it("com exige_acao, o aviso sai separado do corpo", () => {
    const texto = `${bom.replace("impacto: nada_mudou", "impacto: exige_acao")}\n\n## Requer atenção\n\nRode \`bash update.sh\` duas vezes.`;
    const f = parseFragmento("x.md", texto);
    expect(f.atencao).toContain("duas vezes");
    expect(f.corpo).not.toContain("duas vezes");
  });
});

describe("o número é consequência do efeito declarado", () => {
  // A régua ESCRITA, presa por valor. Comparar `calcularBump(x)` com
  // `BUMP_DO_IMPACTO[x]` não serve de guarda: as duas pontas derivam da mesma
  // fonte, então inverter a tabela move as duas juntas e o teste passa —
  // medido, sabotando `nada_mudou` para `minor` (a régua que causou o
  // problema): aquele caso ficou VERDE. O que vigia a régua é esta tabela
  // literal, que é a mesma de `docs/doctrine/versionamento.md`.
  it.each([
    ["nada_mudou", "patch"],
    ["capacidade_nova", "minor"],
    ["exige_acao", "minor"],
  ] as const)("%s produz %s", (impacto, esperado) => {
    expect(BUMP_DO_IMPACTO[impacto]).toBe(esperado);
    expect(calcularBump([impacto])).toBe(esperado);
  });

  it("todo impacto do vocabulário tem bump — nenhum cai no vazio", () => {
    for (const impacto of Impacto.options) {
      expect(BUMP_DO_IMPACTO[impacto], `impacto sem bump: ${impacto}`).toBeDefined();
    }
  });

  it("o conjunto vale pelo mais severo, em qualquer ordem", () => {
    expect(calcularBump(["nada_mudou", "capacidade_nova"])).toBe("minor");
    expect(calcularBump(["capacidade_nova", "nada_mudou"])).toBe("minor");
    expect(calcularBump(["exige_acao", "nada_mudou", "capacidade_nova"])).toBe("minor");
    expect(calcularBump(["nada_mudou", "nada_mudou"])).toBe("patch");
  });

  it("major só sai com o pedido explícito de quem corta — nenhum fragmento o produz", () => {
    // Decisão do dono (07/10): "Major update é somente quando eu pedir. IA nem
    // nenhum workflow decide isso!" Sem o pedido, nenhum conjunto chega a major.
    for (const impacto of Impacto.options) {
      expect(calcularBump([impacto]), impacto).not.toBe("major");
      expect(calcularBump([impacto], true), impacto).toBe("major");
    }
    expect(calcularBump(["exige_acao", "exige_acao"])).toBe("minor");
    expect(proximaVersao("1.7.3", calcularBump(["exige_acao"]))).toBe("1.8.0");
    expect(proximaVersao("1.7.3", calcularBump(["nada_mudou"], true))).toBe("2.0.0");
  });

  it("sem fragmento não há release — nunca um patch inventado", () => {
    expect(() => calcularBump([])).toThrow(FragmentoInvalido);
  });

  it("o conserto de um bug NÃO sobe a minor — a régua que causou o problema", () => {
    // v1.6.0 justificou MINOR com "muda comportamento visível ao cliente
    // final" (commit e9df4bae). Conserto muda comportamento visível por
    // definição; sob aquela régua todo conserto era minor.
    expect(proximaVersao("1.6.0", calcularBump(["nada_mudou"]))).toBe("1.6.1");
  });

  it.each([
    ["1.6.0", "patch", "1.6.1"],
    ["1.6.1", "minor", "1.7.0"],
    ["1.7.0", "major", "2.0.0"],
    ["v1.6.0", "patch", "1.6.1"],
  ] as const)("%s + %s = %s", (base, bump, esperado) => {
    expect(proximaVersao(base, bump)).toBe(esperado);
  });

  it.each(["1.6", "1.6.0-rc1", "latest", ""])("recusa base que não é X.Y.Z: %s", (base) => {
    expect(() => proximaVersao(base, "patch")).toThrow(FragmentoInvalido);
  });
});

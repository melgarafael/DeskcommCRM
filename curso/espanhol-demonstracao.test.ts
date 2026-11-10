// @vitest-environment node
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textoDaDemonstracao, traducaoDaDemonstracao } from "./espanhol-demonstracao";
import { lerHistorias, receitas } from "./receitas-jornadas";

afterEach(() => vi.unstubAllEnvs());

/** Lê o dataset, sem importar a semente que conhece a conexão da bancada. */
function textosDasConversasDaBase() {
  const fonte = ts.createSourceFile(
    "semear-demonstracao.ts",
    readFileSync(new URL("./semear-demonstracao.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const textos: string[] = [];
  const coletar = (no: ts.Node) => {
    if (
      ts.isCallExpression(no) &&
      no.expression.getText(fonte) === "m" &&
      no.arguments[2] &&
      ts.isStringLiteral(no.arguments[2])
    )
      textos.push(no.arguments[2].text);
    if (
      ts.isPropertyAssignment(no) &&
      no.name.getText(fonte) === "texto" &&
      ts.isStringLiteral(no.initializer)
    )
      textos.push(no.initializer.text);
    ts.forEachChild(no, coletar);
  };
  const achar = (no: ts.Node) => {
    if (ts.isVariableDeclaration(no) && no.name.getText(fonte) === "CONVERSAS" && no.initializer)
      coletar(no.initializer);
    else ts.forEachChild(no, achar);
  };
  achar(fonte);
  return textos;
}

describe("texto fictício das capturas em espanhol", () => {
  it("preserva o texto original no curso em português", () => {
    vi.stubEnv("CURSO_IDIOMA", "pt-BR");
    expect(textoDaDemonstracao("Uma frase nova do roteiro.")).toBe("Uma frase nova do roteiro.");
    expect(textoDaDemonstracao("Quero visitar antes de decidir.")).toBe(
      "Quero visitar antes de decidir.",
    );
  });

  it("cobre todas as histórias, mensagens e contextos exibidos pelo seed", () => {
    vi.stubEnv("CURSO_IDIOMA", "es");
    const textos = lerHistorias().flatMap((h) => [
      h.titulo,
      h.contexto,
      ...h.cenas.flatMap((c) => [c.titulo, c.operacao, c.valor]),
    ]);
    textos.push(...receitas.flatMap((r) => r.cenas.flatMap((c) => [c.mensagem, c.resposta])));
    const conversasDaBase = textosDasConversasDaBase();
    expect(conversasDaBase.length).toBeGreaterThan(25);
    textos.push(...conversasDaBase);
    for (const texto of new Set(textos.filter(Boolean))) {
      expect(traducaoDaDemonstracao(texto), `tradução ausente: ${texto}`).toBeTypeOf("string");
      expect(textoDaDemonstracao(texto).trim().length).toBeGreaterThan(0);
    }
  });

  it("recusa prosa sem tradução, preservando nomes declarados, números e códigos", () => {
    vi.stubEnv("CURSO_IDIOMA", "es");
    expect(() => textoDaDemonstracao("Uma frase nova do roteiro.")).toThrow(/sem tradução/);
    for (const texto of [
      "",
      "Marina Exemplo",
      "Casa das Trilhas",
      "CT-4729",
      "RASTREIO-EXEMPLO-4729",
      "280,00",
      "deca0000-0000-4000-8000-000000000103",
    ])
      expect(textoDaDemonstracao(texto)).toBe(texto);
    expect(traducaoDaDemonstracao("Uma frase nova do roteiro.")).toBeUndefined();
  });

  it("consulta traduções sem depender do idioma e conserva tokens de negócio", () => {
    vi.stubEnv("CURSO_IDIOMA", "pt-BR");
    expect(traducaoDaDemonstracao("Quero visitar antes de decidir.")).toBe(
      "Quiero visitarlo antes de decidir.",
    );
    expect(
      traducaoDaDemonstracao(
        "Oi, {{primeiro_nome}}! A Dra. Lívia atende às terças e quintas, das 8h às 12h. Qual dia fica melhor para você?",
      ),
    ).toContain("{{primeiro_nome}}");
    const resposta = receitas
      .find((r) => r.jornada === "e-commerce-consultar-pedido")!
      .cenas.find((c) => c.resposta.includes("RASTREIO-EXEMPLO-4729"))!.resposta;
    expect(traducaoDaDemonstracao(resposta)).toContain("CT-4729");
    expect(traducaoDaDemonstracao(resposta)).toContain("RASTREIO-EXEMPLO-4729");
  });
});

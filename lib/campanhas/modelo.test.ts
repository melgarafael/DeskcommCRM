/**
 * Campanha com modelo aprovado: o mapa diz de onde sai cada variável, e a
 * preparação resolve contato a contato. Variável vazia num contato tira ESTE
 * contato da lista (`variavel_ausente`) — nunca vira "Olá !" no WhatsApp.
 */
import { describe, expect, it } from "vitest";

import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";

import {
  camposDoNegocioUsados,
  problemasDoMapa,
  resolverValoresDaCampanha,
  textoDoModeloParaAConversa,
  variaveisDaCampanhaSchema,
} from "./modelo";

const COMPONENTES = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Olá {{1}}! Sua {{2}} por {{3}} com frete grátis." },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Quero" }] },
];
const CONTRATO = deriveTemplateContract({
  name: "oferta",
  language: "pt_BR",
  parameter_format: "POSITIONAL",
  components: COMPONENTES as never,
});
const MAPA = variaveisDaCampanhaSchema.parse({
  "header:1": { kind: "fixed", value: "https://cdn.x/cafeteira.jpg" },
  "1": { kind: "contact_first_name" },
  "2": { kind: "lead_custom", key: "produto" },
  "3": { kind: "fixed", value: "R$ 189,90" },
});

describe("problemasDoMapa", () => {
  it("mapa completo: nenhum problema", () => {
    expect(problemasDoMapa(CONTRATO, MAPA)).toEqual([]);
  });

  it("variável sem origem e mídia que não é link público são recusadas ao salvar", () => {
    const { "2": _sem, ...semDois } = MAPA;
    void _sem;
    const problemas = problemasDoMapa(CONTRATO, { ...semDois, "header:1": { kind: "fixed", value: "cafeteira.jpg" } });
    expect(problemas).toHaveLength(2);
    expect(problemas.join(" ")).toMatch(/\{\{2\}\}/);
    expect(problemas.join(" ")).toMatch(/https:\/\//);
  });

  it("mídia do cabeçalho não aceita nome do contato — contato não tem de onde tirar uma imagem", () => {
    expect(problemasDoMapa(CONTRATO, { ...MAPA, "header:1": { kind: "contact_name" } })).toHaveLength(1);
  });
});

describe("resolverValoresDaCampanha", () => {
  it("resolve cada variável para o contato: primeiro nome, campo do negócio, texto fixo e link", () => {
    const r = resolverValoresDaCampanha(CONTRATO, MAPA, {
      nomeDoContato: "Maria José Pereira",
      camposDoNegocio: { produto: "Cafeteira Elétrica" },
    });
    expect(r).toEqual({
      ok: true,
      values: { "header:1": "https://cdn.x/cafeteira.jpg", "1": "Maria", "2": "Cafeteira Elétrica", "3": "R$ 189,90" },
    });
  });

  it("contato sem o dado sai da lista com o motivo — e telefone no lugar do nome não conta como nome", () => {
    const r = resolverValoresDaCampanha(CONTRATO, MAPA, { nomeDoContato: "+5511987654321", camposDoNegocio: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problemas).toHaveLength(2);
  });
});

describe("o que a conversa guarda", () => {
  it("o texto do modelo com os valores do contato — o que o agente lê quando o cliente responde", () => {
    const texto = textoDoModeloParaAConversa(
      { name: "oferta", language: "pt_BR", parameterFormat: "POSITIONAL", components: COMPONENTES },
      { "header:1": "https://cdn.x/cafeteira.jpg", "1": "Maria", "2": "Cafeteira", "3": "R$ 189,90" },
    );
    expect(texto).toBe("Olá Maria! Sua Cafeteira por R$ 189,90 com frete grátis.");
  });

  it("só lê campos do negócio quando o mapa usa algum", () => {
    expect(camposDoNegocioUsados(MAPA)).toEqual(["produto"]);
    expect(camposDoNegocioUsados({ "1": { kind: "contact_name" } })).toEqual([]);
  });
});

/**
 * O caso que só apareceu no uso real.
 *
 * Percorrendo o wizard num ambiente com o catálogo da OpenRouter sincronizado
 * (400 modelos, 333 com ferramentas), o agente ficou em rascunho e a tela disse
 * que a instalação "ainda não baixou a lista de modelos". A lista estava lá. O
 * que faltava era `is_default_for_provider`, que o cron de sincronização não
 * escreve — então esperar a atualização diária, que era o conselho da tela,
 * nunca resolveria.
 */
import { describe, expect, it } from "vitest";

import {
  escolherModeloDoProvedor,
  escolherModeloNoCatalogo,
  type ModeloDoCatalogo,
} from "@/lib/ai/agents/escolher-modelo";

const comTools = (id: string, entrada = 100, saida = 200): ModeloDoCatalogo => ({
  model_id: id,
  supports_tools: true,
  input_price_per_million_cents: entrada,
  output_price_per_million_cents: saida,
});

describe("escolherModeloDoProvedor", () => {
  it("o curado vence — e não é reavaliado por preço", () => {
    // Uma escolha que alguém fez de propósito não deve ser desfeita por um
    // modelo mais barato que apareceu no catálogo.
    const escolha = escolherModeloDoProvedor([
      comTools("barato/x", 1, 1),
      { ...comTools("curado/y", 900, 900), is_default_for_provider: true },
    ]);
    expect(escolha).toEqual({ escolhido: true, modelId: "curado/y", origem: "curado" });
  });

  it("sem curado, escolhe o mais barato QUE SERVE — em vez de travar", () => {
    // Este é o estado real de uma instalação OpenRouter.
    const escolha = escolherModeloDoProvedor([
      comTools("caro/a", 500, 500),
      comTools("barato/b", 10, 20),
      comTools("medio/c", 100, 100),
    ]);
    expect(escolha).toEqual({ escolhido: true, modelId: "barato/b", origem: "automatico" });
  });

  it("NUNCA escolhe modelo sem ferramentas, por mais barato que seja", () => {
    // Modelo sem tool calling não dá erro: responde texto plausível e nada
    // chega ao funil. É o pior desfecho do produto, e sai de graça se a regra
    // for só "o mais barato".
    const escolha = escolherModeloDoProvedor([
      { model_id: "gratis/sem-tools", supports_tools: false, input_price_per_million_cents: 0, output_price_per_million_cents: 0 },
      comTools("pago/com-tools", 300, 300),
    ]);
    expect(escolha).toMatchObject({ escolhido: true, modelId: "pago/com-tools" });
  });

  it("catálogo só com modelos sem ferramentas: recusa, e diz o motivo certo", () => {
    // Dizer "catálogo vazio" aqui mandaria a pessoa esperar um sync que já
    // aconteceu — exatamente a mentira que este arquivo existe para matar.
    const escolha = escolherModeloDoProvedor([
      { model_id: "a", supports_tools: false },
      { model_id: "b", supports_tools: null },
    ]);
    expect(escolha).toEqual({ escolhido: false, motivo: "nenhum_com_ferramentas" });
  });

  it("catálogo vazio é outro motivo — as duas causas pedem conselhos diferentes", () => {
    expect(escolherModeloDoProvedor([])).toEqual({ escolhido: false, motivo: "catalogo_vazio" });
  });

  it("a escolha é estável: mesmo catálogo, mesmo modelo", () => {
    // Sem desempate determinístico, duas execuções poderiam publicar modelos
    // diferentes e "por que mudou?" não teria resposta.
    const catalogo = [comTools("z/igual", 50, 50), comTools("a/igual", 50, 50)];
    const um = escolherModeloDoProvedor(catalogo);
    const dois = escolherModeloDoProvedor([...catalogo].reverse());
    expect(um).toEqual(dois);
    expect(um).toMatchObject({ modelId: "a/igual" });
  });

  it("preço desconhecido não ganha da opção com preço conhecido", () => {
    // `null` não é zero. Tratá-lo como barato faria o sistema escolher
    // justamente o modelo sobre o qual não se sabe o custo.
    const escolha = escolherModeloDoProvedor([
      { model_id: "sem/preco", supports_tools: true },
      comTools("com/preco", 400, 400),
    ]);
    expect(escolha).toMatchObject({ modelId: "com/preco" });
  });

  it("NÃO escolhe o degrau gratuito quando existe um pago que serve", () => {
    // MEDIDO no uso real: a regra do menor preço escolheu
    // `cohere/north-mini-code:free` — gratuito e de programação — para atender
    // os pacientes de uma clínica. Preço zero é limite de requisição, não
    // barganha.
    const escolha = escolherModeloDoProvedor([
      { ...comTools("gratis/limitado", 0, 0) },
      comTools("pago/barato", 15, 30),
      comTools("pago/caro", 900, 900),
    ]);
    expect(escolha).toMatchObject({ modelId: "pago/barato" });
  });

  it("mas usa o gratuito se for tudo o que existe — melhor que ficar sem funcionário", () => {
    const escolha = escolherModeloDoProvedor([
      comTools("gratis/a", 0, 0),
      comTools("gratis/b", 0, 0),
    ]);
    expect(escolha).toMatchObject({ escolhido: true, origem: "automatico" });
  });
});

/**
 * A leitura que o `bootstrap-owner.ts` e o conserto na leitura do par usam: o
 * script do instalador não é importável (roda `main()` ao carregar), então o
 * que se prova aqui é a peça que decide o `default_model` que ele grava.
 */
describe("escolherModeloNoCatalogo", () => {
  function dubleDoAdmin(resposta: { data: unknown; error: unknown }) {
    const filtros: Array<[string, string, unknown]> = [];
    const chain = {
      from: (tabela: string) => {
        filtros.push(["from", tabela, null]);
        return chain;
      },
      select: () => chain,
      eq: (coluna: string, valor: unknown) => {
        filtros.push(["eq", coluna, valor]);
        return chain;
      },
      is: (coluna: string, valor: unknown) => {
        filtros.push(["is", coluna, valor]);
        return chain;
      },
      then: (ok: (r: typeof resposta) => void) => ok(resposta),
    };
    return { admin: chain as unknown as Parameters<typeof escolherModeloNoCatalogo>[0], filtros };
  }

  it("AI_PROVIDER=openai: o par gravado é o curado da OpenAI, lido só do catálogo dela", async () => {
    const { admin, filtros } = dubleDoAdmin({
      data: [
        comTools("gpt-5-mini", 25, 200),
        { ...comTools("gpt-5.6-terra", 250, 1000), is_default_for_provider: true },
      ],
      error: null,
    });
    const escolha = await escolherModeloNoCatalogo(admin, "openai");
    expect(escolha).toEqual({ escolhido: true, modelId: "gpt-5.6-terra", origem: "curado" });
    expect(filtros).toEqual([
      ["from", "ai_models", null],
      ["eq", "provider", "openai"],
      ["is", "deprecated_at", null],
    ]);
  });

  it("catálogo vazio (OpenRouter antes do sync) não escolhe nada", async () => {
    const { admin } = dubleDoAdmin({ data: [], error: null });
    expect(await escolherModeloNoCatalogo(admin, "openrouter")).toEqual({
      escolhido: false,
      motivo: "catalogo_vazio",
    });
  });

  it("leitura que falha é null — distinto de catálogo vazio — e não lança", async () => {
    const { admin } = dubleDoAdmin({ data: null, error: { message: "boom" } });
    expect(await escolherModeloNoCatalogo(admin, "openai")).toBeNull();
  });
});

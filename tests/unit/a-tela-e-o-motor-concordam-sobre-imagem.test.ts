import { describe, expect, it } from "vitest";

import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { decidirBinding } from "@/lib/ai/pontos/resolver";
import { enxergaImagem, visaoEmVigor } from "@/lib/ai/pontos/capacidade-em-vigor";

/**
 * A TELA E O MOTOR RESPONDEM A MESMA COISA SOBRE "ESTE MODELO ENXERGA IMAGEM?".
 *
 * ═══ O defeito, medido numa instalação real ═════════════════════════════════
 *
 * Havia duas verdades. O motor perguntava a `modelCapabilities()`; a tela lia
 * `ai_models.supports_vision`. Na instalação medida a coluna estava `false`
 * para TODOS os modelos do catálogo, então a tela avisava
 *
 *     "gpt-5.6-sol não enxerga imagens. Fotos e comprovantes que o cliente
 *      enviar vão ser ignorados pelo agente."
 *
 * enquanto o motor mandava a imagem e ela era lida — na MESMA instalação, o
 * print que o cliente enviou virou descrição correta.
 *
 * ⚠️ Aviso falso é pior que aviso nenhum: empurra quem opera a trocar um modelo
 * que funciona, ou a desistir de um recurso que está no ar.
 */

const CATALOGO_ERRADO = false; // o que a coluna dizia na instalação medida

describe("a capacidade em vigor é a do motor", () => {
  it("gpt-5.6-sol enxerga, mesmo com a coluna dizendo que não", () => {
    expect(enxergaImagem({ provider: "openai", modelId: "gpt-5.6-sol", doCatalogo: CATALOGO_ERRADO })).toBe(true);
  });

  it("claude-sonnet-5 enxerga, mesmo com a coluna dizendo que não", () => {
    expect(enxergaImagem({ provider: "anthropic", modelId: "claude-sonnet-5", doCatalogo: CATALOGO_ERRADO })).toBe(true);
  });

  it("a resposta é IDÊNTICA à do motor — é a mesma pergunta", () => {
    // O caso que amarra as duas fontes: se alguém mudar o registro do motor
    // amanhã, a tela muda junto. Sem isto, o conserto seria uma cópia que
    // envelhece — que é exatamente o defeito que ele veio resolver.
    for (const [p, m] of [
      ["openai", "gpt-5.6-sol"],
      ["anthropic", "claude-sonnet-5"],
      ["google", "gemini-3-pro"],
    ] as const) {
      expect(enxergaImagem({ provider: p, modelId: m, doCatalogo: CATALOGO_ERRADO }))
        .toBe(modelCapabilities(p, m).image);
    }
  });
});

describe("o que o motor NÃO conhece continua vindo do catálogo", () => {
  it("provedor desconhecido usa a coluna — é o único caso em que ela manda", () => {
    // A coluna não é lixo: o catálogo da OpenRouter a preenche a partir das
    // modalidades que o provedor declara. Onde o registro não tem opinião, ela
    // é o que sobra. Descartá-la seria trocar uma cegueira por outra.
    expect(enxergaImagem({ provider: "provedor-do-cliente", modelId: "modelo-x", doCatalogo: true })).toBe(true);
    expect(enxergaImagem({ provider: "provedor-do-cliente", modelId: "modelo-x", doCatalogo: false })).toBe(false);
  });

  it("desconhecido e sem informação nenhuma: não afirma que enxerga", () => {
    expect(enxergaImagem({ provider: "provedor-do-cliente", modelId: "modelo-x", doCatalogo: null })).toBe(false);
  });

  it("embedding e whisper continuam fora, mesmo em provedor capaz", () => {
    // A deny-list do registro vale: um modelo de embedding num provedor
    // multimodal não vira multimodal.
    expect(enxergaImagem({ provider: "openai", modelId: "text-embedding-3-small", doCatalogo: true })).toBe(false);
    expect(enxergaImagem({ provider: "openai", modelId: "whisper-1", doCatalogo: true })).toBe(false);
  });
});

describe("ponto FIXO anuncia o que ele mesmo usa", () => {
  /**
   * A tela mostrava `claude-sonnet-5` em "Ouvir o áudio do cliente", com
   * "usando o padrão da organização" — ao lado do próprio texto do ponto, que
   * diz "usa o padrão de transcrição da OpenAI". A mesma tela afirmando duas
   * coisas incompatíveis sobre o mesmo ponto.
   *
   * A causa: um ponto `fixo` percorria a cadeia de resolução dos pontos de
   * CONVERSA e caía no último degrau. Modelo de conversa não transcreve áudio —
   * anunciar um ali manda quem opera caçar problema que não existe.
   */
  it("transcricao_de_audio anuncia whisper, e não o modelo de conversa da org", () => {
    const d = decidirBinding({
      pontoId: "transcricao_de_audio",
      binding: null,
      agentePublicado: null,
      modeloDeAmbiente: undefined,
      padraoDaOrganizacao: { provider: "anthropic", defaultModel: "claude-sonnet-5" },
    });

    expect(d.modelId).toBe("whisper-1");
    expect(d.origem).toBe("fixo_do_produto");
    expect(d.modelId, "voltou a anunciar o modelo de conversa").not.toBe("claude-sonnet-5");
  });

  it("o ponto fixo ignora até um binding salvo — a escolha do painel não se aplica", () => {
    // Controle: alguém pode ter um binding antigo gravado para este ponto. Ele
    // não pode ressuscitar o comportamento errado.
    const d = decidirBinding({
      pontoId: "transcricao_de_audio",
      binding: {
        purpose: "transcricao_de_audio",
        provider: "openai",
        model_id: "gpt-5.6-sol",
        credential_id: null,
        base_url: null,
        is_enabled: true,
      },
      agentePublicado: null,
      modeloDeAmbiente: undefined,
      padraoDaOrganizacao: { provider: "anthropic", defaultModel: "claude-sonnet-5" },
    });
    expect(d.modelId).toBe("whisper-1");
  });

  it("ponto NÃO fixo segue a cadeia normal (controle positivo)", () => {
    // Sem este caso, "todo ponto devolve whisper" satisfaria os dois acima.
    //
    // A asserção é sobre NÃO ser o ramo fixo, e não sobre qual modelo sai: com
    // `agentePublicado: null` e sem binding, `visao_de_imagem` cai em
    // `variavel_de_ambiente` (medido) — degrau que não tem nada a ver com este
    // conserto. Prender o modelo aqui seria prender comportamento alheio.
    const d = decidirBinding({
      pontoId: "visao_de_imagem",
      binding: null,
      agentePublicado: null,
      modeloDeAmbiente: undefined,
      padraoDaOrganizacao: { provider: "openai", defaultModel: "gpt-5.6-sol" },
    });
    expect(d.origem).not.toBe("fixo_do_produto");
    expect(d.modelId).not.toBe("whisper-1");
  });
});

/**
 * ═══ O ROTEADOR: onde o registro é PALPITE e o catálogo é MEDIDA ════════════
 *
 * A primeira versão deste conserto dizia "o registro manda, o catálogo é o que
 * sobra" — e isso apagou um aviso que estava CERTO. Achado por revisão
 * adversarial do próprio PR, e remedido rodando a função:
 *
 *     openrouter/openai/gpt-3.5-turbo   catálogo=false  registro=true  → true
 *
 * Num roteador o registro só tem o PREFIXO do id: vê `openai/` e responde pela
 * família. Mas `openai/gpt-4o` enxerga e `openai/gpt-3.5-turbo` não. A coluna
 * vem de `architecture.input_modalities` que a OpenRouter declara — é a única
 * das duas fontes que sabe do MODELO.
 *
 * ⚠️ Os dois sentidos importam, e é por isso que há caso de controle: apagar o
 * aviso falso (provedor direto) era o objetivo do PR; apagar o aviso verdadeiro
 * (roteador) seria pior que o defeito original, porque silêncio não tem sintoma.
 */
describe("no roteador, o catálogo vence o palpite do prefixo", () => {
  it("openrouter + modelo que a OpenRouter declara SEM visão → não enxerga", () => {
    // O caso que derrubou a primeira versão. Antes: true (o prefixo `openai/`
    // fazia o registro afirmar que enxerga) e o aviso sumia da tela.
    expect(
      enxergaImagem({ provider: "openrouter", modelId: "openai/gpt-3.5-turbo", doCatalogo: false }),
    ).toBe(false);
    expect(
      enxergaImagem({ provider: "openrouter", modelId: "google/gemma-2-9b-it", doCatalogo: false }),
    ).toBe(false);
  });

  it("openrouter + modelo que a OpenRouter declara COM visão → enxerga", () => {
    // Controle: se o catálogo sempre vencesse com `false`, o caso acima passaria
    // por imobilidade. Aqui a mesma fonte diz sim e a resposta acompanha.
    expect(
      enxergaImagem({ provider: "openrouter", modelId: "openai/gpt-4o", doCatalogo: true }),
    ).toBe(true);
  });

  it("openrouter SEM linha no catálogo → cai no prefixo, que é melhor que nada", () => {
    // `supports_vision` é `not null default false` no schema: `null` aqui só
    // acontece quando NÃO HÁ LINHA. Aí o palpite do prefixo é a única fonte.
    expect(
      enxergaImagem({ provider: "openrouter", modelId: "openai/gpt-4o", doCatalogo: null }),
    ).toBe(true);
    expect(
      enxergaImagem({ provider: "openrouter", modelId: "mistralai/mistral-7b", doCatalogo: null }),
    ).toBe(false);
  });

  it("⚠️ no provedor DIRETO a coluna continua não mandando — é o defeito original", () => {
    // Numa instalação real a coluna estava `false` para TODOS os modelos. Se o
    // catálogo vencesse aqui, o aviso falso que este arquivo existe para matar
    // voltaria inteiro.
    expect(
      enxergaImagem({ provider: "openai", modelId: "gpt-5.6-sol", doCatalogo: false }),
    ).toBe(true);
    expect(
      enxergaImagem({ provider: "anthropic", modelId: "claude-sonnet-5", doCatalogo: false }),
    ).toBe(true);
  });
});

describe('visaoEmVigor separa "não enxerga" de "não sei"', () => {
  const nunca = async () => {
    throw new Error("o provedor direto NÃO pode consultar o catálogo");
  };

  it("provedor direto não toca o catálogo", async () => {
    // Guarda de custo: um roundtrip por turno para confirmar o que o registro
    // já sabe. O dublê explode se for chamado.
    const r = await visaoEmVigor({ provider: "openai", modelId: "gpt-4o", catalogo: nunca });
    expect(r).toEqual({ enxerga: true, sabemos: true });
  });

  it("roteador com catálogo dizendo não: enxerga=false e SABEMOS", async () => {
    // O que muda o texto do aviso ao operador: "não enxerga imagens" (afirmação)
    // em vez de "não sei se enxerga" (dúvida). Antes disto, este caso nem
    // chegava ao aviso — o worker achava que dava para ver.
    const r = await visaoEmVigor({
      provider: "openrouter",
      modelId: "openai/gpt-3.5-turbo",
      catalogo: async () => false,
    });
    expect(r).toEqual({ enxerga: false, sabemos: true });
  });

  it("roteador sem linha e sem prefixo conhecido: não enxerga e NÃO sabemos", async () => {
    const r = await visaoEmVigor({
      provider: "openrouter",
      modelId: "mistralai/mistral-7b",
      catalogo: async () => null,
    });
    expect(r).toEqual({ enxerga: false, sabemos: false });
  });

  it("catálogo indisponível NÃO derruba o turno — cai no palpite de antes", async () => {
    const r = await visaoEmVigor({
      provider: "openrouter",
      modelId: "openai/gpt-4o",
      catalogo: async () => {
        throw new Error("banco fora");
      },
    });
    expect(r.enxerga).toBe(true);
  });
});

/**
 * ═══ A REGRA ESTÁ GUARDADA; OS LUGARES ONDE A MENTIRA MORAVA NÃO ESTAVAM ════
 *
 * ⚠️ Achado por revisão adversarial DESTE arquivo, e reproduzido: revertendo os
 * call sites — a rota voltando a `supports_vision: modelo?.supports_vision`, o
 * motor voltando a `modelCapabilities(...).image` — o defeito reaparece INTEIRO
 * e a suíte inteira continua verde. Os casos acima importam só as funções puras
 * e nenhum deles alcança a rota, o `media-parts` ou o worker.
 *
 * É a lição que o repo já pagou noutro lugar: *teste guarda a função, não o call
 * site*. Uma regra correta que ninguém chama é uma regra que não existe — e o
 * conserto mora, nos três arquivos, numa linha solta dentro de um objeto, que é
 * exatamente a forma que uma resolução de merge derruba sem ninguém ver.
 *
 * Varredura de fonte, no padrão de `provedores-x-registry.test.ts`: não prova
 * comportamento, prova que a FIAÇÃO continua lá — que é o que se perde.
 */
describe("os três lugares que decidiam sozinhos continuam perguntando à regra", () => {
  const ler = async (p: string) => (await import("node:fs")).readFileSync(p, "utf8");

  it("a rota de provedores resolve a visão pela regra, não pela coluna", async () => {
    const fonte = await ler("app/api/v1/ai/providers/route.ts");
    expect(fonte, "a rota parou de importar a regra").toMatch(
      /import \{[^}]*enxergaImagem[^}]*\} from "@\/lib\/ai\/pontos\/capacidade-em-vigor"/s,
    );
    // Os DOIS call sites: a validação do PUT e a lista do GET.
    expect(
      (fonte.match(/enxergaImagem\(\{/g) ?? []).length,
      "um dos dois call sites da rota voltou a ler a coluna direto",
    ).toBe(2);
    expect(
      fonte,
      'voltou o `supports_vision: modelo?.supports_vision ?? false` que a regra substituiu',
    ).not.toMatch(/supports_vision:\s*modelo\?\.supports_vision/);
  });

  it("o motor anexa a imagem pela regra, não pelo registro cru", async () => {
    const fonte = await ler("lib/agent-engine/agent/media-parts.ts");
    expect(fonte, "media-parts parou de perguntar à regra").toMatch(/visaoEmVigor\(\{/);
    // O PDF PODE continuar no registro (o catálogo não tem coluna de PDF); a
    // imagem não. Se `image:` voltar a sair de modelCapabilities, o roteador
    // volta a receber bytes que recusa.
    expect(fonte, "a imagem voltou a sair do registro cru").not.toMatch(
      /image:\s*modelCapabilities\(/,
    );
  });

  it("o aviso ao operador sai da regra, e por isso distingue não-sei de não-consegue", async () => {
    const fonte = await ler("workers/media-derive-worker.ts");
    expect(fonte, "o worker parou de perguntar à regra").toMatch(/visaoEmVigor\(\{/);
    expect(fonte, "voltou a decidir a visão pelo registro cru").not.toMatch(
      /visionCapable\s*=\s*modelCapabilities\(/,
    );
    expect(
      fonte,
      "o texto do aviso voltou a ignorar o que o catálogo sabe",
    ).not.toMatch(/motivo\s*=\s*capacidadeEhConhecida\(/);
  });
});

import { describe, expect, it, vi } from "vitest";

import type * as ModuloDeEnv from "@/lib/env";

import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { decidirBinding } from "@/lib/ai/pontos/resolver";
import { enxergaImagem, visaoEmVigor } from "@/lib/ai/pontos/capacidade-em-vigor";
import {
  decidirTranscricao,
  type DecisaoDeTranscricao,
} from "@/lib/messaging/media/escada-de-transcricao";

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

/**
 * ═══ A ESCADA DE TRANSCRIÇÃO: A TELA ANUNCIA O DEGRAU QUE VAI RODAR (#2190) ══
 *
 * Depois da #2189 quem ouve o áudio é uma ESCADA
 * (`lib/messaging/media/escada-de-transcricao.ts`): serviço da instalação →
 * chave OpenAI → modelo de conversa da ORGANIZAÇÃO que declare `audio` → nada,
 * com motivo. A organização da issue — Gemini com a chave do Google, SEM conta
 * OpenAI — transcreve pelo próprio modelo de conversa.
 *
 * Mas o registro continuava com `usa: { provider: "openai", modelId: "whisper-1" }`,
 * então a tela anunciava `whisper-1` (e "exige uma chave desse serviço") para
 * quem não tem chave nenhuma da OpenAI. Aviso falso pior que aviso nenhum: é a
 * mesma lição do cabeçalho deste arquivo, virada do avesso — empurra quem opera
 * a cadastrar uma conta que já existe, ou a concluir que o áudio não é ouvido.
 *
 * A régua aqui é a MESMA do resto do arquivo: dois lados, um por origem de
 * verdade. O motor é `decidirTranscricao`; a tela é `decidirBinding` lhe
 * passando o que a escada decidiu. Reprova nos dois sentidos — a tela
 * anunciando coisa diferente do motor, e alguém voltando a GRAVAR um provider
 * no ponto (registro) ou a decidir sozinho na rota.
 */
// A escada lê os TRANSCRIPTION_* pela régua `env` (`lib/env.ts`), a mesma da
// guarda de destino do worker (#855/#964). Travá-los vazios aqui é o que faz o
// teste medir o código, e não o `.env.local` da máquina onde roda.
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDeEnv>();
  return {
    env: {
      ...real.env,
      TRANSCRIPTION_API_KEY: "",
      TRANSCRIPTION_MODEL: "",
      TRANSCRIPTION_BASE_URL: "",
      TRANSCRIPTION_LANGUAGES: "",
    },
  };
});

/** A organização da #2190: Gemini com chave do Google, sem conta OpenAI. */
const ORG_GEMINI = { provider: "google", defaultModel: "gemini-3.5-flash" } as const;
const PADRAO_ANTHROPIC = { provider: "anthropic", defaultModel: "claude-sonnet-5" } as const;

const GEMINI = {
  provider: "google",
  apiKey: "chave-google-de-controle",
  modelId: "gemini-3.5-flash",
} as const;

/** O motor, com o mesmo formato de entrada que o worker passa. */
const comChaveOpenai = () =>
  decidirTranscricao({ conversa: GEMINI, chaveOpenai: async () => "chave-openai-de-controle" });

/** O que a TELA anuncia no ponto, dados os mesmos dados que o motor tem. */
function tela(
  escada: DecisaoDeTranscricao | null | undefined,
  padrao: { provider: string; defaultModel: string | null } = ORG_GEMINI,
) {
  return decidirBinding({
    pontoId: "transcricao_de_audio",
    binding: null,
    agentePublicado: null,
    modeloDeAmbiente: undefined,
    padraoDaOrganizacao: padrao,
    transcricao: escada,
  });
}

describe("a tela e o motor concordam sobre quem OUVE o áudio", () => {
  it("org SEM chave OpenAI e modelo de conversa com audio → a tela anuncia o MODELO DA ORG", async () => {
    const escada = await decidirTranscricao({
      conversa: GEMINI,
      chaveOpenai: async () => null,
    });

    // Sem este controle o caso abaixo não mediria nada: é preciso que o motor
    // tenha caído no degrau da organização, que é o defeito da issue.
    expect(escada.origem, "o motor não escolheu o degrau da organização").toBe(
      "modelo_da_organizacao",
    );

    const d = tela(escada);
    expect(d.modelId, "a tela voltou a anunciar whisper-1").not.toBe("whisper-1");
    expect(d.provider, "a tela anunciou o provedor errado").toBe(escada.anuncio.provider);
    expect(d.modelId, "a tela divergiu do motor").toBe(escada.anuncio.modelId);
    expect(d.modelId).toBe("gemini-3.5-flash");
  });

  it("org COM chave OpenAI → a tela continua anunciando whisper-1 (ninguém troca de fornecedor)", async () => {
    // Controle: apagar o whisper-1 de vez também seria mentira — para quem tem
    // chave OpenAI, o degrau OpenAI é o que roda, e sempre foi.
    const escada = await comChaveOpenai();
    expect(escada.origem).toBe("padrao_openai_compativel");
    const d = tela(escada);
    expect(d.modelId).toBe("whisper-1");
    expect(d.modelId).toBe(escada.anuncio.modelId);
  });

  it("sem ninguém que transcreva → a tela não anuncia modelo nenhum, e dá o motivo", async () => {
    // Modelo de conversa SEM capacidade `audio` e sem chave OpenAI: a escada
    // devolve `nada` com motivo, e a tela não pode prometer whisper-1 nem o
    // modelo de conversa que não vai ser chamado.
    const escada = await decidirTranscricao({
      conversa: { provider: "anthropic", apiKey: "chave-anthropic-de-controle", modelId: "claude-sonnet-5" },
      chaveOpenai: async () => null,
    });
    expect(escada.origem).toBe("nada");

    const d = tela(escada, PADRAO_ANTHROPIC);
    expect(d.modelId, "a tela prometeu um caminho que ninguém vai usar").toBeNull();
    expect(d.modelId).not.toBe("whisper-1");
    expect(d.modelId).not.toBe("claude-sonnet-5");
    expect(d.motivo ?? "", "sem o motivo da escada o operador vê '—' e não sabe o que fazer").toMatch(/\S/);
  });

  it("sem a escada na entrada, o resolvedor não ganha whisper-1 de presente", async () => {
    // É a forma de reprovar a VOLTA do `usa: { provider: "openai", ... }` no
    // registro: quem chama o resolvedor sem ter decidido a escada não tem o
    // que anunciar, e "—" é a única resposta honesta.
    const d = tela(null);
    expect(d.modelId).toBeNull();
    expect(d.modelId, "o ponto voltou a fixar provider/modelo próprio").not.toBe("whisper-1");
  });

  it("a rota alimenta a escada, e o registro parou de fixar um provider", async () => {
    // Varredura de fonte (mesmo padrão do bloco do roteador, mais abaixo): o
    // caso acima provaria a FUNÇÃO, e o conserto mora no call site — é numa
    // linha da rota e numa linha do registro que a mentira volta a morar.
    const ler = async (p: string) => (await import("node:fs")).readFileSync(p, "utf8");

    const rota = await ler("app/api/v1/ai/providers/route.ts");
    expect(rota, "a rota deixou de decidir a transcrição pela escada").toMatch(/decidirTranscricao\(/);
    expect(
      rota,
      "a rota voltou a anunciar o degrau OpenAI por conta própria, como se fosse o único caminho",
    ).not.toMatch(/modeloDeTranscricaoEmVigor/);

    const registro = await ler("lib/ai/pontos/registro.ts");
    const ponto = registro.slice(
      registro.indexOf('id: "transcricao_de_audio"'),
      registro.indexOf('id: "visao_de_imagem"'),
    );
    expect(ponto, "o recorte do ponto saiu vazio").toContain("transcricao_de_audio");
    expect(ponto, "o ponto deixou de declarar que quem decide é a escada").toMatch(
      /escada:\s*"transcricao"/,
    );
    expect(ponto, "o ponto voltou a fixar um provider/modelo próprio").not.toMatch(/\busa:/);
  });
});

describe("ponto FIXO anuncia o que ele mesmo usa", () => {
  it("o ponto fixo ignora até um binding salvo — a escada do painel não se aplica", async () => {
    // Controle: alguém pode ter um binding antigo gravado para este ponto. Ele
    // não pode ressuscitar o comportamento errado nem atropelar a escada.
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
      transcricao: await comChaveOpenai(),
    });
    expect(d.modelId).toBe("whisper-1");
    expect(d.modelId, "a escolha do painel entrou no ponto fixo").not.toBe("gpt-5.6-sol");
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
    // Os TRÊS call sites: catálogo de modelos e lista do GET, além da validação do PUT.
    expect(
      (fonte.match(/enxergaImagem\(\{/g) ?? []).length,
      "um dos dois call sites da rota voltou a ler a coluna direto",
    ).toBe(3);
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

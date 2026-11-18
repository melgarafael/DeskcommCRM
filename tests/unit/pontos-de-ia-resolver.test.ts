/**
 * A PRECEDÊNCIA — o teste que guarda a ORDEM, não os caminhos.
 *
 * Testar que cada uma das quatro origens funciona sozinha não prova nada sobre
 * qual vence quando duas aparecem juntas, e é a ordem que produz o bug caro: o
 * operador muda a configuração numa tela e o comportamento não muda, porque
 * outra origem estava vencendo em silêncio. Por isso quase todo caso abaixo
 * liga DUAS origens ao mesmo tempo e afirma quem ganhou.
 *
 * O segundo eixo é o do PR #151: modelo e credencial vêm sempre do MESMO
 * lugar. Um teste que só olhasse `modelId` passaria com a credencial errada
 * viajando junto — que foi exatamente o defeito que matou turnos em produção.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decidirBinding,
  EXPLICACAO_DA_ORIGEM,
  PONTOS_DO_AGENTE_COM_ESCOLHA_NO_PAINEL,
  PONTOS_DO_AGENTE_PUBLICADO,
  PONTOS_QUE_HERDAM_DO_AGENTE,
  type AgentePublicado,
  type EntradaDaDecisao,
  type OrigemDaEscolha,
  type LinhaDeBinding,
} from "@/lib/ai/pontos/resolver";

const PADRAO = { provider: "anthropic", defaultModel: "claude-sonnet-5" };

const binding = (over: Partial<LinhaDeBinding> = {}): LinhaDeBinding => ({
  purpose: "stage_classifier",
  provider: "openrouter",
  credential_id: "cred-openrouter",
  model_id: "meta-llama/llama-3.3-70b-instruct",
  base_url: null,
  is_enabled: true,
  ...over,
});

const agente = (over: Partial<AgentePublicado> = {}): AgentePublicado => ({
  provider: "openai",
  credentialId: "cred-openai",
  model: "gpt-5-mini",
  ...over,
});

const entrada = (over: Partial<EntradaDaDecisao> = {}): EntradaDaDecisao => ({
  pontoId: "stage_classifier",
  binding: null,
  agentePublicado: null,
  modeloDeAmbiente: undefined,
  padraoDaOrganizacao: PADRAO,
  ...over,
});

describe("precedência entre origens", () => {
  it("binding vence variável de ambiente", () => {
    const d = decidirBinding(
      entrada({ binding: binding(), modeloDeAmbiente: "claude-haiku-4-5" }),
    );
    expect(d.origem).toBe("binding");
    expect(d.modelId).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  it("binding vence padrão da organização", () => {
    const d = decidirBinding(entrada({ binding: binding() }));
    expect(d.origem).toBe("binding");
    expect(d.provider).toBe("openrouter");
  });

  it("variável de ambiente vence padrão da organização", () => {
    const d = decidirBinding(entrada({ modeloDeAmbiente: "claude-haiku-4-5" }));
    expect(d.origem).toBe("variavel_de_ambiente");
    expect(d.modelId).toBe("claude-haiku-4-5");
  });

  it("agente publicado vence binding nos pontos que SÃO o agente", () => {
    const d = decidirBinding(
      entrada({
        pontoId: "agent_turn",
        binding: binding({ purpose: "agent_turn" }),
        agentePublicado: agente(),
      }),
    );
    expect(d.origem).toBe("agente_publicado");
    expect(d.modelId).toBe("gpt-5-mini");
    expect(d.provider).toBe("openai");
  });

  it("agente publicado NÃO vence binding nos demais pontos", () => {
    // A recíproca do caso acima. Sem ela, bastaria "agente sempre ganha" para
    // os dois testes passarem — e o painel não controlaria mais nada.
    const d = decidirBinding(
      entrada({ binding: binding(), agentePublicado: agente() }),
    );
    expect(d.origem).toBe("binding");
    expect(d.provider).toBe("openrouter");
  });

  it("binding desligado devolve o lugar para quem vem depois", () => {
    const d = decidirBinding(
      entrada({
        binding: binding({ is_enabled: false }),
        modeloDeAmbiente: "claude-haiku-4-5",
      }),
    );
    expect(d.origem).toBe("variavel_de_ambiente");
    expect(d.modelId).toBe("claude-haiku-4-5");
  });

  it("sem nenhuma origem, cai no padrão da organização", () => {
    const d = decidirBinding(entrada());
    expect(d.origem).toBe("padrao_da_organizacao");
    expect(d.modelId).toBe("claude-sonnet-5");
    expect(d.provider).toBe("anthropic");
  });
});

describe("modelo e credencial vêm do MESMO lugar (PR #151)", () => {
  it("o binding leva provider, credencial e modelo juntos", () => {
    const d = decidirBinding(entrada({ binding: binding() }));
    expect(d).toMatchObject({
      provider: "openrouter",
      credentialId: "cred-openrouter",
      modelId: "meta-llama/llama-3.3-70b-instruct",
    });
  });

  it("o agente publicado leva provider e credencial junto com o modelo", () => {
    // O defeito original: emprestava só a string do modelo, e provider e
    // credencial continuavam no padrão da org — `gpt-5-mini` ia para o
    // endpoint da Anthropic e o turno inteiro morria.
    const d = decidirBinding(
      entrada({ pontoId: "agent_turn", agentePublicado: agente() }),
    );
    expect(d.provider).toBe("openai");
    expect(d.credentialId).toBe("cred-openai");
    expect(d.provider).not.toBe(PADRAO.provider);
  });

  it("a variável de ambiente NÃO carrega credencial de outro provider", () => {
    // O knob nasceu quando só havia um provider por instalação; ele pressupõe
    // o padrão da org. Deixá-lo herdar credencial de um binding vizinho
    // recriaria o cruzamento que o PR #151 consertou.
    const d = decidirBinding(entrada({ modeloDeAmbiente: "claude-haiku-4-5" }));
    expect(d.provider).toBe(PADRAO.provider);
    expect(d.credentialId).toBeNull();
  });

  it("binding DESLIGADO não vaza credencial para a variável de ambiente", () => {
    // O caso acima passa com `binding: null`, então não pega uma implementação
    // que lesse `entrada.binding?.credential_id` ao montar o ramo do env — a
    // linha continua na entrada, só que desligada. É o cenário real de quem
    // desliga o binding no painel e volta a depender do .env: a credencial
    // errada viajaria com o modelo certo, que é a forma exata do PR #151.
    const d = decidirBinding(
      entrada({
        binding: binding({ is_enabled: false }),
        modeloDeAmbiente: "claude-haiku-4-5",
      }),
    );
    expect(d.origem).toBe("variavel_de_ambiente");
    expect(d.credentialId).toBeNull();
    expect(d.provider).toBe(PADRAO.provider);
    expect(d.baseUrl).toBeNull();
  });

  it("binding DESLIGADO não vaza credencial para o padrão da organização", () => {
    const d = decidirBinding(entrada({ binding: binding({ is_enabled: false }) }));
    expect(d.origem).toBe("padrao_da_organizacao");
    expect(d.credentialId).toBeNull();
    expect(d.baseUrl).toBeNull();
  });
});

describe("a decisão explica a si mesma", () => {
  it("toda origem possível tem explicação escrita para o usuário", () => {
    // A lista sai do FONTE, não de um array copiado aqui. Ela era fixa com
    // quatro nomes, e uma lista fixa não sabe quando o union cresce: a origem
    // `herdado_de_quem_chamou` nasceu depois e este gate teria ficado verde sem
    // olhar para ela. `Record<OrigemDaEscolha, string>` obriga a ENTRADA a
    // existir em compile time; o que só o runtime vê é se o texto está vazio —
    // e é exatamente isso que aqui se mede, sobre TODOS os membros.
    const fonte = readFileSync(
      join(process.cwd(), "lib/ai/pontos/resolver.ts"),
      "utf-8",
    );
    const union = /export type OrigemDaEscolha =([^;]+);/.exec(fonte)?.[1] ?? "";
    const origens = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as OrigemDaEscolha);

    expect(origens.length).toBeGreaterThanOrEqual(5);
    for (const o of origens) {
      expect(EXPLICACAO_DA_ORIGEM[o]?.trim().length ?? 0, `origem sem explicação: ${o}`).toBeGreaterThan(0);
    }
  });

  it("avisa quando o painel está sobrepondo uma variável de ambiente", () => {
    // Sem este aviso, quem instalou com o knob no .env vê a tela mostrar outro
    // valor e não entende qual está valendo — a dúvida original, de volta.
    const d = decidirBinding(
      entrada({ binding: binding(), modeloDeAmbiente: "claude-haiku-4-5" }),
    );
    expect(d.avisos.join(" ")).toContain("claude-haiku-4-5");
  });

  it("avisa quando o binding não se aplica por ser ponto do agente", () => {
    const d = decidirBinding(
      entrada({
        pontoId: "operator_turn",
        binding: binding({ purpose: "operator_turn" }),
        agentePublicado: agente(),
      }),
    );
    expect(d.avisos).toHaveLength(1);
    expect(d.avisos[0]).toContain("versão publicada do agente");
  });

  it("não inventa aviso quando não há conflito", () => {
    // Aviso que aparece sempre é aviso que ninguém lê. Se todo caso trouxesse
    // texto, os dois testes acima passariam sem o resolvedor decidir nada.
    expect(decidirBinding(entrada({ binding: binding() })).avisos).toEqual([]);
    expect(decidirBinding(entrada()).avisos).toEqual([]);
  });
});

describe("aviso de capacidade que não precisa de catálogo", () => {
  it("aponta modelo que não é de embedding num ponto de embedding", () => {
    const d = decidirBinding(
      entrada({
        pontoId: "embedding_consultar",
        binding: binding({ purpose: "embedding_consultar", model_id: "claude-sonnet-5" }),
      }),
    );
    expect(d.avisos.join(" ")).toContain("modelo de embedding");
  });

  it("aceita modelo de embedding sem reclamar", () => {
    const d = decidirBinding(
      entrada({
        pontoId: "embedding_consultar",
        binding: binding({
          purpose: "embedding_consultar",
          model_id: "openai/text-embedding-3-small",
        }),
      }),
    );
    expect(d.avisos).toEqual([]);
  });

  it("não reclama de modelo de conversa em ponto de conversa", () => {
    const d = decidirBinding(
      entrada({ binding: binding({ model_id: "claude-sonnet-5" }) }),
    );
    expect(d.avisos).toEqual([]);
  });
});

describe("o conjunto de pontos do agente publicado", () => {
  it("contém os dois turnos do agente e o preview que usa a mesma versão", () => {
    // Preview precisa reproduzir provider/modelo/credencial da versão testada,
    // sem permitir que o binding do painel troque o agente durante a revisão.
    // O conjunto continua exato: outros pontos permanecem sob o painel.
    expect([...PONTOS_DO_AGENTE_PUBLICADO].sort()).toEqual([
      "agent_preview",
      "agent_turn",
      "operator_turn",
    ]);
  });

  it("preview conserva modelo, provider e credencial da versão apesar do binding e do ambiente", () => {
    const d = decidirBinding(entrada({
      pontoId: "agent_preview",
      binding: binding({ purpose: "agent_preview" }),
      agentePublicado: agente(),
      modeloDeAmbiente: "claude-haiku-4-5",
    }));
    expect(d).toMatchObject({
      origem: "agente_publicado",
      provider: "openai",
      modelId: "gpt-5-mini",
      credentialId: "cred-openai",
      baseUrl: null,
    });
    expect(d.provider).not.toBe(PADRAO.provider);
    expect(d.provider).not.toBe("openrouter");
    expect(d.credentialId).not.toBe("cred-openrouter");
  });

  it.each(["agent_turn", "operator_turn", "agent_preview"])("sem agente publicado, %s cai para as origens seguintes", (pontoId) => {
    // Organização que ainda não publicou agente nenhum não pode ficar sem
    // resolução — seria o agente mudo do dia da instalação.
    const d = decidirBinding(
      entrada({ pontoId, binding: binding({ purpose: pontoId }) }),
    );
    expect(d.origem).toBe("binding");
  });
});

/**
 * O FOLLOW-UP: o agente escrevendo sozinho, com o modelo escolhível no painel.
 *
 * É o mesmo turno de `agent_turn` (mesma versão publicada, mesmas ferramentas),
 * mas a ordem é a inversa: binding habilitado → versão publicada. Medido numa
 * instalação real, os follow-ups eram 31% do gasto do agente; um modelo barato
 * escreve bem a retomada e não opera o CRM — por isso a troca é só aqui.
 *
 * O caso que mais importa é o SEM escolha: ele tem de devolver exatamente o que
 * o turno usava antes de o ponto existir — o modelo, o provider, a credencial e
 * a ORIGEM (`agente_publicado`, que vai para `llm_calls.origem_da_escolha`).
 */
describe("followup_turn — binding do painel, senão a versão publicada", () => {
  const seguimento = (over: Partial<LinhaDeBinding> = {}) =>
    binding({ purpose: "followup_turn", provider: "openai", credential_id: "cred-barata", model_id: "gpt-5.6-luna", ...over });
  const agenteSonnet = () => agente({ provider: "anthropic", credentialId: "cred-anthropic", model: "claude-sonnet-5" });

  it("com binding habilitado: o modelo do painel, com provider e credencial dele", () => {
    const d = decidirBinding(entrada({ pontoId: "followup_turn", binding: seguimento(), agentePublicado: agenteSonnet() }));
    expect(d).toMatchObject({
      origem: "binding",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      credentialId: "cred-barata",
      baseUrl: null,
    });
    // E sem o aviso de "a escolha do painel não se aplica" — aqui ela se aplica.
    expect(d.avisos).toEqual([]);
  });

  it("sem binding: a versão publicada INTEIRA, com a origem de sempre", () => {
    const d = decidirBinding(entrada({ pontoId: "followup_turn", agentePublicado: agenteSonnet() }));
    expect(d).toMatchObject({
      origem: "agente_publicado",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      credentialId: "cred-anthropic",
      baseUrl: null,
    });
  });

  it("sem binding, decide IGUAL a `agent_turn` — o comportamento de antes do ponto", () => {
    // A régua de "nada muda sem escolha": a mesma entrada nos dois pontos dá a
    // mesma decisão, campo por campo.
    const base = { agentePublicado: agenteSonnet(), modeloDeAmbiente: "claude-haiku-4-5" };
    expect(decidirBinding(entrada({ pontoId: "followup_turn", ...base }))).toEqual(
      decidirBinding(entrada({ pontoId: "agent_turn", ...base })),
    );
  });

  it("binding DESLIGADO devolve o lugar à versão publicada, sem vazar a credencial dele", () => {
    const d = decidirBinding(
      entrada({ pontoId: "followup_turn", binding: seguimento({ is_enabled: false }), agentePublicado: agenteSonnet() }),
    );
    expect(d).toMatchObject({ origem: "agente_publicado", provider: "anthropic", modelId: "claude-sonnet-5" });
    expect(d.credentialId).toBe("cred-anthropic");
    expect(d.baseUrl).toBeNull();
  });

  it("o mesmo binding NÃO alcança `agent_turn` — a resposta ao cliente segue na versão publicada", () => {
    // A recíproca que separa os dois pontos. Sem ela, "o binding sempre ganha"
    // passaria em tudo acima — e trocaria o modelo de quem opera o CRM.
    const d = decidirBinding(
      entrada({ pontoId: "agent_turn", binding: seguimento({ purpose: "agent_turn" }), agentePublicado: agenteSonnet() }),
    );
    expect(d).toMatchObject({ origem: "agente_publicado", modelId: "claude-sonnet-5", provider: "anthropic" });
  });

  it("versão publicada sem modelo: o padrão da organização inteiro, nunca o provider do agente com o modelo da org", () => {
    const d = decidirBinding(
      entrada({ pontoId: "followup_turn", agentePublicado: agente({ model: undefined }) }),
    );
    expect(d).toMatchObject({ origem: "padrao_da_organizacao", provider: PADRAO.provider, modelId: PADRAO.defaultModel, credentialId: null });
  });

  it("sem agente publicado: o painel, senão o padrão — o mesmo que `agent_turn` faz", () => {
    expect(decidirBinding(entrada({ pontoId: "followup_turn", binding: seguimento() })).origem).toBe("binding");
    expect(decidirBinding(entrada({ pontoId: "followup_turn" })).origem).toBe("padrao_da_organizacao");
  });

  it("o conjunto é exato e não se mistura com os outros dois", () => {
    // Um ponto em dois conjuntos teria duas ordens de precedência — e quem
    // ganha dependeria da ordem dos `if`, não de uma decisão escrita.
    expect([...PONTOS_DO_AGENTE_COM_ESCOLHA_NO_PAINEL]).toEqual(["followup_turn"]);
    for (const p of PONTOS_DO_AGENTE_COM_ESCOLHA_NO_PAINEL) {
      expect(PONTOS_DO_AGENTE_PUBLICADO.has(p), `${p} também é ponto travado no agente`).toBe(false);
      expect(PONTOS_QUE_HERDAM_DO_AGENTE.has(p), `${p} também é ponto auxiliar`).toBe(false);
    }
  });
});

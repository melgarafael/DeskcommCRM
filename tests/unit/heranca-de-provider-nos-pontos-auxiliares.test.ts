/**
 * O PONTO AUXILIAR HERDA O PROVIDER **E** O MODELO — ou não herda nada.
 *
 * ## O defeito, medido em produção (VPS HostGator, 2026-08-25)
 *
 * Organização com `settings.llm = {provider: 'anthropic', default_model:
 * 'claude-sonnet-4-5'}` e um agente publicado em OpenAI (`gpt-5.6-luna`). Toda
 * mensagem de WhatsApp morria assim, e o cliente nunca recebia resposta:
 *
 *     llm: chamada falhou
 *       purpose: stage_classifier   provider: openai
 *       model: claude-sonnet-4-5    origem_da_escolha: padrao_da_organizacao
 *       error: The requested model 'claude-sonnet-4-5' does not exist. (400)
 *
 * Provider de um lugar, modelo de outro. É a forma EXATA do PR #151, que
 * `aux-model-args.ts` existe para impedir — reintroduzida um degrau abaixo,
 * pelo resolvedor de precedência:
 *
 *  - `runModelCall` resolve a config da org JÁ COM o override do agente, então
 *    `padraoDaOrganizacao.provider` deixa de ser o padrão da organização e
 *    passa a ser o provider do agente;
 *  - `decidirParaOSeam` zera `modeloDeAmbiente` quando há override, apostando
 *    que o modelo viaja em `agentePublicado.model`;
 *  - mas `decidirBinding` só consome `agentePublicado` nos DOIS pontos que SÃO
 *    o agente (`agent_turn`, `operator_turn`). Nos auxiliares ele é ignorado.
 *
 * Resultado: o modelo do agente é descartado, o provider dele sobrevive, e o
 * ponto auxiliar sai com o modelo do padrão da org no endpoint do agente.
 *
 * ## Por que estes testes e não outros
 *
 * `pontos-de-ia-resolver.test.ts` já guarda a herança para `agent_turn`. O
 * buraco era a recíproca — o mesmo agente num ponto que NÃO é o agente — e é
 * ela que este arquivo fixa, nos dois níveis: a decisão pura e o argumento que
 * chega à FÁBRICA de modelo (onde a escolha vira chamada de verdade).
 */
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  decidirBinding,
  PONTOS_DO_AGENTE_PUBLICADO,
  PONTOS_QUE_HERDAM_DO_AGENTE,
  type AgentePublicado,
  type EntradaDaDecisao,
} from "@/lib/ai/pontos/resolver";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const PADRAO = { provider: "anthropic", defaultModel: "claude-sonnet-4-5" };

const agente = (over: Partial<AgentePublicado> = {}): AgentePublicado => ({
  provider: "openai",
  credentialId: "cred-openai",
  model: "gpt-5.6-luna",
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

/**
 * Os pontos que recebem `llmOverride` do agente publicado em runtime
 * (`argsAux` em `inbound-turn.ts`) mais o `checkpoint`, que passa o mesmo par
 * direto. Se um ponto entrar ou sair dessa lista no motor, este array é o lugar
 * onde a mudança precisa aparecer.
 */
const PONTOS_AUXILIARES = [
  "stage_classifier",
  "jailbreak_detect",
  "promise_semantic",
  "compaction",
  "flush",
  "checkpoint",
  "draft_suggestion",
  "automation_ai_message",
] as const;

describe("o ponto auxiliar não cruza provider de um com modelo de outro", () => {
  for (const ponto of PONTOS_AUXILIARES) {
    it(`${ponto}: herda provider, credencial E modelo do agente publicado`, () => {
      const d = decidirBinding(entrada({ pontoId: ponto, agentePublicado: agente() }));

      // O que quebrou em produção: o modelo do PADRÃO com o provider do AGENTE.
      expect(d.modelId).not.toBe(PADRAO.defaultModel);
      expect(d).toMatchObject({
        provider: "openai",
        credentialId: "cred-openai",
        modelId: "gpt-5.6-luna",
      });
    });
  }

  it("sem agente publicado, o padrão da organização segue valendo inteiro", () => {
    // A recíproca. Sem ela, "o agente sempre ganha" passaria em tudo acima e o
    // padrão da org deixaria de existir para quem não publicou agente nenhum.
    const d = decidirBinding(entrada());
    expect(d.origem).toBe("padrao_da_organizacao");
    expect(d).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5", credentialId: null });
  });

  it("o binding do painel continua vencendo a herança do agente", () => {
    // A precedência declarada não pode ser invertida pelo conserto: quem
    // escolheu no painel escolheu depois, e é a superfície que o operador vê.
    const d = decidirBinding(
      entrada({
        agentePublicado: agente(),
        binding: {
          purpose: "stage_classifier",
          provider: "openrouter",
          credential_id: "cred-openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct",
          base_url: null,
          is_enabled: true,
        },
      }),
    );
    expect(d.origem).toBe("binding");
    expect(d.provider).toBe("openrouter");
  });

  it("a variável de ambiente continua vencendo a herança do agente", () => {
    // `aux-model-args.ts` só empresta o modelo do agente quando o knob está
    // VAZIO — knob preenchido é escolha consciente do operador. O resolvedor
    // precisa respeitar a mesma ordem, senão as duas metades da regra brigam.
    const d = decidirBinding(
      entrada({ agentePublicado: agente(), modeloDeAmbiente: "claude-haiku-4-5" }),
    );
    expect(d.origem).toBe("variavel_de_ambiente");
    expect(d.modelId).toBe("claude-haiku-4-5");
    expect(d.provider).toBe(PADRAO.provider);
  });
});

/**
 * O nível de baixo: a decisão pura pode estar certa e o seam ainda instanciar
 * outro modelo. O ponto de verdade é o argumento que chega à fábrica.
 */
function poolFalso() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return { rows: [{ llm: { provider: "anthropic", default_model: "claude-sonnet-4-5" } }] };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { query } as never;
}

function registrySpiao() {
  const chamadas: Array<{ provider: string; apiKey: string; modelId: string }> = [];
  const fabrica = (provider: string) => (apiKey: string, modelId: string) => {
    chamadas.push({ provider, apiKey, modelId });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: "vendas" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    } as never;
  };
  return { chamadas, registry: { anthropic: fabrica("anthropic"), openai: fabrica("openai") } };
}

describe("o seam instancia o modelo do agente, não o do padrão da org", () => {
  it.each(["stage_classifier", "flush", "agent_preview"])("%s: a fábrica recebe o par íntegro do agente", async purpose => {
    const { registry, chamadas } = registrySpiao();

    const r = await runModelCall(
      poolFalso(),
      { anthropicApiKey: "chave-anthropic", openaiApiKey: "chave-openai", cacheTtl: "1h" as const },
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        purpose,
        // Exatamente o que `auxModelArgs` monta com o knob de env vazio.
        model: "gpt-5.6-luna",
        llmOverride: { provider: "openai", credentialId: null },
        messages: [{ role: "user", content: "oi" }],
      },
      { registry },
    );

    expect(chamadas).toHaveLength(1);
    // A linha do log de produção era `provider: openai, model: claude-sonnet-4-5`.
    expect(chamadas[0]).toMatchObject({ provider: "openai", modelId: "gpt-5.6-luna" });
    // E a chave tem de ser a do provider instanciado — o outro meio do PR #151.
    expect(chamadas[0]?.apiKey).toBe("chave-openai");
    expect(r.origem).not.toBe("padrao_da_organizacao");
  });
});

/**
 * A GUARDA DE CLASSE — para o próximo call site não repetir o mesmo erro.
 *
 * Consertar as instâncias que existem hoje não impede a de amanhã: `operator_turn`
 * ficou três frentes inteiras mandando o modelo do agente para o endpoint da
 * organização porque nenhum teste perguntava se ELE também passava o par junto.
 * Esta varredura pergunta, do código, em todo call site de uma vez.
 *
 * O eixo é o objeto literal passado a `runModelCall`: se ele empresta o modelo
 * do agente publicado (`model: agentConfig.…` / `agent.…`), tem de emprestar
 * `llmOverride` no MESMO objeto. Ler o objeto balanceado, e não o arquivo,
 * é o que separa `compaction` (empresta) de `flush` (não empresta) — os dois
 * moram em `compaction.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Read the actual object owning purpose; braces in prompts cannot alter its boundary. */
function objetosComPurpose(fonte: string) {
  const ast = ts.createSourceFile("source.ts", fonte, ts.ScriptTarget.Latest, true);
  const out: Array<{ purpose: string; objeto: string }> = [];
  const literals = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literals(node.expression);
    return [];
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast).replace(/["']/g, "") === "purpose" && ts.isObjectLiteralExpression(node.parent)) {
      for (const purpose of literals(node.initializer)) out.push({ purpose, objeto: node.parent.getText(ast) });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

function arquivosDoMotor(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosDoMotor(caminho);
    return nome.endsWith(".ts") && !nome.includes(".test.") ? [caminho] : [];
  });
}

/**
 * O ponto herda do ROTEADOR de intenção, não do agente publicado — o provider
 * vem de `router.classifierProvider`. Ele passa no eixo do PR #151 (modelo e
 * provider juntos) e por isso está fora de `PONTOS_QUE_HERDAM_DO_AGENTE`, que
 * é o que a TELA usa para dizer de quem herdou.
 */
const HERDAM_DE_OUTRA_FONTE = new Set(["intent_router"]);

describe("nenhum call site empresta o modelo do agente sem o provider dele", () => {
  const objetosPorPurpose = (() => {
    const mapa = new Map<string, { arquivo: string; objeto: string }[]>();
    for (const arquivo of arquivosDoMotor(join(process.cwd(), "lib/agent-engine"))) {
      const fonte = readFileSync(arquivo, "utf-8");
      for (const { purpose, objeto } of objetosComPurpose(fonte)) {
        const lista = mapa.get(purpose) ?? [];
        lista.push({ arquivo, objeto });
        mapa.set(purpose, lista);
      }
    }
    return mapa;
  })();

  it("instrumento preserva ramos condicionais e detecta provider ausente no objeto certo", () => {
    const fonte = `const a = { purpose: preview ? 'agent_preview' : 'agent_turn', model: agentConfig.model }; const b = { purpose: 'checkpoint', llmOverride: {} };`;
    const rows = objetosComPurpose(fonte);
    expect(rows.map(r => r.purpose)).toEqual(["agent_preview", "agent_turn", "checkpoint"]);
    const semProvider = rows.filter(r => /model:\s*(agentConfig|agent)\./.test(r.objeto) && !r.objeto.includes("llmOverride"));
    expect(semProvider.map(r => r.purpose)).toEqual(["agent_preview", "agent_turn"]);
    expect(objetosComPurpose(`// purpose: 'fantasma'\ntype T = { purpose: 'tipo' };`)).toEqual([]);
  });

  it("a varredura enxerga o motor — controle positivo", () => {
    // Sem isto, uma varredura que não achasse arquivo nenhum passaria em tudo
    // abaixo por vacuidade: instrumento quebrado devolve zero e não avisa.
    expect(objetosPorPurpose.size).toBeGreaterThanOrEqual(10);
    expect(objetosPorPurpose.has("agent_turn")).toBe(true);
    expect(objetosPorPurpose.has("operator_turn")).toBe(true);
  });

  it("quem passa o modelo do agente passa o llmOverride no mesmo objeto", () => {
    const faltando: string[] = [];
    for (const [purpose, ocorrencias] of objetosPorPurpose) {
      for (const { arquivo, objeto } of ocorrencias) {
        const emprestaModeloDoAgente = /model:\s*(agentConfig|agent)\./.test(objeto);
        if (emprestaModeloDoAgente && !objeto.includes("llmOverride")) {
          faltando.push(`${purpose} (${arquivo.split("/lib/")[1]})`);
        }
      }
    }
    expect(faltando, `call site empresta o modelo do agente sem o provider: ${faltando.join(", ")}`).toEqual([]);
  });

  it("todo ponto que recebe llmOverride está declarado, ou é herança de outra fonte", () => {
    // O outro sentido: a lista que a TELA lê não pode ficar para trás de um
    // call site novo, senão o painel volta a anunciar o padrão da organização
    // num ponto que em runtime usa o modelo do agente.
    const naoDeclarados: string[] = [];
    for (const [purpose, ocorrencias] of objetosPorPurpose) {
      if (!ocorrencias.some(({ objeto }) => objeto.includes("llmOverride"))) continue;
      if (PONTOS_DO_AGENTE_PUBLICADO.has(purpose)) continue;
      if (HERDAM_DE_OUTRA_FONTE.has(purpose)) continue;
      if (!PONTOS_QUE_HERDAM_DO_AGENTE.has(purpose)) naoDeclarados.push(purpose);
    }
    expect(
      naoDeclarados,
      `ponto herda do agente mas não está em PONTOS_QUE_HERDAM_DO_AGENTE: ${naoDeclarados.join(", ")}`,
    ).toEqual([]);
  });

  it("a lista não guarda ponto que nenhum call site herda", () => {
    // A recíproca: ponto declarado e nunca herdado faria a tela anunciar
    // herança que não acontece — a mesma mentira, do avesso.
    const orfaos = [...PONTOS_QUE_HERDAM_DO_AGENTE].filter(
      (p) => !(objetosPorPurpose.get(p) ?? []).some(({ objeto }) => objeto.includes("llmOverride")),
    );
    expect(orfaos, `declarado mas nenhum call site herda: ${orfaos.join(", ")}`).toEqual([]);
  });
});

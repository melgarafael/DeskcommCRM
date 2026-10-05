/**
 * O CLASSIFICADOR DO ROTEADOR NASCE "AUTOMÁTICO" — E NUNCA COM ID FIXO.
 *
 * `ai_routers.config` semeava `'classifier_model', 'claude-haiku-4-5'`, um id do
 * ANTHROPIC num produto multi-provedor. Medido numa instalação real com a
 * organização na OpenRouter (2026-10-02, `llm_calls`):
 *
 *   provider openrouter · model claude-haiku-4-5 · http_status 400
 *   error_message "claude-haiku-4-5 is not a valid model ID"
 *   origem_da_escolha "variavel_de_ambiente"
 *
 * O id fixo entra pelo PRECEDÊNCIA 3 de `decidirBinding`
 * (`lib/ai/pontos/resolver.ts`): modelo do call site vence o padrão da
 * organização. `classifyIntent` só passa `model` quando o roteador tem um
 * (`intent-classifier.ts:154`), então o default do banco decidia o modelo de uma
 * organização que nunca tinha escolhido Claude — e mandava o id para o endpoint
 * da OpenRouter, onde `claude-haiku-4-5` não existe (lá é
 * `anthropic/claude-haiku-4.5`, com PONTO). Três chamadas 400, o classificador
 * calado, e TODO turno caindo no fallback do roteador.
 *
 * `loadActiveRouter` já tratava `classifier_model` ausente como `null`
 * ("Automático") desde antes desta migration — o que faltava era o DEFAULT não
 * semear a chave. Por isso o gate é sobre o SCHEMA, e o leitor aparece aqui
 * como o contrato que o default tem de cumprir.
 *
 * A régua vale para TODO o schema versionado: o defeito está no default de
 * `create table ai_routers`, que `baseline.sql` e a 0085 compartilham.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";

import type pg from "pg";

/**
 * O id que a OpenRouter não tem. O catálogo público
 * (`GET https://openrouter.ai/api/v1/models`, 464 ids, conferido em 2026-10-02)
 * tem `anthropic/claude-haiku-4.5` — ponto entre 4 e 5. A forma com traço é a do
 * Anthropic nativo, o que faz o default passar despercebido em revisão de
 * catálogo feita contra o proveedor errado.
 */
const ID_INVALIDO_NA_OPENROUTER = "claude-haiku-4-5";

/**
 * Onde o default de `ai_routers.config` é corrigido: a 0530 e o apêndice do
 * baseline — os dois arquivos que o self-host aplica.
 *
 * A migration 0085 NÃO entra aqui, e é de propósito: ela é o dump histórico que
 * semeou o id, é considerada aplicada e não pode ser editada (a correção é sempre
 * uma migration nova). O que vale medir é o default que FICA valendo depois de
 * aplicar tudo, e é isso que `defaultVigente` devolve.
 */
const ARQUIVOS_DO_DEFAULT = [
  join(process.cwd(), "supabase", "baseline.sql"),
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "20261002220137_0530_classificador_do_roteador_automatico.sql",
  ),
];

/**
 * O default que VALE depois de aplicar o arquivo inteiro.
 *
 * `baseline.sql` é dump + apêndice: o `create table` do dump ainda traz o id
 * antigo (e deve continuar trazendo — ele é o estado histórico), e o apêndice da
 * 0530 no fim o substitui. Ler o arquivo com `includes` responderia "o arquivo
 * menciona"; o que vale é a ÚLTIMA definição, a mesma regra de
 * `pg_get_functiondef` para função.
 */
function defaultVigente(sql: string): string | null {
  const todos = [
    ...sql.matchAll(
      /(?:create table (?:if not exists )?(?:public\.)?ai_routers\b[\s\S]*?config jsonb[^,]*?default\s+)(jsonb_build_object\([\s\S]*?\))/gi,
    ),
    ...sql.matchAll(
      /alter table (?:public\.)?ai_routers\s+alter column config set default\s+(jsonb_build_object\([\s\S]*?\));/gi,
    ),
  ];
  if (todos.length === 0) return null;
  const ultima = todos.reduce((a, b) => (b.index! > a.index! ? b : a));
  return ultima[1] ?? null;
}

/**
 * Um `pg.Pool` dublê que devolve cada lote de linhas na ordem em que a consulta
 * chega — o mesmo formato de `poolSeq` em `router-config.test.ts`.
 */
function poolCom(lotes: Array<Array<Record<string, unknown>>>): pg.Pool {
  const query = vi.fn();
  for (const linhas of lotes) query.mockResolvedValueOnce({ rows: linhas });
  return { query } as unknown as pg.Pool;
}

/** `classifyIntent` com `runModelCall` injetado não toca o banco. */
function poolVazio(): pg.Pool {
  return { query: vi.fn() } as unknown as pg.Pool;
}

describe("ai_routers.config — o default efetivo não semeia id de classificador", () => {
  it.each(ARQUIVOS_DO_DEFAULT)("%s: existe um default de config", (arquivo) => {
    expect(defaultVigente(readFileSync(arquivo, "utf8"))).not.toBeNull();
  });

  it.each(ARQUIVOS_DO_DEFAULT)("%s: o default que VALE não traz classifier_model", (arquivo) => {
    // Esta é a régua do defeito: o que o self-host aplica tem de deixar o
    // roteador em "Automático". Ler o arquivo inteiro acusaria o `create table`
    // do dump — que é histórico e não pode ser editado.
    expect(defaultVigente(readFileSync(arquivo, "utf8"))).not.toContain("classifier_model");
  });

  it.each(ARQUIVOS_DO_DEFAULT)("%s: o default que vale não traz o id que a OpenRouter rejeita", (arquivo) => {
    expect(defaultVigente(readFileSync(arquivo, "utf8"))).not.toContain(ID_INVALIDO_NA_OPENROUTER);
  });

  it.each(ARQUIVOS_DO_DEFAULT)("%s: sticky e min_confidence continuam no default", (arquivo) => {
    const vigente = defaultVigente(readFileSync(arquivo, "utf8")) ?? "";
    expect(vigente).toContain("'sticky'");
    expect(vigente).toContain("'min_confidence'");
  });
});

describe("migration 0530 — a cura estreita", () => {
  const sql = () => readFileSync(ARQUIVOS_DO_DEFAULT[1]!, "utf8");
  /** O UPDATE de um arquivo, com espaços normalizados — para comparar os dois. */
  const cura = (texto: string) =>
    (texto.match(/update public\.ai_routers r[\s\S]*?;/)?.[0] ?? "").replace(/\s+/g, " ");

  it("some com a chave em vez de reescrever o config", () => {
    // `config - 'classifier_model'` preserva sticky/min_confidence byte a byte;
    // reescrever com jsonb_build_object perderia o que a pessoa configurou.
    expect(cura(sql())).toContain("set config = r.config - 'classifier_model'");
  });

  it("só alcança o id que a 0085 semeou, sem provedor gravado, fora do Anthropic", () => {
    const c = cura(sql());
    expect(c).toContain("r.config->>'classifier_model' = 'claude-haiku-4-5'");
    expect(c).toContain("coalesce(r.config->>'classifier_provider', '') = ''");
    // A regra de `llmSettingsSchema`: provedor ausente, não-texto ou vazio vale
    // 'anthropic' — e lá o seed funciona (0104).
    expect(c).toContain("jsonb_typeof(o.settings->'llm'->'provider') = 'string'");
    expect(c).toContain("'anthropic') <> 'anthropic'");
  });

  it("não alcança o Haiku da Requesty, que nunca foi seed", () => {
    // `anthropic/claude-haiku-4-5` é modelo válido do catálogo da Requesty
    // (0410), oferecido pela tela com `classifier_provider = 'requesty'`.
    expect(cura(sql())).not.toContain("anthropic/claude-haiku-4-5");
  });

  it("migration e apêndice do baseline têm a MESMA cura", () => {
    // O invariante executa a do apêndice; esta régua amarra a da migration a ela.
    const doBaseline = readFileSync(ARQUIVOS_DO_DEFAULT[0]!, "utf8");
    const bloco = doBaseline.slice(
      doBaseline.indexOf('-- ---- classificador do roteador nasce "Automático" (migration 0530) ----'),
    );
    expect(cura(bloco)).not.toBe("");
    expect(cura(bloco)).toBe(cura(sql()));
  });

  it("é idempotente: um único `set default`", () => {
    expect(sql().match(/alter column config set default/g) ?? []).toHaveLength(1);
  });
});

describe("loadActiveRouter — o contrato que o default tem de cumprir", () => {
  it("roteador sem classifier_model carrega null (o seam decide)", async () => {
    // É a linha que o default novo produz: `{'sticky': true, 'min_confidence': 0.6}`.
    const router = await loadActiveRouter(
      poolCom([
        [{ id: "r1", name: "Roteador Hubiss", config: { sticky: true, min_confidence: 0.6 }, fallback_agent_id: null }],
        [],
      ]),
      "org1",
      "cs1",
    );
    expect(router?.classifierModel).toBeNull();
    expect(router?.sticky).toBe(true);
    expect(router?.minConfidence).toBe(0.6);
  });

  it("modelo escolhido de propósito continua valendo", async () => {
    // A cura da migration é estreita e o leitor é o mesmo: quem escolheu um
    // modelo continua com ele. Nem aqui o leitor pode "limpar tudo que é
    // Claude" — no Anthropic nativo o alias `claude-haiku-4-5` resolve (0104).
    const router = await loadActiveRouter(
      poolCom([
        [{ id: "r1", name: "X", config: { classifier_model: "anthropic/claude-sonnet-5", classifier_provider: "anthropic" }, fallback_agent_id: null }],
        [],
      ]),
      "org1",
      "cs1",
    );
    expect(router?.classifierModel).toBe("anthropic/claude-sonnet-5");
    expect(router?.classifierProvider).toBe("anthropic");
  });
});

describe("classifyIntent — o que o roteador em 'Automático' manda ao seam", () => {
  /**
   * O outro lado da corrente. O `llm_calls` que provou o defeito tem
   * `origem_da_escolha "variavel_de_ambiente"`, e esse ramo de
   * `decidirBinding` só é alcançado quando o call site manda `model`. A
   * pergunta que este teste faz é a que decide o 400: com o roteador em
   * "Automático", o classificador manda modelo?
   */
  it("não manda model nenhum quando o roteador está em 'Automático'", async () => {
    const runModelCall = vi.fn().mockResolvedValue({
      result: { text: JSON.stringify({ intentName: 'vendas', confidence: 0.9 }) },
    });

    await classifyIntent(
      poolVazio(),
      {} as never,
      {
        tenantId: 'org1',
        leadId: 'c1',
        jobId: null,
        router: {
          id: 'r1',
          name: 'Roteador Hubiss',
          classifierModel: null,
          classifierProvider: null,
          sticky: true,
          minConfidence: 0.6,
          fallbackAgentId: null,
          members: [
            {
              agentId: 'a1',
              intentName: 'vendas',
              intentDescription: 'Quer comprar',
              examples: [],
              flowPointerId: null,
            },
          ],
        },
        signal: 'quero comprar',
      },
      { log: { warn: vi.fn() } as never, runModelCall },
    );

    const call = runModelCall.mock.calls[0]![2] as Record<string, unknown>;
    // Sem `model`, o seam resolve pelo painel de provedores ou pelo padrão da
    // organização — os dois caminhos que funcionam. Com `model`, ele vira
    // `variavel_de_ambiente` e vence o padrão da org: é assim que o id do
    // Anthropic foi para o endpoint da OpenRouter.
    expect(call).not.toHaveProperty('model');
    expect(call.purpose).toBe('intent_router');
  });
});
/**
 * O GATE QUE GASTA PASSA A LER O TETO QUE O CLIENTE CONFIGUROU.
 *
 * ## O defeito de origem
 *
 * A tela editava `ai_budgets.monthly_limit_cents`. O enforcement lia
 * `organizations.settings.llm.monthly_budget_cents`. Dois campos, duas fontes,
 * nenhuma ligação — quem preenchia a tela acreditava estar protegido e não
 * estava, e a frase da tela ("a IA pausa ao chegar no limite") era falsa para
 * 100% das instalações. E o campo que de fato protegia falhava ABERTO por
 * construção: era um escalar em jsonb livre lido por dois `.catch()`, onde
 * forma errada virava `null` e `null` era ilimitado.
 *
 * ## O que este arquivo guarda
 *
 * Não a regra — a regra é pura e mora em `orcamento.ts`, com teste próprio
 * (`orcamento-decisao.test.ts`). Aqui guarda-se a LIGAÇÃO: que o seam lê a
 * coluna certa, que executa o veredito da função pura em vez de reinventá-lo,
 * que deixa rastro nas duas tabelas onde alguém vai procurar, e — a parte que
 * mais importa num produto self-host — que ele erra para o lado que NÃO
 * estrangula.
 *
 * `grep -rn assertBudget tests/` devolvia **zero** antes desta onda: o
 * enforcement vivo nunca teve um teste, e uma mudança de semântica atravessava
 * `verify`, `invariants`, `build-and-size` e `e2e` verdes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  decidirOrcamento,
  SQL_ORCAMENTO,
  TITULO_TETO_DO_PLANO,
} from "@/lib/agent-engine/edge/llm/orcamento";

// Credencial BYOK dublê: sem a chave de cifra no ambiente de teste, a
// decifragem real lançaria antes de o gate rodar.
vi.mock("@/lib/crypto/aes_gcm", async (original) => ({
  ...(await original<typeof import("@/lib/crypto/aes_gcm")>()),
  decryptKey: () => "sk-da-organizacao",
}));
import {
  runModelCall,
  LlmBudgetExceededError,
  normalizarErro,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { esquecerMemoDosModulos } from "@/lib/instalacao/modulos";

// A chave da cobrança é lida com memo de processo (MEMO_DO_MODULO_MS): sem
// esquecer, o primeiro caso decidiria a chave de todos os outros.
beforeEach(() => esquecerMemoDosModulos());

const ORG = "33333333-3333-4333-8333-333333333333";

/** O erro que prova que a chamada CHEGOU ao provedor — isto é, que o gate deixou passar. */
const SENTINELA = new Error("o provedor foi alcançado");

const ONTEM = new Date(Date.now() - 24 * 60 * 60 * 1000);
const AMANHA = new Date(Date.now() + 24 * 60 * 60 * 1000);

/** O estado que satisfaz TODAS as condições do bloqueio — o controle positivo. */
const ARMADO_E_ESTOURADO = {
  teto: 1000,
  modo: "bloquear",
  efetivo_em: ONTEM,
  limiar_pct: 80,
  gasto: "1500.0000", // `numeric` do Postgres chega como STRING no node-pg
  avisado_antes: true,
};

interface Estado {
  /** Colunas do `left join` — o que o resolvedor lê para o atalho de custo. */
  config?: Record<string, unknown>;
  /** Uma linha do statement do gate, ou 'erro' para simular a query falhando. */
  gate?: Record<string, unknown> | "erro" | "vazio";
  /** O `left join` levanta 42703 (clone cujo `update.sh` engoliu o apêndice). */
  resolvedorQuebrado?: boolean;
  /** O statement do teto do PLANO. Ausente = sem teto (a cobrança desligada). */
  plano?: { teto: number | null; gasto?: string } | "42883";
  /** A organização tem credencial própria: a chave NÃO é a da instalação. */
  byok?: boolean;
  /** A chave MODULO_COBRANCA (`fn_cobranca_ligada`). Ausente = ligada. */
  cobranca?: boolean | "erro";
}

function poolFalso(estado: Estado) {
  const sqls: string[] = [];
  const inboxInserts: unknown[][] = [];
  const llmCallInserts: unknown[][] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (sql.includes("fn_cobranca_ligada")) {
      if (estado.cobranca === "erro") {
        throw Object.assign(new Error("function public.fn_cobranca_ligada() does not exist"), { code: "42883" });
      }
      return { rows: [{ ligada: estado.cobranca ?? true }] };
    }
    if (sql.includes("fn_limite_do_plano")) {
      if (estado.plano === "42883") {
        throw Object.assign(new Error("function public.fn_limite_do_plano(uuid, text) does not exist"), {
          code: "42883",
        });
      }
      const p = estado.plano ?? { teto: null };
      return { rows: [{ teto: p.teto, gasto: p.teto === null ? null : (p.gasto ?? "0") }] };
    }
    // ⚠️ A ORDEM DESTES RAMOS É LOAD-BEARING: o statement do gate TAMBÉM contém
    // `insert into agent_inbox_items` (a CTE `avisa`), e a query joinada também
    // contém `settings->'llm'`. Casar pelo pedaço mais específico primeiro.
    if (sql.includes("fn_gasto_de_ia_do_mes")) {
      if (estado.gate === "erro") {
        throw Object.assign(new Error('relation "ai_budgets" does not exist'), { code: "42P01" });
      }
      if (estado.gate === "vazio") return { rows: [] };
      return { rows: [{ ...ARMADO_E_ESTOURADO, ...(estado.gate ?? {}) }] };
    }
    if (sql.includes("left join ai_budgets")) {
      if (estado.resolvedorQuebrado === true) {
        throw Object.assign(new Error('column b.enforcement_mode does not exist'), { code: "42703" });
      }
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao", params: {}, enabled_models: [] },
            teto: 1000,
            modo: "bloquear",
            efetivo_em: ONTEM,
            limiar_pct: 80,
            ...(estado.config ?? {}),
          },
        ],
      };
    }
    if (sql.includes("settings->'llm'")) {
      // A query LEGADA — só alcançada quando a joinada levantou.
      return { rows: [{ llm: { provider: "anthropic", default_model: "claude-padrao" } }] };
    }
    if (sql.includes("ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("ai_provider_credentials")) {
      return {
        rows: estado.byok
          ? [{ id: "cred-1", api_key_encrypted: Buffer.alloc(1), api_key_iv: Buffer.alloc(1), api_key_tag: Buffer.alloc(1) }]
          : [],
      };
    }
    if (sql.includes("insert into agent_inbox_items")) {
      inboxInserts.push(params);
      return { rows: [] };
    }
    if (sql.includes("insert into llm_calls")) {
      llmCallInserts.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });

  return { pool: { query } as never, query, sqls, inboxInserts, llmCallInserts };
}

/** Registry cuja fábrica registra a invocação e devolve um modelo que sempre falha. */
function registryQueRegistra() {
  const invocacoes: string[] = [];
  const fabrica = (_chave: string, modelo: string) => {
    invocacoes.push(modelo);
    return {
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: modelo,
      doGenerate: async () => {
        throw SENTINELA;
      },
    } as never;
  };
  return {
    invocacoes,
    registry: { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica },
  };
}

function loggerFalso() {
  const linhas: Array<{ nivel: string; msg: string; campos: Record<string, unknown> }> = [];
  const push = (nivel: string) => (msg: string, campos: Record<string, unknown> = {}) =>
    void linhas.push({ nivel, msg, campos });
  return { linhas, log: { info: push("info"), warn: push("warn"), error: push("error") } };
}

async function chamar(
  estado: Estado,
  cfg: { budgetEnforcement?: "on" | "avisar" | "off" } = {},
  input: Record<string, unknown> = {},
) {
  const p = poolFalso(estado);
  const r = registryQueRegistra();
  const l = loggerFalso();
  let lancou: unknown = null;
  try {
    await runModelCall(
      p.pool,
      { anthropicApiKey: "sk-ant-x", cacheTtl: "1h", ...cfg },
      { tenantId: ORG, messages: [{ role: "user", content: "oi" }], ...input } as never,
      { registry: r.registry as never, log: l.log },
    );
  } catch (err) {
    lancou = err;
  }
  return { ...p, ...r, ...l, lancou };
}

describe("o gate de orçamento lê ai_budgets e executa o veredito", () => {
  describe("controle positivo — as seis condições satisfeitas BLOQUEIAM", () => {
    it("recusa antes de tocar no provedor, e o erro é o tipado", async () => {
      const r = await chamar({});
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
      // Zero token: a fábrica do provedor sequer foi construída.
      expect(r.invocacoes).toEqual([]);
    });

    it("abre UM budget_exceeded com ref_kind, que é o que permite fechá-lo depois", async () => {
      const r = await chamar({});
      expect(r.inboxInserts).toHaveLength(1);
      const sqlDoInsert = r.sqls.find(
        (s) => s.includes("insert into agent_inbox_items") && !s.includes("fn_gasto_de_ia_do_mes"),
      );
      // Sem ref_kind/ref_id nenhum auto-resolvedor alcança o item: virava o mês,
      // a IA voltava, e o alerta crítico continuava aceso. Estado falso é pior
      // que ausente, porque quem lê age sobre ele.
      expect(sqlDoInsert).toMatch(/ref_kind/);
      expect(sqlDoInsert).toMatch(/'ai_budget'/);
      // Dedup preservado: enquanto houver item aberto, recusa nova não duplica.
      expect(sqlDoInsert).toMatch(/not exists/i);
    });

    it("o texto do aviso fala com um leigo, não com o schema", async () => {
      const r = await chamar({});
      const [, titulo, corpo] = r.inboxInserts[0] as [string, string, string];
      expect(titulo).toBe("O limite de gasto com IA foi atingido");
      // O corpo anterior era, verbatim: "o teto configurado em
      // organizations.settings.llm.monthly_budget_cents; aumente o teto ou
      // aguarde a virada do mês" — um caminho de coluna jsonb renderizado CRU
      // para o dono do negócio na Central, mandando aumentar um teto na única
      // tela que edita OUTRO campo.
      expect(corpo).not.toMatch(/settings|jsonb|monthly_budget_cents|org\b/i);
      // E diz os números, na unidade real: `cost_cents` é centavo de DÓLAR.
      expect(corpo).toContain("US$ 15,00");
      expect(corpo).toContain("US$ 10,00");
      expect(corpo).toContain("Uso de IA");
    });

    it("a recusa vira linha de ERRO em llm_calls — a tela de Execuções a mostra", async () => {
      const r = await chamar({});
      expect(r.llmCallInserts).toHaveLength(1);
      // O `throw` de antes caía FORA do `try` que grava a falha: a tela que
      // nasceu porque "llm_calls só registrava sucesso" nunca mostrava o único
      // caso em que o agente para de propósito.
      const params = r.llmCallInserts[0] as unknown[];
      expect(params).toContain("orcamento_esgotado");
    });

    it("o erro tipado é classificado, não cai em 'erro_desconhecido'", () => {
      expect(normalizarErro(new LlmBudgetExceededError()).error_code).toBe("orcamento_esgotado");
    });

    it("é marcado como terminal — a fila precisa distinguir veto de incidente", () => {
      expect(new LlmBudgetExceededError().terminal).toBe(true);
    });
  });

  describe("ninguém é estrangulado: cada recusa da função pura chega ao seam", () => {
    it("modo 'off' com gasto 10x o teto SEGUE — e sem ir ao banco", async () => {
      const r = await chamar({ config: { modo: "off" } });
      expect(r.lancou).toBe(SENTINELA);
      // O atalho de custo: com 'off' em 100% das organizações no dia do
      // upgrade, o caminho de orçamento faz estritamente MENOS trabalho que o
      // `assertBudget` de antes, que ia ao banco somar llm_calls. (Com a
      // cobrança desligada o statement do teto do PLANO nem sai — ver "o teto
      // de IA do plano" abaixo.)
      expect(r.sqls).not.toContain(SQL_ORCAMENTO);
    });

    it("organização SEM linha em ai_budgets SEGUE (o left join devolve nulos)", async () => {
      const r = await chamar({
        config: { modo: null, teto: null, efetivo_em: null, limiar_pct: null },
      });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls).not.toContain(SQL_ORCAMENTO);
    });

    /**
     * O caso que pega o gate DESCARTANDO o modo que leu. Os dois anteriores são
     * atendidos pelo atalho de custo, antes da query — se alguém fixasse
     * `modo: 'bloquear'` na entrada da decisão, eles continuariam verdes e o
     * degrau do meio da escada sumiria em silêncio. Aqui a organização escolheu
     * "me avisar", o gasto passou do teto, e a IA tem de continuar respondendo.
     */
    it("modo 'avisar' no banco NUNCA bloqueia, por mais que o gasto passe", async () => {
      const r = await chamar({ config: { modo: "avisar" }, gate: { modo: "avisar" } });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn" && l.msg.includes("passou do aviso"))).toBe(true);
    });

    it("teto 0 SEGUE — 0 é 'sem limite' na tela, e era 'bloqueia tudo' no gate", async () => {
      const r = await chamar({ gate: { teto: 0, gasto: "0" } });
      expect(r.lancou).toBe(SENTINELA);
    });

    it("teto abaixo do piso de US$ 1,00 SEGUE — é erro de unidade, não orçamento", async () => {
      const r = await chamar({ gate: { teto: 99, gasto: "5000" } });
      expect(r.lancou).toBe(SENTINELA);
    });

    it("carência não vencida no máximo avisa", async () => {
      const r = await chamar({ gate: { efetivo_em: AMANHA } });
      expect(r.lancou).toBe(SENTINELA);
    });

    it("sem aviso neste mês, o primeiro cruzamento avisa e SEGUE", async () => {
      const r = await chamar({ gate: { avisado_antes: false } });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn" && l.msg.includes("passou do aviso"))).toBe(true);
    });

    it("purpose isento SEGUE — bloquear diagnóstico ou guardrail é o corte errado", async () => {
      for (const purpose of ["connection_test", "jailbreak_detect", "promise_semantic"]) {
        const r = await chamar({}, {}, { purpose });
        expect(r.lancou, `purpose ${purpose} foi bloqueado`).toBe(SENTINELA);
      }
    });
  });

  describe("a alavanca de emergência chega ao gate", () => {
    it("AI_BUDGET_ENFORCEMENT=off cala a proteção e nem consulta o banco", async () => {
      const r = await chamar({}, { budgetEnforcement: "off" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_gasto_de_ia_do_mes"))).toBe(false);
    });

    it("AI_BUDGET_ENFORCEMENT=avisar rebaixa o bloqueio a aviso", async () => {
      const r = await chamar({}, { budgetEnforcement: "avisar" });
      expect(r.lancou).toBe(SENTINELA);
    });

    it("config sem a chave se comporta como 'on' — o seam não inventa um default próprio", async () => {
      const r = await chamar({}, {});
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
    });
  });

  describe("falha ABERTA na ação, ABERTA na informação", () => {
    it("a query do orçamento falhando NÃO bloqueia — e a causa vai ao log", async () => {
      const r = await chamar({ gate: "erro" });
      // O cliente não pode perder o agente porque uma query deu erro.
      expect(r.lancou).toBe(SENTINELA);
      const aviso = r.linhas.find((l) => l.nivel === "warn" && l.msg.includes("orçamento"));
      expect(aviso, "seguiu em SILÊNCIO — a frase tranquilizadora sem a causa").toBeDefined();
      // A causa NOMEADA, não "algo deu errado": sem ela a próxima pessoa
      // investiga do zero.
      expect(JSON.stringify(aviso?.campos)).toMatch(/does not exist/);
    });

    it("statement sem linha (mundo impossível) também SEGUE, e avisa", async () => {
      const r = await chamar({ gate: "vazio" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn")).toBe(true);
    });

    it("coluna inexistente (clone com update.sh engolido) cai na query legada e SEGUE", async () => {
      const r = await chamar({ resolvedorQuebrado: true });
      // `update.sh` aplica o baseline SEM ON_ERROR_STOP e sobe a imagem nova
      // depois. Um throw aqui derrubaria TODA chamada de IA de TODA organização
      // do clone — pior que o estrangulamento que este trabalho evita.
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.filter((s) => s.includes("settings->'llm'")).length).toBeGreaterThanOrEqual(2);
      const aviso = r.linhas.find((l) => l.nivel === "warn");
      expect(JSON.stringify(aviso?.campos)).toMatch(/42703/);
    });
  });

  /**
   * O TETO DE IA DO PLANO (spec da cobrança §5, decisão D-9). O bolso do dono
   * da instalação: vem ANTES do orçamento da org, que o `modo 'off'` dela não
   * desliga; só a chave da instalação o consulta; e o interruptor de emergência
   * desliga os dois.
   */
  describe("o teto de IA do plano", () => {
    const ESTOURADO = { teto: 1000, gasto: "1500.0000" };

    it("⭐ estourado com a chave da instalação BLOQUEIA, mesmo com o orçamento da org em 'off'", async () => {
      const r = await chamar({ config: { modo: "off" }, plano: ESTOURADO });
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
      expect((r.lancou as Error).message).toMatch(/plano/);
      expect(r.invocacoes).toEqual([]);
      const sqlDoItem = r.sqls.find((s) => s.startsWith("insert into agent_inbox_items"));
      expect(sqlDoItem).toMatch(/'plano'/);
      expect(sqlDoItem, "o dedup não olha o ref_kind: o aviso da org calaria o do plano").toMatch(
        /and ref_kind = 'plano'/,
      );
      expect((r.inboxInserts[0] as unknown[])[1]).toBe(TITULO_TETO_DO_PLANO);
      expect(r.llmCallInserts[0] as unknown[]).toContain("orcamento_esgotado");
      expect(r.sqls).not.toContain(SQL_ORCAMENTO);
    });

    it("abaixo do teto do plano, o orçamento da org continua decidindo (e bloqueia com o item DELE)", async () => {
      const r = await chamar({ plano: { teto: 5000, gasto: "100" } });
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
      const sqlDoItem = r.sqls.find((s) => s.startsWith("insert into agent_inbox_items"));
      expect(sqlDoItem).toMatch(/and ref_kind = 'ai_budget'/);
    });

    it("AI_BUDGET_ENFORCEMENT=off desliga o teto do plano e nem o consulta (D-9)", async () => {
      const r = await chamar({ plano: ESTOURADO }, { budgetEnforcement: "off" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_limite_do_plano"))).toBe(false);
    });

    it("BYOK: a chave da organização nunca consulta o teto do plano", async () => {
      const r = await chamar({ byok: true, config: { modo: "off" }, plano: ESTOURADO });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_limite_do_plano"))).toBe(false);
    });

    it("purpose isento segue mesmo com o plano estourado", async () => {
      const r = await chamar({ config: { modo: "off" }, plano: ESTOURADO }, {}, { purpose: "connection_test" });
      expect(r.lancou).toBe(SENTINELA);
    });

    it("⭐ 42883 na consulta do teto: o orçamento da org CONTINUA aplicado, a causa vai ao log, e SQL_CONFIG_COM_ORCAMENTO não mudou", async () => {
      const r = await chamar({ plano: "42883" });
      // O modo 'bloquear' de ai_budgets segue valendo: o erro do plano não
      // derrubou o orçamento que já existia (spec §5 — o motivo de a consulta
      // do plano ser PRÓPRIA, e não pendurada no left join da config).
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
      expect(r.sqls.find((s) => s.startsWith("insert into agent_inbox_items"))).toMatch(/'ai_budget'/);
      const aviso = r.linhas.find((l) => l.nivel === "warn" && l.msg.includes("teto do plano"));
      expect(aviso, "o teto do plano falhou em SILÊNCIO").toBeDefined();
      expect(JSON.stringify(aviso?.campos)).toMatch(/42883/);
      const config = r.sqls.find((s) => s.includes("left join ai_budgets"));
      expect(config).toBeDefined();
      expect(config).not.toMatch(/fn_limite_do_plano/);
      expect(r.sqls.filter((s) => s.includes("settings->'llm'"))).toHaveLength(1);
    });

    it("42883 com o orçamento da org em 'off': a chamada SEGUE (falha aberta)", async () => {
      const r = await chamar({ config: { modo: "off" }, plano: "42883" });
      expect(r.lancou).toBe(SENTINELA);
    });

    // A instalação de empresa única (a cobrança desligada, o caso de quase
    // todas) não paga uma ida ao banco por chamada de LLM por uma capacidade
    // que não usa — o precedente de MEMO_DO_MODULO_MS (lib/instalacao/modulos.ts).
    it("⭐ cobrança DESLIGADA: o statement do teto do plano nem sai", async () => {
      const r = await chamar({ cobranca: false, config: { modo: "off" }, plano: ESTOURADO });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_limite_do_plano"))).toBe(false);
    });

    it("⭐ a chave da cobrança é lida UMA vez por janela do memo, não a cada chamada", async () => {
      const primeira = await chamar({ cobranca: false, config: { modo: "off" } });
      const segunda = await chamar({ cobranca: false, config: { modo: "off" } });
      expect(primeira.sqls.filter((s) => s.includes("fn_cobranca_ligada"))).toHaveLength(1);
      expect(segunda.sqls.some((s) => s.includes("fn_cobranca_ligada"))).toBe(false);
    });

    it("leitura da chave da cobrança falha: o teto do plano não roda e a chamada SEGUE (falha aberta, como o 42883)", async () => {
      const r = await chamar({ cobranca: "erro", config: { modo: "off" }, plano: ESTOURADO });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_limite_do_plano"))).toBe(false);
    });
  });

  /**
   * A CATRACA CONTRA A DIVERGÊNCIA SILENCIOSA.
   *
   * O gate tem duas condições repetidas antes da query (`modo === 'off'` e
   * `chave === 'off'`), e elas são um atalho de CUSTO, não uma segunda cópia da
   * regra. O que as autoriza é a função pura devolver `seguir` para as duas sob
   * qualquer outro valor de entrada. Se alguém mudar a função e esquecer o
   * atalho, o atalho passa a decidir sozinho — em silêncio, e para menos.
   */
  describe("o atalho de custo concorda com a função pura", () => {
    const TUDO_MAIS_PEDE_BLOQUEIO = {
      tetoCents: 1000,
      gastoCents: 999_999,
      efetivoEm: ONTEM,
      agora: new Date(),
      purpose: "agent_turn",
      limiarPct: 80,
      avisadoNesteMes: true,
    } as const;

    it("modo 'off' devolve 'seguir' mesmo com tudo o mais pedindo bloqueio", () => {
      expect(
        decidirOrcamento({ ...TUDO_MAIS_PEDE_BLOQUEIO, modo: "off", chave: "on" }).acao,
      ).toBe("seguir");
    });

    it("chave 'off' devolve 'seguir' mesmo com tudo o mais pedindo bloqueio", () => {
      expect(
        decidirOrcamento({ ...TUDO_MAIS_PEDE_BLOQUEIO, modo: "bloquear", chave: "off" }).acao,
      ).toBe("seguir");
    });

    it("e o controle: sem nenhum dos dois atalhos, o mesmo estado BLOQUEIA", () => {
      expect(
        decidirOrcamento({ ...TUDO_MAIS_PEDE_BLOQUEIO, modo: "bloquear", chave: "on" }).acao,
      ).toBe("bloquear");
    });
  });
});

/**
 * A ALAVANCA DE EMERGÊNCIA NÃO PODE SER O QUE DERRUBA O APP.
 *
 * ## O que esta chave é
 *
 * `AI_BUDGET_ENFORCEMENT` é o freio que o operador da VPS puxa quando a IA
 * parou por gasto e ele precisa dela de volta AGORA — sem `psql`, sem saber
 * SQL, sem esperar a virada do mês. Ela só sabe AFROUXAR: `off` cala a proteção
 * inteira, `avisar` rebaixa qualquer bloqueio a aviso, e `on` (o default) não
 * liga nada — significa apenas "respeite o que cada organização escolheu".
 *
 * ## Por que ela é `z.string()` e não `z.enum`
 *
 * `lib/env.ts` faz `safeParse` e **lança** quando o schema recusa. No Next isso
 * acontece na PRIMEIRA REQUISIÇÃO, não no boot — e o healthcheck do contêiner é
 * um probe TCP puro. Somando os dois: o Docker mostra `healthy` enquanto 100%
 * das requisições devolvem 500. Um `z.enum(['on','avisar','off'])` aqui
 * transformaria a alavanca de emergência no derrubador do app inteiro no dia em
 * que o operador, às 2h da manhã, escrevesse `false` em vez de `off`.
 *
 * O idioma dos vizinhos (`AGENT_DISPATCH_CONSUMER`, `EVENT_LOG_WORKER_ENABLED`)
 * é `z.enum`, e para eles está certo: são knobs de arquitetura, escritos uma vez
 * na instalação. Este é o oposto — é mexido justamente quando algo já deu
 * errado. O precedente correto no mesmo arquivo é `APP_ACCENT_HEX`: string crua
 * no env, normalização no código.
 *
 * ## E a quarta irmã
 *
 * O worker (`lib/agent-engine/env.ts`) tem schema PRÓPRIO, e `loadEnv` devolve
 * `parsed.data` — o Zod REMOVE o que o schema não declara. Já aconteceu três
 * vezes neste repositório: `OPENAI_API_KEY`, depois `OPENROUTER_API_KEY`, com a
 * chave no `.env`, o app enxergando e o worker não. Aqui doeria mais, porque
 * quem GASTA é o worker: o operador puxaria a alavanca e a IA continuaria
 * parada, sem uma pista do porquê.
 */
import { describe, expect, it, vi } from "vitest";

import {
  normalizarChaveDeOrcamento,
  normalizarModoDeOrcamento,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { loadEnv } from "@/lib/agent-engine/env";

const ENV_MINIMO_DO_WORKER: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

describe("normalizarChaveDeOrcamento — o operador escreve, e o produto entende", () => {
  it.each(["off", "false", "0", "no", "nao", "não", "disabled"])(
    "%s desliga a proteção",
    (grafia) => {
      expect(normalizarChaveDeOrcamento(grafia)).toBe("off");
    },
  );

  it("caixa e espaço não mudam o sentido — é um .env editado à mão", () => {
    expect(normalizarChaveDeOrcamento("OFF")).toBe("off");
    expect(normalizarChaveDeOrcamento("  off  ")).toBe("off");
    expect(normalizarChaveDeOrcamento("False")).toBe("off");
    expect(normalizarChaveDeOrcamento("NÃO")).toBe("off");
  });

  it("avisar e warn rebaixam, sem desligar", () => {
    expect(normalizarChaveDeOrcamento("avisar")).toBe("avisar");
    expect(normalizarChaveDeOrcamento("warn")).toBe("avisar");
    expect(normalizarChaveDeOrcamento("WARN")).toBe("avisar");
  });

  it.each([undefined, "", "on", "ON", "xpto", "yes", "true"])(
    "%s cai no lado que respeita a escolha da organização",
    (bruto) => {
      expect(normalizarChaveDeOrcamento(bruto)).toBe("on");
    },
  );

  /**
   * O controle negativo do normalizador: se ele devolvesse `'on'` para TUDO,
   * todos os casos acima continuariam verdes menos este par. É o que separa
   * "a função classifica" de "a função tem um valor favorito".
   */
  it("as três saídas são alcançáveis (controle negativo)", () => {
    const saidas = new Set(["off", "avisar", "qualquer-coisa"].map(normalizarChaveDeOrcamento));
    expect([...saidas].sort()).toEqual(["avisar", "off", "on"]);
  });
});

describe("normalizarModoDeOrcamento — nulo é sempre a resposta mais frouxa", () => {
  it("os três valores do CHECK passam intactos", () => {
    expect(normalizarModoDeOrcamento("off")).toBe("off");
    expect(normalizarModoDeOrcamento("avisar")).toBe("avisar");
    expect(normalizarModoDeOrcamento("bloquear")).toBe("bloquear");
  });

  it.each([null, undefined, "", "OFF", "Bloquear", "xpto"])(
    "%s (o que o left join devolve para organização sem linha, ou lixo) vira off",
    (bruto) => {
      expect(normalizarModoDeOrcamento(bruto)).toBe("off");
    },
  );
});

describe("a chave chega ao produto pelos DOIS donos de env", () => {
  /**
   * ⚠️ ESTE É O CASO QUE EXISTE POR CAUSA DE `lib/env.ts` LANÇAR.
   *
   * Sabotagem que o deixa vermelho: trocar o campo por
   * `z.enum(['on','avisar','off'])`. Aí `AI_BUDGET_ENFORCEMENT=false` — a grafia
   * que o operador de VPS escreve — passa a derrubar o import do módulo, e no
   * Next isso é 500 em toda tela com o contêiner `healthy`.
   */
  it("valor não reconhecido em lib/env.ts NÃO derruba o app", async () => {
    vi.resetModules();
    const anterior = process.env.AI_BUDGET_ENFORCEMENT;
    process.env.AI_BUDGET_ENFORCEMENT = "lixo-que-o-operador-digitou";
    try {
      const { env } = await import("@/lib/env");
      expect(env.AI_BUDGET_ENFORCEMENT).toBe("lixo-que-o-operador-digitou");
      // E o produto o entende como o lado seguro, não como bloqueio.
      expect(normalizarChaveDeOrcamento(env.AI_BUDGET_ENFORCEMENT)).toBe("on");
    } finally {
      if (anterior === undefined) delete process.env.AI_BUDGET_ENFORCEMENT;
      else process.env.AI_BUDGET_ENFORCEMENT = anterior;
      vi.resetModules();
    }
  });

  it("ausente em lib/env.ts cai no default 'on'", async () => {
    vi.resetModules();
    const anterior = process.env.AI_BUDGET_ENFORCEMENT;
    delete process.env.AI_BUDGET_ENFORCEMENT;
    try {
      const { env } = await import("@/lib/env");
      expect(env.AI_BUDGET_ENFORCEMENT).toBe("on");
    } finally {
      if (anterior !== undefined) process.env.AI_BUDGET_ENFORCEMENT = anterior;
      vi.resetModules();
    }
  });

  /**
   * A quarta irmã. Sabotagem: apagar a linha de `AI_BUDGET_ENFORCEMENT` do
   * schema em `lib/agent-engine/env.ts`. O `tsc` continua verde (o parâmetro de
   * `llmEdgeConfigFromEnv` declara a chave como opcional) e nenhum outro teste
   * reprova — exatamente como nas três chaves de provedor que já passaram por
   * isto. A IA, que gasta no worker, ficaria surda à alavanca.
   */
  it("a chave sobrevive ao strip do Zod no env do WORKER", () => {
    const env = loadEnv({ ...ENV_MINIMO_DO_WORKER, AI_BUDGET_ENFORCEMENT: "off" });
    expect(env.AI_BUDGET_ENFORCEMENT).toBe("off");
  });

  it("vazia no worker é ausente — mesmo contrato das demais", () => {
    const env = loadEnv({ ...ENV_MINIMO_DO_WORKER, AI_BUDGET_ENFORCEMENT: "" });
    expect(env.AI_BUDGET_ENFORCEMENT).toBeUndefined();
  });

  it("valor não reconhecido não derruba o boot do WORKER", () => {
    const env = loadEnv({ ...ENV_MINIMO_DO_WORKER, AI_BUDGET_ENFORCEMENT: "lixo" });
    expect(normalizarChaveDeOrcamento(env.AI_BUDGET_ENFORCEMENT)).toBe("on");
  });

  /**
   * A ponte. Os casos acima provam que a chave existe nos dois schemas; este
   * prova que ela ATRAVESSA até a config que o seam de LLM consulta — que é o
   * defeito que "guardar a função de consumo não guarda o call site" descreve.
   */
  it("llmEdgeConfigFromEnv leva a chave normalizada até o seam", () => {
    expect(llmEdgeConfigFromEnv({ AI_BUDGET_ENFORCEMENT: "off" }).budgetEnforcement).toBe("off");
    expect(llmEdgeConfigFromEnv({ AI_BUDGET_ENFORCEMENT: "avisar" }).budgetEnforcement).toBe("avisar");
    expect(llmEdgeConfigFromEnv({ AI_BUDGET_ENFORCEMENT: "false" }).budgetEnforcement).toBe("off");
    // Sem a chave, a config sai com o significado do ausente — nunca undefined,
    // que obrigaria o seam a repetir o default (e dois defaults é como um dos
    // dois fica para trás).
    expect(llmEdgeConfigFromEnv({}).budgetEnforcement).toBe("on");
  });
});

describe(".env.example e .env.selfhost.example documentam a alavanca", () => {
  it("as duas pontas citam a variável (DoD 9)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const arquivo of [".env.example", ".env.selfhost.example"]) {
      const texto = readFileSync(join(process.cwd(), arquivo), "utf8");
      expect(texto, `${arquivo} não documenta AI_BUDGET_ENFORCEMENT`).toContain(
        "AI_BUDGET_ENFORCEMENT",
      );
      // Documentar sem dizer como DESLIGAR seria documentar o inverso do que a
      // chave serve. É a única instrução que alguém procura às 2h da manhã.
      expect(texto, `${arquivo} não diz como desligar`).toMatch(/\boff\b/);
    }
  });
});

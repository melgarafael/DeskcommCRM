/**
 * PROVEDOR SEM SALDO — o que decide esperar a recarga, e o que NÃO decide.
 *
 * O caso de campo (24/09/2026): a Anthropic respondeu 400 "Your credit balance
 * is too low…" por 74 minutos, a fila queimou as 5 tentativas em 2,5 minutos e
 * um cliente ficou sem resposta. A espera só serve se reconhecer ESTA frase — e
 * só é segura se NÃO reconhecer as parecidas: um limite de ritmo (429) passa
 * sozinho e já tem a espera curta da fila; esperar horas por ele atrasaria
 * respostas que sairiam em segundos.
 *
 * O SQL (reagendar sem gastar tentativa, o aviso único, fechar o aviso) é
 * provado contra Postgres em `tests/invariants/espera-de-saldo.test.ts`.
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";

import { normalizarErro } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  JANELA_DA_ESPERA_MS,
  PREFIXO_DA_ESPERA,
  adiarAteORecarregar,
  avisarFaltaDeSaldo,
  deveEsperarSaldo,
  encerrarAvisoDeFaltaDeSaldo,
  esperouPorSaldo,
  intervaloDaEspera,
  jaNaoHaOQueResponder,
  provedorSemSaldo,
} from "@/lib/agent-engine/queue/espera-de-saldo";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ANTHROPIC =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const OPENAI = "You exceeded your current quota, please check your plan and billing details.";
const AGORA = Date.parse("2026-09-24T12:48:49Z");
const criadoHa = (ms: number) => ({ created_at: new Date(AGORA - ms) });

describe("qual erro é falta de saldo", () => {
  it("a frase da Anthropic (400) e as da OpenAI (429) — com o provedor certo", () => {
    expect(provedorSemSaldo(Object.assign(new Error(ANTHROPIC), { statusCode: 400 }))).toBe("anthropic");
    expect(provedorSemSaldo(new Error(OPENAI))).toBe("openai");
    expect(provedorSemSaldo(new Error('429 {"error":{"code":"insufficient_quota"}}'))).toBe("openai");
  });

  it("reconhece o erro do provedor embrulhado pelo SDK", () => {
    expect(provedorSemSaldo(new Error("Failed after 3 attempts", { cause: new Error(ANTHROPIC) }))).toBe(
      "anthropic",
    );
  });

  it("NÃO confunde com limite de ritmo, chave recusada nem pedido malformado", () => {
    expect(provedorSemSaldo(new Error("429 rate limit reached for tokens (TPM)"))).toBeNull();
    expect(provedorSemSaldo(new Error("API key is invalid."))).toBeNull();
    expect(provedorSemSaldo(new Error("messages: at least one message is required"))).toBeNull();
    expect(provedorSemSaldo("socket hang up")).toBeNull();
  });
});

describe("quando esperar a recarga", () => {
  it("espera enquanto o job tem menos de 6 horas; depois, segue o caminho comum", () => {
    const erro = new Error(ANTHROPIC);
    expect(deveEsperarSaldo(criadoHa(0), erro, AGORA)).toBe(true);
    expect(deveEsperarSaldo(criadoHa(JANELA_DA_ESPERA_MS - 1), erro, AGORA)).toBe(true);
    expect(deveEsperarSaldo(criadoHa(JANELA_DA_ESPERA_MS), erro, AGORA)).toBe(false);
  });

  it("nunca espera por um erro que não é falta de saldo", () => {
    expect(deveEsperarSaldo(criadoHa(0), new Error("429 rate limit reached"), AGORA)).toBe(false);
  });

  it("tenta a cada 2 min na primeira meia hora e a cada 10 min depois", () => {
    expect(intervaloDaEspera(criadoHa(0), AGORA)).toBe(120_000);
    expect(intervaloDaEspera(criadoHa(29 * 60_000), AGORA)).toBe(120_000);
    expect(intervaloDaEspera(criadoHa(30 * 60_000), AGORA)).toBe(600_000);
  });

  it("o job que volta da espera é reconhecido pelo last_error", () => {
    expect(esperouPorSaldo({ last_error: `${PREFIXO_DA_ESPERA}${ANTHROPIC}` })).toBe(true);
    expect(esperouPorSaldo({ last_error: ANTHROPIC })).toBe(false);
    expect(esperouPorSaldo({ last_error: null })).toBe(false);
  });
});

describe("a tela de Execuções dá o nome certo à recusa", () => {
  it("o 400 de saldo da Anthropic é limite_ou_saldo, não erro_desconhecido", () => {
    expect(normalizarErro(Object.assign(new Error(ANTHROPIC), { statusCode: 400 })).error_code).toBe(
      "limite_ou_saldo",
    );
  });
});

/** Um `pg` de mentira que guarda cada consulta e responde pela primeira palavra-chave que casar. */
function bancoFalso(respostas: Array<[RegExp, Record<string, unknown>[]]> = []) {
  const consultas: { sql: string; params: unknown[] }[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      consultas.push({ sql, params });
      const achou = respostas.find(([re]) => re.test(sql));
      const rows = achou?.[1] ?? [];
      return { rows, rowCount: rows.length } as never;
    },
  };
  // O mesmo objeto serve de `Queryable` e do `Pick<pg.Pool, "query">` do repositório.
  return { db: db as typeof db & Pick<pg.Pool, "query">, consultas };
}

describe("o que vai para o banco", () => {
  const job = { id: "job-1", created_at: new Date(AGORA) } as Pick<JobRow, "id" | "created_at">;

  it("adiar reagenda SEM gastar tentativa, com o motivo marcado", async () => {
    const { db, consultas } = bancoFalso();
    await adiarAteORecarregar(db, job, "w1", new Error(ANTHROPIC), "2026-09-24 12:48:49.1+00", AGORA);
    const [c] = consultas;
    expect(c?.sql).toMatch(/attempts = greatest\(attempts - 1, 0\)/);
    expect(c?.params).toEqual(["job-1", "w1", 120_000, `${PREFIXO_DA_ESPERA}${ANTHROPIC}`, "2026-09-24 12:48:49.1+00"]);
  });

  it("só o inbound_turn pergunta se já foi respondido, e sempre com a organização", async () => {
    const { db, consultas } = bancoFalso([[/from conversations/, [{ respondida: true }]]]);
    const base = { organization_id: "org-1", payload: { conversation_id: "conv-1" } };
    expect(await jaNaoHaOQueResponder(db, { ...base, kind: "followup_turn" })).toBe(false);
    expect(consultas).toHaveLength(0);
    expect(await jaNaoHaOQueResponder(db, { ...base, kind: "inbound_turn" })).toBe(true);
    expect(consultas[0]?.params).toEqual(["conv-1", "org-1"]);
  });

  it("o aviso nasce no idioma da organização, aponta a credencial e não se repete", async () => {
    const { db, consultas } = bancoFalso([
      [/from organizations/, [{ locale: "es" }]],
      [/from ai_provider_credentials/, [{ id: "cred-1" }]],
    ]);
    await avisarFaltaDeSaldo(db, "org-1", new Error(ANTHROPIC));
    expect(consultas[1]?.params).toEqual(["org-1", "anthropic"]);
    const insert = consultas[2]!;
    expect(insert.sql).toMatch(/where not exists/);
    expect(insert.params.slice(0, 7)).toEqual([
      "org-1",
      "other",
      "critical",
      "La IA se quedó sin saldo en el proveedor",
      expect.stringContaining("Recarga el saldo en la cuenta del proveedor"),
      "ai_provider_credential",
      "cred-1",
    ]);
    expect(insert.params[4]).toMatch(/Proveedor: anthropic$/);
    // dedupe por kind + título: um aviso aberto por organização
    expect(insert.params.slice(7)).toEqual([false, true]);
  });

  it("com a chave da instalação (sem credencial da organização) o aviso nasce sem destino", async () => {
    const { db, consultas } = bancoFalso([[/from organizations/, [{ locale: null }]]]);
    await avisarFaltaDeSaldo(db, "org-1", new Error(ANTHROPIC));
    expect(consultas[2]?.params.slice(3, 7)).toEqual([
      "A IA está sem saldo no provedor",
      expect.stringContaining("Provedor: anthropic"),
      null,
      null,
    ]);
  });

  it("encerrar fecha o aviso aberto da organização pelo título no idioma dela", async () => {
    const { db, consultas } = bancoFalso([[/from organizations/, [{ locale: "es" }]]]);
    await encerrarAvisoDeFaltaDeSaldo(db, "org-1");
    expect(consultas[1]?.sql).toMatch(/set status = 'resolved', resolved_at = now\(\)/);
    expect(consultas[1]?.params).toEqual(["org-1", "La IA se quedó sin saldo en el proveedor"]);
  });
});

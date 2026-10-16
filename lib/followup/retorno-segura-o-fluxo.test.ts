import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { FOLGA_DEPOIS_DO_RETORNO_MS } from "./retorno-segura-o-fluxo";
import { createSupabaseSilenceSweepDb } from "./silence-sweep";

/**
 * O RETORNO QUE JÁ SAIU CONTINUA SEGURANDO O FLUXO DE SILÊNCIO (issue #2907).
 *
 * ## O defeito (medido em produção, gatilho de silêncio de 40 min)
 *
 * 18:05 o lead pede retorno em 50 min → o agente agenda (`crm_schedule_followup`)
 * e promete "te escrevo às 18:55". Enquanto o retorno está AGENDADO a varredura
 * segura o contato (certo: 18:45 não inscreve). Mas às 18:56:04 o retorno SAI — e
 * a linha de `cron_jobs` deixa de ser "viva" (`enabled=false`, o disparo one-shot
 * se encerra). A varredura do minuto seguinte não vê mais retorno nenhum,
 * INSCREVE o contato (18:56:00 a inscrição nasce) e o 1º passo do fluxo de
 * silêncio sai às 18:58:05 — duas mensagens seguidas, sem o lead responder.
 *
 * ## A regra, a mesma dos dois lados
 *
 * `retorno-segura-o-fluxo.ts` já segura a inscrição que JÁ ESTAVA andando até
 * `FOLGA_DEPOIS_DO_RETORNO_MS` (1 dia) depois do retorno. O que faltava era a
 * mesma folga valer para a inscrição NOVA: o corte de silêncio que a varredura
 * respeita passa a incluir o retorno RECÉM-EXECUTADO, lido da mesma linha de
 * `cron_jobs` que sabe quando ele saiu (`enabled=false`, `last_error` nulo — o
 * mesmo `situacaoDoRetorno` de `retorno.ts` que distingue disparado de
 * cancelado e de "não disparado").
 *
 * ## O que este arquivo prova
 *
 * A régua de produção (`createSupabaseSilenceSweepDb(...).loadContatosComRetornoVivo`,
 * sobre o PostgREST): o contato com retorno disparado há 2 h entra no corte; o
 * vivo continua entrando; o disparado há 30 h sai (a folga venceu); a linha
 * desabilitada ANTES da hora (cancelada por opt-out/handoff, que o scheduler faz
 * sem `cancelled_at`) não conta como retorno saído; e a régua que o Postgres
 * recebe — `kind='at'`, `job_kind='followup_turn'`, `enabled=false`, sem
 * `cancelled_at`, sem `last_error`, sem turno de passo de fluxo, com
 * `next_run_at` na janela de um dia.
 *
 * ## O que NÃO prova
 *
 * A varredura de ponta a ponta com banco real: o espelho em SQL puro mora no
 * invariante (`tests/invariants/followup-silence-sweep.test.ts`, `test:db`), que
 * é congelado e a régua dele NÃO foi atualizada por esta fatia — declarado no PR.
 */

type Linha = Record<string, unknown>;

/** Fake no desenho de `silence-sweep-inscricao-viva-query.test.ts`: grava a cadeia, não filtra (filtrar é do Postgres). */
function fakeAdmin(respostas: Linha[][]) {
  const consultas: Array<Array<{ metodo: string; args: unknown[] }>> = [];
  const from = (tabela: string) => {
    const chamadas: Array<{ metodo: string; args: unknown[] }> = [{ metodo: "from", args: [tabela] }];
    const rows = respostas[consultas.length] ?? [];
    consultas.push(chamadas);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
          }
          return (...args: unknown[]) => {
            chamadas.push({ metodo: String(prop), args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as unknown as SupabaseClient, consultas };
}

const AGORA = Date.now();
/** `next_run_at` relativo ao agora do teste — a folga é de 1 dia, então 2 h e 30 h são longe das bordas. */
const quando = (deslocamentoMs: number) => new Date(AGORA - deslocamentoMs).toISOString();

const HORA = 3_600_000;

describe("o retorno já executado segura a inscrição NOVA (issue #2907)", () => {
  it("⭐ disparado há 2 h ainda segura; vivo segura; fora da folga e ainda não vencido NÃO seguram", async () => {
    const { admin } = fakeAdmin([
      // 1ª consulta: retornos VIVOS (agendados, `enabled=true`).
      [{ contact_id: "c-vivo", next_run_at: quando(-6 * HORA) }],
      // 2ª consulta: retornos já DISPARADOS. O fake devolve tudo — quem corta a
      // janela de um dia é a régua; o Postgres já corta antes (ver o teste seguinte).
      [
        { contact_id: "c-recente", next_run_at: quando(2 * HORA) },
        { contact_id: "c-antigo", next_run_at: quando(30 * HORA) },
        { contact_id: "c-desabilitado-antes-da-hora", next_run_at: quando(-3 * HORA) },
        { contact_id: null, next_run_at: quando(1 * HORA) },
      ],
    ]);

    const segura = await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org-1");

    expect(segura.has("c-vivo")).toBe(true);
    expect(segura.has("c-recente")).toBe(true);
    expect(segura.has("c-antigo")).toBe(false);
    expect(segura.has("c-desabilitado-antes-da-hora")).toBe(false);
    expect(segura.size).toBe(2);
  });

  it("a régua que o Postgres recebe: um dia de janela, e só o one-shot de retorno já disparado", async () => {
    const { admin, consultas } = fakeAdmin([
      [],
      [{ contact_id: "c-recente", next_run_at: quando(2 * HORA) }],
    ]);

    await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org-1");

    expect(consultas).toHaveLength(2);
    const chamadas = consultas[1]!;
    expect(chamadas[0]).toEqual({ metodo: "from", args: ["cron_jobs"] });
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["kind", "at"] });
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["job_kind", "followup_turn"] });
    // `situacaoDoRetorno` (retorno.ts): disparado é `enabled=false` SEM
    // `cancelled_at` e SEM `last_error` (o one-shot que a org parada desligou
    // grava `last_error='org_nao_operante'`; cancelar grava `cancelled_at`).
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["enabled", false] });
    expect(chamadas).toContainEqual({ metodo: "is", args: ["cancelled_at", null] });
    expect(chamadas).toContainEqual({ metodo: "is", args: ["last_error", null] });
    // O turno de um passo de fluxo mora na mesma tabela e no mesmo job_kind;
    // contá-lo faria cada fluxo segurar a si mesmo.
    expect(chamadas).toContainEqual({ metodo: "is", args: ["payload->>followup_enrollment_id", null] });

    const corte = chamadas.find((c) => c.metodo === "gt" && c.args[0] === "next_run_at");
    expect(corte, "a consulta precisa cortar o retorno disparado fora da folga").toBeDefined();
    const limite = Date.parse(String(corte!.args[1]));
    expect(Math.abs(AGORA - FOLGA_DEPOIS_DO_RETORNO_MS - limite)).toBeLessThan(30_000);

    const naoVencido = chamadas.find((c) => c.metodo === "lte" && c.args[0] === "next_run_at");
    expect(naoVencido, "retorno ainda no futuro não saiu — não pode segurar").toBeDefined();
    expect(Math.abs(AGORA - Date.parse(String(naoVencido!.args[1])))).toBeLessThan(30_000);
  });

  it("controle: sem retorno nenhum, ninguém é segurado", async () => {
    const { admin } = fakeAdmin([[], []]);
    const segura = await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org-1");
    expect(segura.size).toBe(0);
  });
});

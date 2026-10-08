import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "supabase");
const MIGRATIONS = join(RAIZ, "migrations");
const ARQUIVO = readdirSync(MIGRATIONS).find((name) =>
  /^\d{14}_0605_lembretes_em_todos_os_casos\.sql$/.test(name),
);
if (!ARQUIVO) throw new Error("Migration 0604 dos lembretes para todos os casos ausente");

const SQL = readFileSync(join(MIGRATIONS, ARQUIVO), "utf8");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
const MARCADOR = "-- ---- lembretes em todos os casos que aguardam a equipe (migration 0605) ----";

function funcao(texto: string, nome: string, proximo: string): string {
  const inicio = texto.indexOf(`create or replace function public.${nome}(`);
  expect(inicio, `função ${nome} ausente`).toBeGreaterThan(-1);
  const fim = texto.indexOf(proximo, inicio);
  expect(fim, `fim da função ${nome} ausente`).toBeGreaterThan(inicio);
  return texto.slice(inicio, fim);
}

describe("lembretes configuráveis para todos os casos", () => {
  it("mantém a migration e o apêndice idempotente do baseline em sincronia", () => {
    const inicio = BASELINE.lastIndexOf(MARCADOR);
    expect(inicio, "apêndice final da migration 0605 ausente").toBeGreaterThan(-1);
    expect(BASELINE.slice(inicio + MARCADOR.length).trim()).toBe(SQL.trim());
    expect(SQL.split("\n", 1)[0]).toMatch(/^-- manifest:/);
  });

  it("seleciona casos gerais em espera e preserva a regra das tarefas financeiras", () => {
    const processador = funcao(
      SQL,
      "fn_processar_lembretes_tarefa",
      "revoke execute on function public.fn_processar_lembretes_tarefa",
    );
    expect(processador).toMatch(/task_kind in \('payment_details','payment_review'\)/i);
    expect(processador).toMatch(/task_state in \('awaiting_human','send_failed'\)/i);
    expect(processador).toMatch(
      /task_kind is null[\s\S]*?task_state is null[\s\S]*?status = 'awaiting_human'/i,
    );
    expect(processador).toMatch(/wait_started_at is not null/i);
    expect(processador).toMatch(/for update of ac skip locked/i);
    expect(processador).toMatch(/max\(marco\.minuto\)/i);
    expect(processador).toMatch(/ai\.case_task_reminder_due/);
    expect(processador).toMatch(/i\.ref_id = c\.id[\s\S]*?i\.status = 'open'/i);
  });

  it("backfill usa a abertura ou a resposta do cliente, e o trigger pausa ou encerra o alerta", () => {
    expect(SQL).toMatch(
      /max\(e\.created_at\)[\s\S]*?e\.kind = 'lead_provided'[\s\S]*?c\.opened_at/i,
    );
    expect(SQL).toMatch(
      /c\.task_kind is null[\s\S]*?c\.status = 'awaiting_human'[\s\S]*?c\.wait_started_at is null/i,
    );
    expect(SQL).not.toMatch(/set wait_started_at[\s\S]{0,500}updated_at/);

    const trigger = funcao(
      SQL,
      "fn_encerrar_lembrete_tarefa",
      "revoke execute on function public.fn_encerrar_lembrete_tarefa",
    );
    expect(trigger).toMatch(
      /new\.task_kind is null[\s\S]*?new\.task_state is null[\s\S]*?new\.status = 'awaiting_human'/i,
    );
    expect(trigger).toMatch(/new\.wait_generation is distinct from old\.wait_generation/i);
    expect(trigger).toMatch(/set status = 'resolved'/i);
    expect(SQL).toMatch(
      /create index if not exists agent_cases_task_wait_idx[\s\S]*?status in \('awaiting_human','awaiting_lead'\)/i,
    );
  });
});

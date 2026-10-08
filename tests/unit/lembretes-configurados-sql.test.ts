import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "supabase");
const MIGRATIONS = join(RAIZ, "migrations");
const ARQUIVO = readdirSync(MIGRATIONS).find((name) =>
  /^\d{14}_0604_configuracao_de_cadencia_de_lembretes_equipe\.sql$/.test(name),
);
if (!ARQUIVO) throw new Error("Migration 0603 da cadência configurável ausente");

const SQL = readFileSync(join(MIGRATIONS, ARQUIVO), "utf8");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
const CONSTRAINT = "case_task_reminders_minute_range_check";

function funcao(texto: string, nome: string, proximo: string): string {
  const inicio = texto.indexOf(`create or replace function public.${nome}(`);
  expect(inicio, `função ${nome} ausente`).toBeGreaterThan(-1);
  const fim = texto.indexOf(proximo, inicio);
  expect(fim, `fim da função ${nome} ausente`).toBeGreaterThan(inicio);
  return texto.slice(inicio, fim);
}

function checkDeMinuto(texto: string) {
  const inicio = texto.lastIndexOf(`add constraint ${CONSTRAINT}`);
  expect(inicio, `${CONSTRAINT} ausente`).toBeGreaterThan(-1);
  expect(texto.slice(inicio, inicio + 180)).toMatch(
    /check\s*\(\s*minute\s+between\s+1\s+and\s+1440\s*\)/i,
  );
}

describe("cadência configurável dos lembretes no SQL", () => {
  it("adiciona o opt-in de reforços de forma aditiva, preservando valores existentes", () => {
    const marcador = "-- ---- configuração de cadência dos lembretes (migration 0604) ----";
    const inicio = BASELINE.lastIndexOf(marcador);
    expect(inicio, "apêndice final da migration 0604 ausente").toBeGreaterThan(-1);
    const baselineFinal = BASELINE.slice(inicio);
    const ddl =
      /add column if not exists repetir_lembretes_whatsapp boolean not null default false/i;

    expect(SQL).toMatch(ddl);
    expect(baselineFinal).toMatch(ddl);
    // ADD COLUMN IF NOT EXISTS conserva o opt-in já armazenado; não se deve
    // sobrescrever a configuração de organizações existentes.
    const setup = SQL.slice(0, SQL.indexOf("-- Sem conexão"));
    expect(setup).not.toMatch(
      /update\s+public\.config_aviso_de_caso[\s\S]*?set\s+repetir_lembretes_whatsapp/i,
    );
  });

  it("troca o CHECK legado por uma faixa que admite minutos fora de 3/6/9", () => {
    const validador = funcao(
      SQL,
      "fn_minutos_lembrete_equipe_validos",
      "revoke all on function public.fn_minutos_lembrete_equipe_validos",
    );
    expect(validador).toMatch(/cardinality\(p_minutos\) not between 1 and 10/i);
    expect(validador).toMatch(/v_minuto < 1 or v_minuto > 1440 or v_minuto <= v_anterior/i);

    expect(SQL).toMatch(/drop constraint if exists case_task_reminders_minute_check/i);
    checkDeMinuto(SQL);
    checkDeMinuto(BASELINE);

    const processador = funcao(
      SQL,
      "fn_processar_lembretes_tarefa",
      "revoke execute on function public.fn_processar_lembretes_tarefa",
    );
    expect(processador).toContain("cfg.minutos_lembrete_equipe");
    expect(processador).toMatch(/unnest\(marcos\)/i);
    expect(processador).toMatch(/make_interval\(mins\s*=>\s*marco\.minuto::integer\)/i);

    const setter = funcao(
      SQL,
      "fn_definir_aviso_de_caso_repeticao",
      "revoke all on function public.fn_definir_aviso_de_caso_repeticao",
    );
    expect(setter).toContain("p_minutos_lembrete_equipe smallint[]");
    expect(setter).toContain("fn_minutos_lembrete_equipe_validos(p_minutos_lembrete_equipe)");
  });

  it("promove apenas o recibo superado do marco atual e preserva evento já vinculado", () => {
    const processador = funcao(
      SQL,
      "fn_processar_lembretes_tarefa",
      "revoke execute on function public.fn_processar_lembretes_tarefa",
    );
    expect(processador).toMatch(/not exists\s*\([\s\S]*?and r\.result = 'notified'\s*\)/i);
    expect(processador).toMatch(/on conflict[\s\S]*?do update[\s\S]*?set result = 'notified'/i);
    expect(processador).toMatch(
      /where lembrete_atual\.result = 'superseded'[\s\S]*?lembrete_atual\.minute = patamar/i,
    );
    expect(processador).toMatch(
      /select r\.whatsapp_event_id[\s\S]*?if evento_whatsapp is null then/i,
    );
    const inicioUpsert = processador.indexOf(
      "insert into public.case_task_reminders as lembrete_atual",
    );
    const fimUpsert = processador.indexOf(
      "select coalesce(cfg.repetir_lembretes_whatsapp",
      inicioUpsert,
    );
    expect(inicioUpsert).toBeGreaterThan(-1);
    expect(fimUpsert).toBeGreaterThan(inicioUpsert);
    expect(processador.slice(inicioUpsert, fimUpsert)).not.toMatch(/set\s+whatsapp_event_id\s*=/i);
  });
});

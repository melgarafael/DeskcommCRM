/**
 * A CONFERÊNCIA DE PROFISSIONAL DA AGENDA NÃO CONSULTA `pg_timezone_names`.
 *
 * `fn_calendar_service_person_available` roda uma vez POR PROFISSIONAL e POR
 * HORÁRIO dentro de `fn_calendar_service_check`. Até a migration 9500 ela
 * abria com
 *
 *     if not exists(select 1 from pg_timezone_names where name=zone) then return false;end if;
 *
 * e `pg_timezone_names` é uma visão que lê o catálogo de fusos do sistema
 * inteiro a cada chamada. Medido numa VPS (1.126.0, 26/11/2026): 63 ms a
 * consulta, contra 1 ms do `at time zone` que vem logo depois; a função caiu de
 * ~70 ms para ~1–12 ms sem a linha. Com 7 profissionais num serviço, a semana
 * passava do statement timeout — `crm_find_free_slots` voltava vazio e o agente
 * respondia "vou confirmar e volto" em vez de oferecer horário.
 *
 * A consulta era desnecessária para o caso comum: com um fuso Área/Local inválido o `at time zone` levanta 22023
 * (`invalid_parameter_value`, classe `data_exception`), e o handler da própria
 * função (`exception when invalid_text_representation or data_exception then
 * return false`) já devolve `false`. As outras formas continuam passando pelo
 * catálogo: `-03:00`, que a API aceita, seria lido pelo `at time zone` como
 * POSIX, com o sinal invertido (UTC+3), e a agenda ofereceria horário errado.
 *
 * ## Por que estático
 *
 * No baseline vale a ÚLTIMA definição (`create or replace` em ordem): este teste
 * lê essa, como o instalador aplica. Ele reprova se um apêndice futuro copiar um
 * corpo antigo da função e trouxer a consulta de volta. O comportamento com fuso
 * inválido e o tempo são medidos no banco, não aqui.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");
const CRIA = /^create or replace function public\.fn_calendar_service_person_available\(/gim;

function ultimaDefinicao(sql: string): string {
  const posicoes = [...sql.matchAll(CRIA)].map((m) => m.index);
  const inicio = posicoes.at(-1);
  if (inicio === undefined) throw new Error("fn_calendar_service_person_available não está no baseline");
  const abre = sql.indexOf("$$", inicio);
  const fecha = sql.indexOf("$$", abre + 2);
  return sql.slice(inicio, fecha + 2);
}

describe("agenda: conferência de profissional sem pg_timezone_names", () => {
  const corpo = ultimaDefinicao(readFileSync(BASELINE, "utf8"));

  it("só consulta a visão de fusos quando o nome não tem o formato Área/Local", () => {
    expect(corpo.match(/pg_timezone_names/gi)).toHaveLength(1);
    expect(corpo).toMatch(
      /if zone !~ '\^\[A-Za-z_\]\+\(\/\[A-Za-z0-9_\+-\]\+\)\+\$' then\s+if not exists\(select 1 from pg_timezone_names where name=zone\) then return false;end if;/,
    );
  });

  it("fuso inválido segue caindo no handler que devolve false", () => {
    expect(corpo).toMatch(/at time zone zone/i);
    expect(corpo).toMatch(/exception when invalid_text_representation or data_exception then return false/i);
  });
});

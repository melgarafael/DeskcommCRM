import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Toda chamada de API tem PRAZO para esperar uma trava.
 *
 * ## O incidente que fez este arquivo existir — produção, 2026-09-12
 *
 * `fn_meet_action` (o "Enviar link ao cliente") pede duas travas antes de
 * decidir. No Postgres, `lock_timeout` é **0 por padrão — esperar para sempre**.
 * O cliente HTTP do produto desiste em 10s (`DEFAULT_TIMEOUT_MS`). Juntas, as
 * duas coisas produzem um defeito que nenhuma tem sozinha:
 *
 *   1. a pessoa clica; a chamada entra na fila de uma trava e espera;
 *   2. aos 10s o navegador desiste e mostra "Erro inesperado. Tente novamente."
 *      — **sem identificador**, porque o erro é do navegador, não do servidor;
 *   3. a consulta **continua viva no banco**, ainda na fila;
 *   4. o botão volta a aceitar clique (o `isPending` do cliente já acabou);
 *   5. o clique seguinte empilha atrás da anterior.
 *
 * Medido: dez chamadas simultâneas, Postgres a **357% de CPU**, load 7,33 — num
 * servidor onde app e worker estavam em 0,16%. Cancelá-las devolveu o banco a
 * 1,47% em segundos.
 *
 * Três sintomas foram investigados por horas como problemas diferentes: o botão
 * que "não funciona", o erro genérico sem identificador, e a carga no banco.
 * Era um só.
 *
 * ## Por que o gate mede o PAPEL
 *
 * A primeira versão deste arquivo varria função por função, exigindo
 * `lock_timeout` no cabeçalho de cada uma. Ela achou **sete** irmãs com a mesma
 * forma — `fn_reply_action` (o "Aprovar e enviar" da sugestão de resposta),
 * `fn_mesclar_contatos`, `fn_reserve_channel_connection`,
 * `fn_set_channel_routing`, `fn_lgpd_anonymize_contact`, `fn_google_resolve` e
 * `fn_google_selection`.
 *
 * Sete conserto-a-conserto protegem as sete de hoje. O papel protege também as
 * que ainda não existem — e `lock_timeout` ausente não é uma linha errada que
 * alguém revisa, é uma linha que **não está lá**, que é o tipo de coisa que
 * ninguém vê faltando.
 */

/** `authenticator` é o papel de TODA requisição da API; ele faz `set role` sem reiniciar parâmetros. */
const PAPEIS_DE_API = ["authenticator", "authenticated"] as const;

/** Lê `rolconfig` — o que o banco realmente aplica, não o que o arquivo diz. */
function prazoDe(papel: string): string {
  return sql(`
    select coalesce(array_to_string(rolconfig, ','), '(sem config)')
      from pg_roles where rolname = '${papel}';
  `).trim();
}

function existe(papel: string): boolean {
  return sql(`select count(*) from pg_roles where rolname = '${papel}';`).trim() === "1";
}

/**
 * Os papéis presentes NESTE banco.
 *
 * ⚠️ `authenticator` existe no Supabase de verdade e **não** existe no Postgres
 * descartável desta suíte — o prelude cria só os papéis que o schema referencia.
 * Cobrar a presença dele aqui reprovaria a suíte inteira por uma diferença de
 * ambiente; ignorá-lo em silêncio deixaria o gate passar num banco sem papel
 * nenhum. O meio-termo é este: mede quem existe, e o caso abaixo garante que
 * "quem existe" nunca é uma lista vazia.
 */
const PRESENTES = PAPEIS_DE_API.filter(existe);

describe("prazo de trava nos papéis da API", () => {
  it("CONTROLE: há pelo menos um papel de API para medir", () => {
    // Guarda de vacuidade: sem ela, um banco sem nenhum dos papéis faria o
    // `for` abaixo não gerar caso algum — e um `describe` sem casos passa.
    expect(PRESENTES.length, `nenhum de ${PAPEIS_DE_API.join(", ")} existe neste banco`).toBeGreaterThan(0);
  });

  for (const papel of PRESENTES) {
    it(`⛔ ${papel} NÃO espera para sempre por uma trava`, () => {
      expect(
        prazoDe(papel),
        `O papel ${papel} está sem lock_timeout. No Postgres o padrão é 0 — esperar\n` +
          `para sempre. Chamado por uma tela que desiste em 10s, isso vira consulta\n` +
          `órfã segurando a fila, e o clique seguinte empilha atrás: foi assim que o\n` +
          `banco chegou a 357% de CPU em 2026-09-12. Ver a migration 0241.`,
      ).toMatch(/lock_timeout=/);
    });

    it(`o prazo de ${papel} é MENOR que a paciência do cliente`, () => {
      // 10s é o `DEFAULT_TIMEOUT_MS` do cliente HTTP. Um prazo de 30s no banco
      // seria pior que inútil: o navegador desistiria antes, a pessoa leria de
      // novo o erro genérico, e a única diferença seria a consulta morrer 20s
      // depois — sem ninguém ver o motivo. E menor demais recusaria operação
      // legítima, que leva milissegundos.
      const m = /lock_timeout=(\d+)(m?s)?/.exec(prazoDe(papel));
      expect(m, `sem lock_timeout legível em ${papel}`).not.toBeNull();
      const ms = m![2] === "ms" ? Number(m![1]) : Number(m![1]) * 1000;
      expect(ms, "curto demais: recusaria operação legítima").toBeGreaterThan(500);
      expect(ms, "longo demais: o navegador desiste antes da recusa chegar").toBeLessThan(10_000);
    });
  }

  it("⛔ o WORKER continua podendo esperar — `service_role` fica de fora", () => {
    // Controle no sentido OPOSTO, e ele é o que impede o conserto de virar um
    // defeito novo: trabalho de fundo não tem ninguém olhando a tela, e um job
    // de migração de dados que precise de trava por 30s é legítimo. Aplicar o
    // prazo a `service_role` faria o worker desistir de trabalho válido — o
    // erro em espelho, e o mais fácil de cometer copiando a linha de cima.
    expect(prazoDe("service_role")).not.toMatch(/lock_timeout=/);
  });
});

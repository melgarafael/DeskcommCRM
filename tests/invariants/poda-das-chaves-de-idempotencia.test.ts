/**
 * A PODA DAS CHAVES DE IDEMPOTÊNCIA NO BANCO REAL (#1613, item B).
 *
 * O teste estático (`tests/unit/poda-das-chaves-de-idempotencia.test.ts`)
 * confere o TEXTO da função. Aqui ela roda contra linhas reais e o que se mede
 * é quem sobrou:
 *
 *   - chave viva e chave vencida há pouco (dentro da folga de 1 dia) ficam —
 *     a vencida há pouco pode ser a reserva de um envio ainda gravando o
 *     recibo, e `lib/api/idempotency.ts` a reescreve no lugar;
 *   - vencida há mais que a folga sai, de qualquer organização (é a rotina da
 *     instalação, como as podas irmãs);
 *   - `p_retencao_dias` 0 ou nulo vale como 1 (o piso mora no CORPO);
 *   - `p_limite` limita o lote;
 *   - vencida há EXATAMENTE 1 dia fica (o corte é estrito);
 *   - o recibo da aprovação de pedido LGPD fica, em qualquer idade (aquela rota
 *     lê a chave sem olhar o vencimento);
 *   - quem chama é a service role (o papel do cron); `anon` e `authenticated`
 *     não executam;
 *   - linha que OUTRA sessão está reescrevendo (a reserva renovada de
 *     `lib/api/idempotency.ts`) não trava a poda nem é apagada: a poda pula a
 *     travada e apaga as outras. Sem o `for update skip locked`, ela esperaria
 *     a trava e cairia no `lock_timeout`.
 */
import { spawn } from "node:child_process";

import { beforeEach, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG_A = "16130001-0000-4000-8000-000000000001";
const ORG_B = "16130001-0000-4000-8000-000000000002";

/** O último número que o script imprimiu (`-tA` também imprime SET/BEGIN/COMMIT). */
function valor(consulta: string): number {
  const saida = sql(consulta).trim();
  const numero = saida
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^-?\d+$/.test(l))
    .at(-1);
  if (numero === undefined) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(numero);
}

function chavesQueRestam(): string[] {
  return sql(
    `select key from public.idempotency_keys where organization_id in ('${ORG_A}', '${ORG_B}') order by key;`,
  )
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^k-/.test(l));
}

/** Uma chave com o `expires_at` deslocado de `horas` (negativo = vencida). */
function chave(org: string, nome: string, horas: number, endpoint = "/api/v1/messages"): string {
  return `('${org}', '${nome}', '${endpoint}', '\\x00'::bytea, 201, '{}'::jsonb,
           now() - interval '3 days', now() + make_interval(hours => ${horas}))`;
}

/** Chama a função como o cron chama: pela service role. */
function podar(args: string): number {
  return valor(`set role service_role; select public.fn_expurgar_chaves_de_idempotencia_vencidas(${args}); reset role;`);
}

beforeEach(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'idem-1613-a', 'Idem 1613 A', 'Idem 1613 A'),
      ('${ORG_B}', 'idem-1613-b', 'Idem 1613 B', 'Idem 1613 B')
      on conflict do nothing;
    delete from public.idempotency_keys where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into public.idempotency_keys
      (organization_id, key, endpoint, request_hash, status_code, response_body, created_at, expires_at)
    values
      ${chave(ORG_A, "k-1-viva", 12)},
      ${chave(ORG_A, "k-2-vencida-ha-12h", -12)},
      ${chave(ORG_A, "k-3-vencida-ha-2-dias", -48)},
      ${chave(ORG_B, "k-4-outra-org-vencida-ha-2-dias", -48)},
      ${chave(ORG_A, "k-5-lgpd-vencida-ha-2-dias", -48, "/api/v1/lgpd/requests/x/approve")};
  `);
});

/**
 * Uma SEGUNDA sessão psql, em paralelo, como `psql-transporte` abre a primeira
 * (mesmo container ou mesmo binário, mesmo banco). Devolve quando ela termina.
 */
function outraSessao(script: string): Promise<string> {
  const container = process.env.TEST_DB_CONTAINER;
  const psqlLocal = process.env.TEST_DB_PSQL;
  const args = ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"];
  const [bin, todos] = psqlLocal
    ? [psqlLocal, [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres", ...args]]
    : ["docker", ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", "postgres", ...args]];
  return new Promise((resolve, reject) => {
    const filho = spawn(bin, todos);
    let saida = "";
    filho.stdout.on("data", (d) => (saida += String(d)));
    filho.on("error", reject);
    filho.on("close", (codigo) => (codigo === 0 ? resolve(saida) : reject(new Error(`psql saiu com ${codigo}`))));
    filho.stdin.end(script);
  });
}

describe("#1613 — fn_expurgar_chaves_de_idempotencia_vencidas", () => {
  it("a linha que outra sessão está renovando não trava a poda nem é apagada", async () => {
    // Sinal entre as sessões: a sessão A só fecha a transação (e solta a trava)
    // DEPOIS que a poda voltou — sem isso, um atraso do teste entre "vi a trava"
    // e "podei" deixaria A commitar antes e o teste passaria sem trava nenhuma.
    sql(`
      create table if not exists public.sinal_do_teste_1613 (pode_soltar boolean not null);
      delete from public.sinal_do_teste_1613;
    `);
    // A sessão A renova a k-3 (como a leitura faz com uma reserva vencida) e
    // segura a trava até o sinal (no máximo ~15 s, para nunca pendurar a suíte).
    const a = outraSessao(`
      begin;
      update public.idempotency_keys set expires_at = now() + interval '60 seconds'
       where organization_id = '${ORG_A}' and key = 'k-3-vencida-ha-2-dias';
      do $espera_1613$
      begin
        for i in 1..300 loop
          exit when exists (select 1 from public.sinal_do_teste_1613 where pode_soltar);
          perform pg_sleep(0.05);
        end loop;
      end $espera_1613$;
      commit;
    `);
    try {
      // Espera a trava da sessão A existir antes de podar.
      let travada = false;
      for (let i = 0; i < 100 && !travada; i++) {
        travada =
          valor(`
            select count(*) from pg_locks l join pg_stat_activity s on s.pid = l.pid
             where s.query like '%espera_1613%' and s.pid <> pg_backend_pid()
               and l.locktype = 'transactionid' and l.granted;
          `) > 0;
        if (!travada) await new Promise((r) => setTimeout(r, 100));
      }
      expect(travada, "a sessão A não chegou a travar a linha").toBe(true);
      // A poda não espera a trava: com 1 s de `lock_timeout`, esperar seria erro.
      const apagadas = valor(`
        set lock_timeout = '1s';
        set role service_role;
        select public.fn_expurgar_chaves_de_idempotencia_vencidas(1, 1000);
        reset role;
      `);
      expect(apagadas).toBe(1); // só a k-4, da outra organização
      // A trava AINDA estava lá quando a poda voltou.
      expect(
        valor(`
          select count(*) from pg_stat_activity
           where query like '%espera_1613%' and state = 'active' and pid <> pg_backend_pid();
        `),
      ).toBe(1);
    } finally {
      sql(`insert into public.sinal_do_teste_1613 values (true);`);
      await a;
      sql(`drop table if exists public.sinal_do_teste_1613;`);
    }
    expect(chavesQueRestam()).toEqual([
      "k-1-viva",
      "k-2-vencida-ha-12h",
      "k-3-vencida-ha-2-dias",
      "k-5-lgpd-vencida-ha-2-dias",
    ]);
  }, 30_000);

  it("CONTROLE POSITIVO: a função existe e devolve inteiro", () => {
    expect(podar("1, 1000")).toBeGreaterThanOrEqual(0);
  });

  it("apaga só o que venceu há mais de 1 dia, de qualquer organização — e não o recibo LGPD", () => {
    expect(podar("1, 1000")).toBe(2);
    expect(chavesQueRestam()).toEqual(["k-1-viva", "k-2-vencida-ha-12h", "k-5-lgpd-vencida-ha-2-dias"]);
  });

  it("vencida há exatamente 1 dia fica (o corte é estrito)", () => {
    // Na MESMA transação, `now()` é o mesmo instante na semente e na poda.
    const restou = valor(`
      begin;
      update public.idempotency_keys set expires_at = now() - interval '1 day'
       where organization_id = '${ORG_A}' and key = 'k-2-vencida-ha-12h';
      set local role service_role;
      select public.fn_expurgar_chaves_de_idempotencia_vencidas(1, 1000);
      reset role;
      select count(*) from public.idempotency_keys
       where organization_id = '${ORG_A}' and key = 'k-2-vencida-ha-12h';
      commit;
    `);
    expect(restou).toBe(1);
  });

  it("piso no corpo: 0, nulo e omitido valem como 1 dia", () => {
    podar("0, 1000");
    expect(chavesQueRestam()).toContain("k-2-vencida-ha-12h");
    podar("null, null");
    expect(chavesQueRestam()).toContain("k-2-vencida-ha-12h");
    podar("");
    expect(chavesQueRestam()).toEqual(["k-1-viva", "k-2-vencida-ha-12h", "k-5-lgpd-vencida-ha-2-dias"]);
  });

  it("o lote limita quantas saem por chamada", () => {
    expect(podar("1, 1")).toBe(1);
    expect(chavesQueRestam()).toHaveLength(4);
  });

  it("só a service role executa", () => {
    for (const papel of ["authenticated", "anon"]) {
      expect(
        valor(
          `select case when has_function_privilege('${papel}', 'public.fn_expurgar_chaves_de_idempotencia_vencidas(int, int)', 'execute') then 1 else 0 end;`,
        ),
      ).toBe(0);
    }
    expect(
      valor(
        `select case when has_function_privilege('service_role', 'public.fn_expurgar_chaves_de_idempotencia_vencidas(int, int)', 'execute') then 1 else 0 end;`,
      ),
    ).toBe(1);
  });
});

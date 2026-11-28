/**
 * A POLÍTICA DE RETENÇÃO ALCANÇA `idempotency_keys` (#1613, item B — a parte
 * que o #4850 deixou fora).
 *
 * O #4850 fez o `expires_at` valer na leitura; a limpeza das chaves vencidas
 * "na rotina de retenção" ficou para depois, e "nenhum código do repositório
 * apaga linha de `idempotency_keys`; a tabela só cresce". Cada envio por REST
 * ou pelas ferramentas do MCP com chave deixa uma linha — com o recibo da
 * resposta (`response_body`) dentro — que ninguém lê depois de 24 h.
 *
 * O que este arquivo prende (o banco real fica com
 * `tests/invariants/poda-das-chaves-de-idempotencia.test.ts`):
 *
 *   1. o cron diário chama `fn_expurgar_chaves_de_idempotencia_vencidas` em
 *      lotes, com a folga de 1 dia depois do vencimento (a mesma da poda dos
 *      nonces de OAuth), até um lote vir incompleto;
 *   2. o que apagou entra no relatório e conta como efeito (sem isso, uma
 *      rodada que só podou chaves não deixaria trilha);
 *   3. a falha dela é nomeada e não derruba as outras podas;
 *   4. a função nasce numa migration e no apêndice do baseline, com piso no
 *      corpo, `security definer` com `search_path` fixo e EXECUTE só para a
 *      service role.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_LOTES,
  type PodaDb,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
} from "@/app/api/v1/cron/data-retention/route";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const FUNCAO = "fn_expurgar_chaves_de_idempotencia_vencidas";

function dbFalso(lotesDaChave: number[], erro = false, falhaNoLote?: number) {
  const chamadas: Array<{ nome: string; dias: number; limite: number }> = [];
  const restante = [...lotesDaChave];
  const db: PodaDb = {
    async rpc(nome, args) {
      chamadas.push({ nome, dias: args.p_retencao_dias, limite: args.p_limite });
      if ((nome as string) !== FUNCAO) return { data: 0, error: null };
      if (erro) return { data: null, error: { message: "permission denied (dublê)" } };
      const lote = chamadas.filter((c) => c.nome === FUNCAO).length;
      if (falhaNoLote !== undefined && lote >= falhaNoLote) {
        return { data: null, error: { message: "timeout (dublê)" } };
      }
      return { data: restante.shift() ?? 0, error: null };
    },
    async apagarRascunhos() {
      return { data: 0, error: null };
    },
    async enfileirarMidia() {
      return { data: { vencidas: 0, orfas: 0 } as never, error: null };
    },
  };
  return { db, chamadas };
}

describe("#1613 — o cron diário poda as chaves de idempotência vencidas", () => {
  it("chama a função em lotes, com 1 dia de folga, até um lote vir incompleto", async () => {
    const { db, chamadas } = dbFalso([TAMANHO_DO_LOTE, TAMANHO_DO_LOTE, 7]);
    const r = (await podarHistorico(db, {})) as unknown as Record<string, unknown>;
    const daChave = chamadas.filter((c) => c.nome === FUNCAO);
    expect(daChave).toHaveLength(3);
    expect(daChave.every((c) => c.dias === 1 && c.limite === TAMANHO_DO_LOTE)).toBe(true);
    expect(r.chaves_de_idempotencia_apagadas).toBe(2 * TAMANHO_DO_LOTE + 7);
    expect(r.lotes_chaves_de_idempotencia).toBe(3);
    expect(r.chaves_de_idempotencia_tem_resto).toBe(false);
  });

  it("backlog: para no teto de lotes da rodada e declara que sobrou", async () => {
    const { db, chamadas } = dbFalso(Array(MAX_LOTES + 5).fill(TAMANHO_DO_LOTE));
    const r = (await podarHistorico(db, {})) as unknown as Record<string, unknown>;
    expect(chamadas.filter((c) => c.nome === FUNCAO)).toHaveLength(MAX_LOTES);
    expect(r.chaves_de_idempotencia_apagadas).toBe(MAX_LOTES * TAMANHO_DO_LOTE);
    expect(r.chaves_de_idempotencia_tem_resto).toBe(true);
  });

  it("falha no segundo lote: o que o primeiro apagou fica no relatório, com a falha nomeada", async () => {
    const { db } = dbFalso([TAMANHO_DO_LOTE, TAMANHO_DO_LOTE], false, 2);
    const r = (await podarHistorico(db, {})) as unknown as Record<string, unknown> & { falhas: string[] };
    expect(r.chaves_de_idempotencia_apagadas).toBe(TAMANHO_DO_LOTE);
    expect(r.falhas.some((f) => f.startsWith(`${FUNCAO}: `))).toBe(true);
    expect(houveEfeito(r as never)).toBe(true);
  });

  it("rodada que só podou chaves conta como efeito (deixa a trilha)", async () => {
    const { db } = dbFalso([3]);
    const r = await podarHistorico(db, {});
    expect(houveEfeito(r)).toBe(true);
  });

  it("a falha da poda das chaves é nomeada e as outras podas seguem", async () => {
    const { db, chamadas } = dbFalso([], true);
    const r = await podarHistorico(db, {});
    expect(r.falhas.some((f) => f.includes(FUNCAO))).toBe(true);
    // As irmãs continuam sendo chamadas na mesma rodada.
    expect(chamadas.some((c) => c.nome === "fn_expurgar_nonces_de_oauth")).toBe(true);
    expect(chamadas.some((c) => c.nome === "fn_podar_fila_de_jobs")).toBe(true);
  });
});

describe("#1613 — a função nasce na migration e no baseline", () => {
  const raiz = process.cwd();
  const pasta = join(raiz, "supabase/migrations");
  const migracoes = readdirSync(pasta).filter((f) => f.endsWith(".sql"));
  const daChave = migracoes.filter((f) => readFileSync(join(pasta, f), "utf8").includes(FUNCAO));
  const baseline = readFileSync(join(raiz, "supabase/baseline.sql"), "utf8");

  it("uma migration declara a função, com o cabeçalho -- manifest:", () => {
    expect(daChave).toHaveLength(1);
    const texto = readFileSync(join(pasta, daChave[0]!), "utf8");
    expect(texto.split("\n")[0]).toMatch(/^-- manifest: /);
  });

  it.each([
    ["migration", () => readFileSync(join(pasta, daChave[0]!), "utf8")],
    ["baseline", () => baseline],
  ])("no %s: security definer, search_path fixo, piso no corpo, EXECUTE só da service role", (_onde, ler) => {
    const texto = ler();
    const inicio = texto.lastIndexOf(`create or replace function public.${FUNCAO}(`);
    expect(inicio).toBeGreaterThan(-1);
    // Sem os comentários: a explicação do `for update skip locked` repete as
    // palavras, e o teste tem de olhar só o SQL que roda.
    const corpo = texto
      .slice(inicio, texto.indexOf("$$;", inicio) + 3)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((linha) => linha.replace(/--.*$/, ""))
      .join("\n");
    expect(corpo).toMatch(/security definer/);
    expect(corpo).toMatch(/set search_path to 'public', 'pg_temp'/);
    expect(corpo).toMatch(/p_retencao_dias is null or p_retencao_dias < 1/);
    expect(corpo).toMatch(/expires_at < now\(\) - make_interval\(days => p_retencao_dias\)/);
    // A linha travada por quem a reescreve não é apagada; o vencimento é
    // conferido de novo no `delete`; o recibo da aprovação LGPD fica fora.
    expect(corpo).toMatch(/for update skip locked/);
    expect(corpo).toMatch(/and k\.expires_at < now\(\) - make_interval\(days => p_retencao_dias\)/);
    expect(corpo).toMatch(/endpoint not like '\/api\/v1\/lgpd\/%'/);
    const resto = texto.slice(inicio);
    expect(resto).toMatch(
      new RegExp(`revoke execute on function public\\.${FUNCAO}\\(int, int\\) from public, anon, authenticated;`),
    );
    expect(resto).toMatch(new RegExp(`grant execute on function public\\.${FUNCAO}\\(int, int\\) to service_role;`));
  });
});

/**
 * "Não são a mesma empresa" — a dispensa de um par de fichas sugerido pelo NOME
 * (Spec 31, PR A).
 *
 * ─── Onde fica a dispensa ───────────────────────────────────────────────────────
 * Em `merge_queue` (C14 da Spec 31): `status = 'discarded'`, `reason =
 * 'nao_sao_a_mesma'`, `candidates` = os dois ids em ordem crescente. A tabela já
 * existe no baseline e ninguém a lia nem escrevia; esta é a primeira leitura e a
 * primeira gravação. Sem migration: a idempotência é do código, não de um índice.
 *
 * ─── Por que SQL direto, e não o cliente do usuário ─────────────────────────────
 * A policy de `merge_queue` deixa só gestor ler (C17). O PAR dispensado precisa
 * sumir da lista para TODOS os papéis que a veem, então a leitura da lista usa o
 * cliente administrador (`lerParesDispensados`), filtrado pela organização da
 * sessão. A gravação vai por `pg` com transação e trava: uma sessão pelo PostgREST
 * não teria como travar o par.
 *
 * ─── Por que a trava ───────────────────────────────────────────────────────────
 * Dispensar o mesmo par duas vezes, ou ao mesmo tempo, não pode gravar duas linhas.
 * A trava é de transação (`pg_advisory_xact_lock`) por organização e par: a segunda
 * chamada espera a primeira comitar e então enxerga a linha. A sabotagem disso
 * (tirar a trava) deixa o caso de concorrência de
 * `tests/invariants/dispensar-par-de-contatos.test.ts` vermelho.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ligadosPorMotivoForte, parDeContatos } from "./duplicados";

export type ResultadoDaDispensa =
  | { ok: true; criada: boolean; candidatos: [string, string] }
  | { ok: false; motivo: "nao_encontrado" | "par_forte" };

/** O motivo gravado em `merge_queue.reason`. Não é rótulo de tela: é chave de leitura. */
const MOTIVO_DA_DISPENSA = "nao_sao_a_mesma";

/** Teto das dispensas lidas. Passou daqui, o par mais novo pode voltar à lista — o que é raro e fica dito aqui. */
const TETO_DE_DISPENSAS = 5000;
const TAMANHO_DA_PAGINA_DE_DISPENSAS = 1000;
/** Lotes de `in("id", …)`: cada id custa ~37 caracteres na URL do PostgREST; 100 ficam perto de 4 KB, abaixo do limite comum de 8 KB de um proxy. */
const LOTE_DE_CONTATOS = 100;
/** Quantas vezes seguir `is_merged_into` na leitura: a cadeia real é curta. */
const SALTOS_DE_FUSAO = 5;

interface LinhaDeContato {
  id: string;
  phone_number: string | null;
  email: string | null;
  email_normalized: string | null;
  source_metadata: Record<string, unknown> | null;
}

/**
 * Grava a dispensa de um par, sob trava, dentro da organização da sessão.
 *
 * A organização vem do chamador (a sessão), nunca do corpo: o filtro é o de
 * `organization_id` em TODA leitura de `contacts`. Um id de outra organização não
 * casa, e o retorno é `nao_encontrado` — sem gravar nada.
 */
export async function dispensarParDeContatos(
  pool: pg.Pool,
  args: { organizationId: string; contactIds: [string, string]; userId: string },
): Promise<ResultadoDaDispensa> {
  const org = args.organizationId;
  const [a, b] = args.contactIds.map((id) => id.toLowerCase()).sort() as [string, string];
  const candidatos: [string, string] = [a, b];

  const db = await pool.connect();
  // Mesmo padrão de `withProspectingLock` (lib/prospecting/store.ts, #2624): cliente
  // com erro é liberado COM o erro, para o pg-pool destruí-lo em vez de reemprestá-lo.
  let erroNaTransacao: Error | undefined;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `merge_queue:${MOTIVO_DA_DISPENSA}:${org}:${a}:${b}`,
    ]);

    const { rows } = await db.query<LinhaDeContato>(
      `select id, phone_number, email, email_normalized, source_metadata
         from public.contacts
        where organization_id = $1
          and id = any($2::uuid[])
          and is_merged_into is null
          and not is_anonymized`,
      [org, [a, b]],
    );
    const porId = new Map(rows.map((linha) => [linha.id, linha] as const));
    const ra = porId.get(a);
    const rb = porId.get(b);
    if (!ra || !rb) {
      await db.query("rollback");
      return { ok: false, motivo: "nao_encontrado" };
    }

    if (ligadosPorMotivoForte(ra, rb)) {
      await db.query("rollback");
      return { ok: false, motivo: "par_forte" };
    }

    const existe = await db.query(
      `select 1 from public.merge_queue
        where organization_id = $1
          and status = 'discarded'
          and reason = 'nao_sao_a_mesma'
          and candidates = $2::uuid[]
        limit 1`,
      [org, [a, b]],
    );
    if (existe.rows.length > 0) {
      await db.query("commit");
      return { ok: true, criada: false, candidatos };
    }

    await db.query(
      `insert into public.merge_queue
         (organization_id, candidates, reason, status, resolved_by_user_id, resolved_at, trigger_payload)
       values ($1, $2::uuid[], 'nao_sao_a_mesma', 'discarded', $3, now(), '{}'::jsonb)`,
      [org, [a, b], args.userId],
    );
    await db.query("commit");
    return { ok: true, criada: true, candidatos };
  } catch (err) {
    erroNaTransacao = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    db.release(erroNaTransacao);
  }
}

/**
 * A ficha VIVA em que `id` virou, seguindo `is_merged_into` por até 5 saltos.
 *
 * Ciclo ou excesso de saltos devolve o último id visto — nunca um laço infinito.
 * Id fora do mapa (ou com `null`) já é ficha viva ou desconhecida: fica como está.
 */
export function fichaVivaDe(id: string, mapa: ReadonlyMap<string, string | null>): string {
  let atual = id;
  const vistos = new Set<string>([id]);
  for (let salto = 0; salto < SALTOS_DE_FUSAO; salto++) {
    const proximo = mapa.get(atual);
    if (!proximo) return atual;
    if (vistos.has(proximo)) return atual;
    vistos.add(proximo);
    atual = proximo;
  }
  return atual;
}

/**
 * As dispensas da organização, como o Set de `parDeContatos` das fichas VIVAS em que
 * cada id virou. Depois de uma fusão, a dispensa continua valendo para o par.
 *
 * Lido com o cliente administrador e filtrado pela organização da sessão: a policy
 * de `merge_queue` só deixa gestor ler, e o par dispensado precisa sumir para todo
 * papel que vê a lista.
 */
export async function lerParesDispensados(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  // Paginação pelo deslocamento ACUMULADO, não por número de página: com `max_rows`
  // menor que a página, `range(1000, 1999)` pularia linhas que o servidor não devolveu.
  const pares: string[][] = [];
  while (pares.length < TETO_DE_DISPENSAS) {
    const inicio = pares.length;
    const { data, error } = await admin
      .from("merge_queue")
      .select("id, candidates")
      .eq("organization_id", organizationId)
      .eq("status", "discarded")
      .eq("reason", MOTIVO_DA_DISPENSA)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(inicio, inicio + TAMANHO_DA_PAGINA_DE_DISPENSAS - 1);
    if (error) throw new Error(error.message);
    const lote = (data ?? []) as Array<{ candidates: string[] }>;
    if (lote.length === 0) break;
    for (const linha of lote) pares.push(linha.candidates);
  }

  const mapa = new Map<string, string | null>();
  let pendentes = [...new Set(pares.flat())];
  for (let rodada = 0; rodada < SALTOS_DE_FUSAO && pendentes.length > 0; rodada++) {
    const proximos = new Set<string>();
    for (let i = 0; i < pendentes.length; i += LOTE_DE_CONTATOS) {
      const lote = pendentes.slice(i, i + LOTE_DE_CONTATOS);
      const { data, error } = await admin
        .from("contacts")
        .select("id, is_merged_into")
        .eq("organization_id", organizationId)
        .in("id", lote);
      if (error) throw new Error(error.message);
      for (const linha of (data ?? []) as Array<{ id: string; is_merged_into: string | null }>) {
        mapa.set(linha.id, linha.is_merged_into);
        if (linha.is_merged_into && !mapa.has(linha.is_merged_into)) {
          proximos.add(linha.is_merged_into);
        }
      }
    }
    pendentes = [...proximos];
  }

  const dispensados = new Set<string>();
  for (const par of pares) {
    const [a, b] = par;
    if (!a || !b) continue;
    const vivaA = fichaVivaDe(a, mapa);
    const vivaB = fichaVivaDe(b, mapa);
    if (vivaA === vivaB) continue;
    dispensados.add(parDeContatos(vivaA, vivaB));
  }
  return dispensados;
}

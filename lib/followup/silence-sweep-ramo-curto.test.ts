import { describe, expect, it } from "vitest";

import { runSilenceSweep, type SilenceSweepDb, type SilenceSweepSummary } from "./silence-sweep";

/**
 * O RAMO CURTO NÃO RE-ENROLA NO TIQUE SEGUINTE (issue #529).
 *
 * ─── A premissa que a issue derrubou ────────────────────────────────────────
 * A varredura de silêncio supunha que um enrollment durasse DIAS ("aceitável no
 * MVP, sem cooldown table"). Mas todo nó que não é `wait` devolve
 * `next_eval_at: clock()` (`node-handlers.ts`), então o enrollment fica vencido
 * no mesmo instante: um caminho `trigger → condition → fim` completa em ~3
 * minutos. Com a varredura rodando a cada minuto, o ciclo era
 *
 *     varredura inscreve → 3 min andando os nós → completed → varredura seguinte
 *
 * ou seja, ~1 enrollment novo a cada 4 minutos, para sempre — não a cada
 * `threshold_minutes`.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 * A guarda que fechou o buraco já está no produto: um contato com enrollment
 * TERMINADO deste pointer há menos de `threshold_minutes` não é reinscrito
 * (`silence-sweep.ts:383-388`, com o predicado em `:798-810`). O que faltava era
 * a prova COMPORTAMENTAL, ao longo de tiques e com relógio falso: as suítes
 * existentes ou trocam `loadContactIdsEmCooldown` por um Set pronto
 * (`silence-sweep-cooldown.test.ts`, que não mede o corte) ou usam `now()` de
 * verdade no Postgres (invariantes, que não conseguem andar 200 minutos). Aqui
 * o MESMO mundo roda duas vezes — com a guarda e sem ela — e a diferença entre
 * as contagens é o custo do defeito, medido.
 *
 * O predicado do cooldown no dublê é o da produção, escrito uma vez:
 * `status` terminal deste pointer ∧ `updated_at >= (agora − threshold_minutes)`.
 * O que ele NÃO copia é a query: quem prova que a produção pede `updated_at` e
 * exclui os status vivos é `silence-sweep-cooldown-query.test.ts`.
 *
 * ⚠️ Relógio falso de ponta a ponta: `agora` avança minuto a minuto e o dublê
 * não lê `Date.now()` em lugar nenhum — se lesse, o caso mediria a máquina.
 */

const THRESHOLD_MINUTOS = 120;
/** Duração do ramo curto: trigger → condition → fim, sem `wait` (~3 tiques do cron). */
const DURACAO_DO_RAMO_MINUTOS = 3;
/** Quantos minutos de cron a simulação percorre. */
const JANELA_MINUTOS = 200;
/** Início da simulação, fixo. */
const T0 = Date.parse("2026-09-25T12:00:00.000Z");

const MIN = 60_000;

interface Inscricao {
  contact_id: string;
  status: "active" | "completed";
  /** Quando o motor terminaria o ramo curto (só para as vivas). */
  completa_em: number | null;
  /** O fim da tentativa (`completed_at`/`updated_at`, o mesmo commit no motor). */
  updated_at: number;
}

/**
 * O mundo: um contato silencioso, um pointer de silêncio e a tabela de
 * enrollments em memória. `agora` é mutável — é o "tempo falso".
 */
function mundo(opts: { comGuarda: boolean }) {
  const agora = { ms: T0 };
  const inscricoes: Inscricao[] = [];

  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [
      {
        id: "pointer-1",
        organization_id: "org-1",
        active_version_id: "version-1",
        threshold_minutes: THRESHOLD_MINUTOS,
        segments: [],
      },
    ],
    // O contato escreveu há muito tempo e nunca mais: silencioso em TODO tique.
    loadSilentContactIds: async (_org, cutoffIso) =>
      T0 - 300 * MIN <= Date.parse(cutoffIso) ? ["contato-a"] : [],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadTriggerNode: async () => ({ id: "no-trigger", pedeAgente: false }),
    loadContactIdsEmCooldown: async (_org, _pointer, contactIds, cutoffIso) => {
      if (!opts.comGuarda) return new Set<string>(); // CONTROLE: o mundo sem a guarda do #529
      const corte = Date.parse(cutoffIso);
      return new Set(
        inscricoes
          .filter(
            (i) =>
              contactIds.includes(i.contact_id) &&
              i.status !== "active" &&
              i.updated_at >= corte,
          )
          .map((i) => i.contact_id),
      );
    },
    insertEnrollment: async (input) => {
      inscricoes.push({
        contact_id: input.contact_id,
        status: "active",
        completa_em: agora.ms + DURACAO_DO_RAMO_MINUTOS * MIN,
        updated_at: agora.ms,
      });
      return { inserted: true };
    },
    loadContatosComInscricaoViva: async (_org, contactIds) =>
      new Set(
        contactIds.filter((id) =>
          inscricoes.some((i) => i.contact_id === id && i.status === "active"),
        ),
      ),
  };

  return {
    db,
    agora,
    inscricoes,
    /**
     * O motor andando os nós: um enrollment ativo cujo ramo JÁ terminou à hora
     * corrente passa a `completed`, e o fim é gravado em `updated_at` — o mesmo
     * commit que o motor faz (`engine.ts:301-302`).
     */
    avancarMotor() {
      for (const i of inscricoes) {
        if (i.status === "active" && i.completa_em !== null && i.completa_em <= agora.ms) {
          i.status = "completed";
          i.updated_at = i.completa_em;
          i.completa_em = null;
        }
      }
    },
  };
}

const CONTADORES_ZERADOS: SilenceSweepSummary = {
  pointers_scanned: 0,
  pointers_gated_out: 0,
  enrolled: 0,
  skipped_existing: 0,
  skipped_cooldown: 0,
  skipped_pending_return: 0,
  skipped_reentry_pause: 0,
  skipped_human_owned: 0,
  skipped_sem_resposta_da_equipe: 0,
  skipped_resposta_a_automacao: 0,
  skipped_teto_de_repeticoes: 0,
  pointers_failed: 0,
};

/**
 * Roda `quantosMinutos` tiques de 1 minuto. Antes de cada tique o motor anda os
 * nós com a hora corrente — o enrollment criado no tique anterior completa 3
 * minutos depois, como no cron real.
 */
async function rodarTiques(
  cenario: ReturnType<typeof mundo>,
  quantosMinutos: number,
): Promise<{ total: SilenceSweepSummary; noTique: SilenceSweepSummary[] }> {
  const total: SilenceSweepSummary = { ...CONTADORES_ZERADOS };
  const noTique: SilenceSweepSummary[] = [];

  for (let m = 0; m <= quantosMinutos; m++) {
    cenario.agora.ms = T0 + m * MIN;
    cenario.avancarMotor();
    const summary = await runSilenceSweep({
      db: cenario.db,
      gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
      clock: () => new Date(cenario.agora.ms),
    });
    noTique.push(summary);
    for (const chave of Object.keys(total) as Array<keyof SilenceSweepSummary>) {
      total[chave] = total[chave] + summary[chave];
    }
  }

  return { total, noTique };
}

describe("runSilenceSweep — ramo curto não re-enrola a cada tique (#529)", () => {
  it("⭐ com a guarda: 1 inscrição no primeiro tique, NENHUMA no tique seguinte ao fim do ramo curto", async () => {
    const cenario = mundo({ comGuarda: true });
    const { total, noTique } = await rodarTiques(cenario, JANELA_MINUTOS);

    const primeiro = noTique[0];
    if (primeiro === undefined) throw new Error("nenhum tique rodou");
    expect(primeiro.enrolled).toBe(1);

    // Tiques 1..3: o enrollment ainda está VIVO (o ramo leva 3 min) — barrado
    // pelo índice único, contado como `skipped_existing`, sem INSERT.
    for (let m = 1; m < DURACAO_DO_RAMO_MINUTOS; m++) {
      const tique = noTique[m];
      if (tique === undefined) throw new Error(`o tique ${m} não rodou`);
      expect(tique.enrolled).toBe(0);
      expect(tique.skipped_existing).toBe(1);
    }

    // O tique seguinte ao fim do ramo: o contato continua silencioso e SEM
    // inscrição viva — é exatamente aqui que, sem a guarda, nasceria a próxima.
    const tiqueDepoisDoRamo = noTique[DURACAO_DO_RAMO_MINUTOS + 1];
    if (tiqueDepoisDoRamo === undefined) throw new Error("o tique seguinte ao fim do ramo não rodou");
    expect(tiqueDepoisDoRamo.enrolled).toBe(0);
    expect(tiqueDepoisDoRamo.skipped_cooldown).toBe(1);

    // A janela de churn: do tique seguinte ao fim do ramo até o threshold
    // vencer, NENHUM tique inscreve. Em 200 minutos nascem DOIS enrollments (o
    // primeiro e o legítimo depois do threshold), não um a cada ~4.
    const janelaDeChurn = noTique.slice(
      DURACAO_DO_RAMO_MINUTOS + 1,
      THRESHOLD_MINUTOS + DURACAO_DO_RAMO_MINUTOS,
    );
    expect(janelaDeChurn.every((s) => s.enrolled === 0)).toBe(true);
    expect(cenario.inscricoes).toHaveLength(2);
    expect(total.enrolled).toBe(2);
    expect(total.skipped_cooldown).toBeGreaterThan(60);

    console.log(
      `[#529] com a guarda, ${JANELA_MINUTOS} tiques (threshold ${THRESHOLD_MINUTOS} min, ` +
        `ramo de ${DURACAO_DO_RAMO_MINUTOS} min): inscrições=${cenario.inscricoes.length} ` +
        `enrolled=${total.enrolled} skipped_cooldown=${total.skipped_cooldown} ` +
        `skipped_existing=${total.skipped_existing}`,
    );
  });

  it("⭐ a guarda é só ESPAÇO, não bloqueio: passado o threshold, reinscreve", async () => {
    const cenario = mundo({ comGuarda: true });
    const { noTique } = await rodarTiques(
      cenario,
      THRESHOLD_MINUTOS + DURACAO_DO_RAMO_MINUTOS + 5,
    );

    // A primeira reinscrição só pode vir depois de `fim do ramo + threshold`.
    const minuto = noTique.findIndex((s, indice) => indice > 0 && s.enrolled === 1);
    expect(minuto).toBeGreaterThan(DURACAO_DO_RAMO_MINUTOS + THRESHOLD_MINUTOS);
    expect(cenario.inscricoes).toHaveLength(2);

    console.log(
      `[#529] reinscrição legítima no tique ${minuto} ` +
        `(ramo ${DURACAO_DO_RAMO_MINUTOS} min + threshold ${THRESHOLD_MINUTOS} min); ` +
        `total de inscrições na janela=${cenario.inscricoes.length}`,
    );
  });

  it("CONTROLE: sem a guarda, o mesmo ramo curto vira uma inscrição a cada ~4 min (o custo do #529)", async () => {
    const semGuarda = mundo({ comGuarda: false });
    const comGuarda = mundo({ comGuarda: true });

    const sem = await rodarTiques(semGuarda, JANELA_MINUTOS);
    const com = await rodarTiques(comGuarda, JANELA_MINUTOS);

    // ~1 a cada (duração do ramo + 1 tique): a ordem de grandeza que a issue
    // descreve. Não é asserção de relógio de parede — é contagem de tiques.
    // A guarda espaça, não bloqueia: na janela de 200 min cabem o primeiro
    // enrollment e o legítimo depois do threshold (a cada ~123 min), enquanto
    // sem guarda caberia um a cada ~4 min.
    expect(semGuarda.inscricoes.length).toBeGreaterThanOrEqual(
      JANELA_MINUTOS / (DURACAO_DO_RAMO_MINUTOS + 1) - 2,
    );
    expect(comGuarda.inscricoes).toHaveLength(2);
    expect(semGuarda.inscricoes.length).toBeGreaterThan(comGuarda.inscricoes.length * 10);

    // O controle também mostra que os contadores do resumo não mentem: sem a
    // guarda, `skipped_cooldown` é zero e todo tique livre vira INSERT.
    expect(sem.total.skipped_cooldown).toBe(0);
    expect(sem.total.enrolled).toBe(semGuarda.inscricoes.length);

    console.log(
      `[#529] custo medido em ${JANELA_MINUTOS} tiques — sem guarda: ` +
        `${semGuarda.inscricoes.length} inscrições; com guarda: ${comGuarda.inscricoes.length}`,
    );
  });
});

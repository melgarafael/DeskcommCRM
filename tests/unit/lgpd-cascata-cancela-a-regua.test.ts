/**
 * A RÉGUA DE RECUPERAÇÃO PARA DE CORRER PARA QUEM PEDIU PARA SER ESQUECIDO.
 *
 * ─── O defeito, medido (issue #701) ─────────────────────────────────────────
 *
 * `appointment_recovery_review` — o aviso "cliente faltou e não respondeu à
 * recuperação" — tem quatro portas de entrada, e três guardam anonimização (o
 * trigger `fn_meet_redact_contact` resolve os abertos, `fn_appointment_recover`
 * recusa contato anonimizado, e há um bloco de cura no baseline). A quarta é
 * escrita pelo TypeScript, nos adaptadores de `followup`, e nascia sem guarda.
 *
 * A CAUSA, porém, não é a porta: é que a cascata de LGPD não cancelava
 * `followup_enrollments`. Medido com controle positivo:
 *
 *   $ git grep -l "followup" lib/lgpd/           → (vazio)
 *   $ git grep -l "agent_inbox_items" lib/lgpd/  → (a sonda enxerga)
 *
 * Ou seja: o contato é anonimizado, e a régua CONTINUA correndo. Quando ela
 * esgota, nasce um aviso apontando para o compromisso que a redação tinha
 * desligado — o aviso ressuscitando o vínculo que a LGPD mandou cortar, e
 * mensagem saindo para quem exerceu o direito de ser esquecido.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * O passo que cancela a régua mora na MESMA unidade que as duas bocas da cascata
 * compartilham (`lib/lgpd/cascata.ts`): a rota `POST /api/v1/lgpd/anonymize` e o
 * varredor diário do cron de retenção. As três propriedades que o tornam seguro
 * rodar todo dia, para sempre, estão aqui:
 *
 *   1. ele CANCELA a régua viva do contato (senão a causa continua de pé);
 *   2. ele NÃO toca em régua de outro contato nem de outra organização — o
 *      client do cron é service role, que bypassa a RLS, e o filtro de org é à
 *      mão justamente por isso;
 *   3. ele é IDEMPOTENTE — a segunda passada não encontra régua viva e não
 *      escreve nada. Sem isso a varredura diária gravaria `completed_at` novo em
 *      toda rodada, com a auditoria registrando efeito que não houve.
 *
 * O que o Postgres de fato aceita está fora daqui, como em
 * `lgpd-varredura-completa-a-cascata`: o dublê aplica o UPDATE, mas o CHECK de
 * `followup_enrollments` (status × `next_eval_at`) quem garante é o banco.
 */
import { describe, expect, it } from "vitest";

import {
  type ClienteDaCascata,
  completarRedacaoDoContato,
  varrerRedacoesIncompletas,
} from "@/lib/lgpd/cascata";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const CONTATO = "contacts:a";
const OUTRO_CONTATO = "contacts:b";

/** O motivo é pinado por VALOR: vocabulário de auditoria não é detalhe interno. */
const MOTIVO = "Contato anonimizado (LGPD)";

interface Linha {
  id: string;
  organization_id: string;
  contact_id?: string | null;
  title?: string | null;
  payload?: unknown;
  is_anonymized?: boolean;
  status?: string | null;
  cancel_reason?: string | null;
  next_eval_at?: string | null;
  claimed_until?: string | null;
  completed_at?: string | null;
}

interface Escrita {
  tabela: string;
  patch: Record<string, unknown>;
  alvos: string[];
}

/**
 * Um PostgREST de mentira com linhas de VERDADE, que APLICA o UPDATE.
 *
 * Aplicar importa: sem isso, "a segunda passada não escreve" passaria por
 * vacuidade — a segunda leitura veria o mesmo estado vivo da primeira, e o teste
 * não distinguiria idempotência de dublê amnésico. É o mesmo dublê de
 * `lgpd-varredura-completa-a-cascata`, e o `id` carrega a tabela (`tabela:x`)
 * porque ele guarda tudo numa lista só.
 */
function banco(linhas: Linha[]) {
  const escritas: Escrita[] = [];

  const aplicar = (tabela: string, patch: Record<string, unknown>, alvos: Linha[]) => {
    escritas.push({ tabela, patch, alvos: alvos.map((l) => l.id) });
    for (const l of alvos) Object.assign(l, patch);
  };

  const cliente = {
    from(tabela: string) {
      const casar = (filtros: Array<[string, unknown]>, dentro: [string, string[]] | null): Linha[] =>
        linhas.filter((l) => {
          if ((l.id.split(":")[0] ?? "") !== tabela) return false;
          for (const [col, val] of filtros) {
            if ((l as unknown as Record<string, unknown>)[col] !== val) return false;
          }
          // O `.in()` desta cascata vem em duas colunas — `status` no SELECT da
          // régua e `id` no UPDATE das atividades. Um dublê que ignorasse a
          // coluna casaria as duas na errada e daria verde falso.
          if (dentro) {
            const [col, vals] = dentro;
            const valor = (l as unknown as Record<string, string | undefined>)[col];
            if (valor === undefined || !vals.includes(valor)) return false;
          }
          return true;
        });

      const construir = (modo: "select" | "update", patch: Record<string, unknown>) => {
        const filtros: Array<[string, unknown]> = [];
        let dentro: [string, string[]] | null = null;
        let teto: number | null = null;
        const q: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            filtros.push([col, val]);
            return q;
          },
          in: (col: string, vals: string[]) => {
            dentro = [col, vals];
            return q;
          },
          limit: (n: number) => {
            teto = n;
            return q;
          },
          then: (r: (v: unknown) => unknown) => {
            let achadas = casar(filtros, dentro);
            if (teto !== null) achadas = achadas.slice(0, teto);
            if (modo === "update") {
              aplicar(tabela, patch, achadas);
              return Promise.resolve({ error: null }).then(r);
            }
            return Promise.resolve({ data: achadas, error: null }).then(r);
          },
        };
        return q;
      };

      return {
        select: () => construir("select", {}),
        update: (patch: Record<string, unknown>) => construir("update", patch),
      };
    },
  } as unknown as ClienteDaCascata;

  return { cliente, escritas, linhas };
}

/** Contato já anonimizado, como a linha que a varredura encontra no banco. */
function contatoAnonimizado(sufixo = "a", org = ORG): Linha {
  return { id: `contacts:${sufixo}`, organization_id: org, is_anonymized: true };
}

function matricula(
  sufixo: string,
  status: string,
  { org = ORG, contactId = CONTATO }: { org?: string; contactId?: string } = {},
): Linha {
  return {
    id: `followup_enrollments:${sufixo}`,
    organization_id: org,
    contact_id: contactId,
    status,
    next_eval_at: "2026-09-01T10:00:00.000Z",
    claimed_until: "2026-09-01T10:05:00.000Z",
  };
}

/** As escritas na régua, que é o que este arquivo vigia. */
function escritasNaRegua(alvo: ReturnType<typeof banco>): Escrita[] {
  return alvo.escritas.filter((e) => e.tabela === "followup_enrollments");
}

describe("a cascata cancela a régua de recuperação do contato", () => {
  it("⭐ régua viva do contato anonimizado é cancelada — é a causa, não o sintoma", async () => {
    const alvo = banco([
      contatoAnonimizado(),
      matricula("e1", "active"),
      matricula("e2", "waiting_reply"),
      matricula("e3", "paused_handoff"),
      // `paused_manual` é a quarta janela de status vivo (migration 0225): se o
      // vocabulário do cancelamento divergir do claim do worker, sobra régua
      // viva para trás — e é ela que abre o aviso depois.
      matricula("e4", "paused_manual"),
    ]);

    await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });

    const escritas = escritasNaRegua(alvo);
    expect(escritas, "a régua continuou correndo para o contato anonimizado").toHaveLength(1);
    expect(escritas[0]!.alvos.sort()).toEqual([
      "followup_enrollments:e1",
      "followup_enrollments:e2",
      "followup_enrollments:e3",
      "followup_enrollments:e4",
    ]);
    expect(escritas[0]!.patch.status).toBe("cancelled");
    expect(escritas[0]!.patch.cancel_reason).toBe(MOTIVO);
    // Sem soltar o relógio e o lease, a linha cancelada continua parecendo
    // reivindicável: é o `next_eval_at`/`claimed_until` que o claim filtra.
    expect(escritas[0]!.patch.next_eval_at).toBeNull();
    expect(escritas[0]!.patch.claimed_until).toBeNull();
    expect(typeof escritas[0]!.patch.completed_at).toBe("string");

    // A auditoria registra o que foi tocado de verdade — a linha
    // `lgpd.anonymize_catchup` deixaria de citar a régua se ela não entrasse aqui.
    expect(escritas[0]!.patch).toHaveProperty("completed_at");
  });

  it("⭐ régua de OUTRO contato e de OUTRA organização não é tocada", async () => {
    const alvo = banco([
      contatoAnonimizado(),
      contatoAnonimizado("b"),
      contatoAnonimizado("z", OUTRA_ORG),
      matricula("e1", "active"),
      matricula("e2", "active", { contactId: OUTRO_CONTATO }),
      matricula("e3", "active", { org: OUTRA_ORG }),
    ]);

    await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });

    const escritas = escritasNaRegua(alvo);
    expect(escritas, "cancelou régua alheia").toHaveLength(1);
    expect(escritas[0]!.alvos).toEqual(["followup_enrollments:e1"]);
  });

  it("⭐ régua já terminal não é reescrita — a varredura diária não grava sobre dado certo", async () => {
    const alvo = banco([
      contatoAnonimizado(),
      matricula("e1", "completed"),
      matricula("e2", "cancelled"),
      matricula("e3", "dead"),
    ]);

    const r = await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });

    expect(escritasNaRegua(alvo), "reescreveu régua que já tinha terminado").toEqual([]);
    expect(r.tabelas).not.toContain("followup_enrollments");
  });

  it("⭐ a segunda passada não escreve — idempotência é o que torna o cron diário seguro", async () => {
    const alvo = banco([contatoAnonimizado(), matricula("e1", "active")]);

    await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });
    const depoisDaPrimeira = escritasNaRegua(alvo).length;
    await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });
    await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });

    expect(escritasNaRegua(alvo), "a régua foi cancelada mais de uma vez").toHaveLength(depoisDaPrimeira);
  });

  it("⭐ `tabelas` passa a citar a régua quando ela foi tocada", async () => {
    const alvo = banco([contatoAnonimizado(), matricula("e1", "active")]);

    const r = await completarRedacaoDoContato(alvo.cliente, { id: CONTATO, organizationId: ORG });

    expect(r.tabelas).toContain("followup_enrollments");
  });

  it("⭐ a varredura do cron alcança a régua do contato que ficou pela metade", async () => {
    // A retomada existe para curar cascata interrompida — e a interrupção pode
    // ter sido ANTES deste passo existir: o contato anonimizado de ontem tem
    // régua viva e resíduo de lead. É por esta porta que o conserto o alcança.
    const alvo = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: CONTATO, title: "Orçamento com PII" },
      matricula("e1", "active"),
    ]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.completados).toHaveLength(1);
    const escritas = escritasNaRegua(alvo);
    expect(escritas, "o cron completou o resíduo e deixou a régua correndo").toHaveLength(1);
    expect(escritas[0]!.alvos).toEqual(["followup_enrollments:e1"]);
  });
});

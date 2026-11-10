import type pg from "pg";
import { describe, expect, it } from "vitest";

import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";

/**
 * #4146 — O HANDOFF DE UMA CONVERSA NÃO PODE CALAR OUTRA (nem outro número).
 *
 * O defeito medido em produção: o `exists` de `isLeadInHandoff` lia
 * `bot_silenced_until` de QUALQUER conversa do contato — sem olhar status nem a
 * conversa do turno. O cliente falava com um humano na conversa A (que depois
 * era ARQUIVADA) e, ao escrever no número B, o agente ficava mudo para sempre:
 * `'infinity'` não vence nunca, e nenhum humano havia assumido B.
 *
 * ─── O que este arquivo vigia, e o que ele NÃO vigia ─────────────────────────
 *
 * A suíte de unidade não tem Postgres. O dublê abaixo responde pelo que a
 * CONSULTA PEDE — ele lê o texto e os parâmetros que a produção mandou e aplica
 * os filtros que estão lá. É de propósito: tirar `status not in (...)` ou o
 * escopo por conversa do SQL deixa estes casos VERMELHOS, porque o dublê deixa
 * de filtrar. O que ele não prova é a semântica do Postgres (índice, plano,
 * fuso do `now()`); isso fica com os invariantes `escalacao-ciclo-humano` e
 * `operador-nao-pisa-no-humano`, que rodam as funções REAIS contra o baseline.
 *
 * A reprodução é de DUBLÊ com duas conversas — não de tráfego real de dois
 * números WhatsApp (não há dois números nesta bancada).
 */

interface ConversaDeTeste {
  id: string;
  /** 'open' | 'ai_handling' | 'pending' | 'claimed' | 'closed' | 'archived' */
  status: string;
  /** `'infinity'`, um instante ISO no futuro/passado, ou null (sem silêncio). */
  silenciadaAte: string | null;
}

interface ContatoDeTeste {
  force_human: boolean;
  ai_opt_out: boolean;
  conversas: ConversaDeTeste[];
}

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
/** Conversa A — a que recebeu o humano e foi ARQUIVADA (o caso da issue). */
const CONVERSA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Conversa B — outro número, aberta, sem ninguém atendendo nela. */
const CONVERSA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** O `now()` do banco, congelado: futuro = silêncio vivo; passado = vencido. */
const AGORA = new Date("2026-11-06T12:00:00.000Z");

const silencioVivo = (valor: string | null): boolean => {
  if (valor === null) return false;
  if (valor === "infinity") return true;
  return new Date(valor).getTime() > AGORA.getTime();
};

/**
 * O dublê de `pg.Pool` — responde pela CONSULTA, não por uma cópia da regra.
 *
 * Duas cláusulas mudam a resposta, e as duas são lidas do texto enviado:
 *   · `status not in (...)` → conversa terminal deixa de contar;
 *   · `v.id = $3`           → o silêncio só vale para a conversa do `$3`.
 * Contato (`force_human`, `ai_opt_out`) é global e nunca depende da conversa.
 */
function poolDaGuarda(contato: ContatoDeTeste) {
  const consultas: { sql: string; params: unknown[] }[] = [];

  const db = {
    query: async (sql: string, params: unknown[]) => {
      consultas.push({ sql, params });

      const excluiTerminais =
        sql.includes("status not in (") &&
        CONVERSATION_TERMINAL_STATUSES.every((s) => sql.includes(`'${s}'`));
      const escopada = /v\.id = \$3/.test(sql);
      const conversationId = params[2] ?? null;

      if (contato.force_human || contato.ai_opt_out) {
        return { rows: [{ handoff: true }] };
      }

      const caladas = contato.conversas.filter((c) => {
        if (escopada && c.id !== conversationId) return false;
        if (
          excluiTerminais &&
          (CONVERSATION_TERMINAL_STATUSES as readonly string[]).includes(c.status)
        ) {
          return false;
        }
        return silencioVivo(c.silenciadaAte);
      });

      return { rows: [{ handoff: caladas.length > 0 }] };
    },
  } as unknown as pg.Pool;

  return { db, consultas };
}

const contatoLimpo = (conversas: ConversaDeTeste[]): ContatoDeTeste => ({
  force_human: false,
  ai_opt_out: false,
  conversas,
});

describe("#4146 — isLeadInHandoff por conversa", () => {
  it("A arquivada com silêncio infinito NÃO cala a conversa B (número novo)", async () => {
    const { db, consultas } = poolDaGuarda(
      contatoLimpo([
        { id: CONVERSA_A, status: "archived", silenciadaAte: "infinity" },
        { id: CONVERSA_B, status: "open", silenciadaAte: null },
      ]),
    );

    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_B })).resolves.toBe(
      false,
    );

    // CONTROLE: o dublê foi de fato exercitado, e o escopo viajou no $3.
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.params).toEqual([ORG, CONTATO, CONVERSA_B]);
  });

  it("humano ainda atendendo A: o silêncio é DELA — true em A, false em B", async () => {
    const { db } = poolDaGuarda(
      contatoLimpo([
        { id: CONVERSA_A, status: "pending", silenciadaAte: "infinity" },
        { id: CONVERSA_B, status: "open", silenciadaAte: null },
      ]),
    );

    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_A })).resolves.toBe(
      true,
    );
    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_B })).resolves.toBe(
      false,
    );
  });

  it("claimed com silêncio de 5 min da resposta pela tela continua calando a própria conversa", async () => {
    const { db } = poolDaGuarda(
      contatoLimpo([
        {
          id: CONVERSA_A,
          status: "claimed",
          silenciadaAte: "2026-11-06T12:05:00.000Z",
        },
        { id: CONVERSA_B, status: "open", silenciadaAte: null },
      ]),
    );

    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_A })).resolves.toBe(
      true,
    );
    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_B })).resolves.toBe(
      false,
    );
  });

  it("force_human do CONTATO segue GLOBAL — cala B mesmo sem silêncio nenhum", async () => {
    const { db } = poolDaGuarda({
      force_human: true,
      ai_opt_out: false,
      conversas: [
        { id: CONVERSA_A, status: "archived", silenciadaAte: "infinity" },
        { id: CONVERSA_B, status: "open", silenciadaAte: null },
      ],
    });

    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_B })).resolves.toBe(
      true,
    );
  });

  it("ai_opt_out do CONTATO também é global", async () => {
    const { db } = poolDaGuarda({
      force_human: false,
      ai_opt_out: true,
      conversas: [{ id: CONVERSA_B, status: "open", silenciadaAte: null }],
    });

    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_B })).resolves.toBe(
      true,
    );
  });

  it("sem conversa informada, o contrato antigo fica: silêncio vivo de qualquer conversa VIVA conta", async () => {
    // "Esta pessoa está com um humano em algum lugar?" — a pergunta de quem não
    // tem a conversa do turno (inscrição do fluxo, opt-out, varreduras).
    const { db, consultas } = poolDaGuarda(
      contatoLimpo([
        { id: CONVERSA_A, status: "pending", silenciadaAte: "infinity" },
        { id: CONVERSA_B, status: "open", silenciadaAte: null },
      ]),
    );

    await expect(isLeadInHandoff(db, ORG, CONTATO)).resolves.toBe(true);
    // Dois parâmetros — os chamadores antigos não mudam de contrato.
    expect(consultas[0]!.params).toEqual([ORG, CONTATO]);
    expect(consultas[0]!.sql).not.toContain("v.id = $3");
  });

  it("sem conversa informada, a MESMA exclusão de status terminal vale", async () => {
    const { db } = poolDaGuarda(
      contatoLimpo([{ id: CONVERSA_A, status: "closed", silenciadaAte: "infinity" }]),
    );

    await expect(isLeadInHandoff(db, ORG, CONTATO)).resolves.toBe(false);
  });

  it("o silêncio vencido continua vencido, em qualquer conversa", async () => {
    const { db } = poolDaGuarda(
      contatoLimpo([{ id: CONVERSA_A, status: "open", silenciadaAte: "2026-11-06T11:59:00.000Z" }]),
    );

    await expect(isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_A })).resolves.toBe(
      false,
    );
  });

  it("a consulta deriva os status terminais de CONVERSATION_TERMINAL_STATUSES", async () => {
    // Sem literal novo: quem acrescentar um status terminal à fonte única vê
    // esta guarda acompanhar sem edição. CONTROLE do caso acima — se o filtro
    // desaparecer do SQL, a sabotagem abaixo denuncia (o dublê deixa de filtrar).
    expect([...CONVERSATION_TERMINAL_STATUSES]).toEqual(["closed", "archived"]);

    const { db, consultas } = poolDaGuarda(contatoLimpo([]));
    await isLeadInHandoff(db, ORG, CONTATO, { conversationId: CONVERSA_B });

    const sql = consultas[0]!.sql;
    expect(sql).toContain("status not in (");
    for (const status of CONVERSATION_TERMINAL_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain("bot_silenced_until > now()");
    expect(sql).toContain("v.id = $3");
  });
});

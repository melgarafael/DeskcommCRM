import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

/**
 * #4311 — a leitura de conversas do silêncio saía UMA VEZ POR PONTEIRO.
 *
 * Medido em produção: 29 ponteiros ativos × ~110 conversas abertas, um tick por
 * minuto → ~1.700 requisições/hora da MESMA consulta (a mais pesada da
 * varredura: `conversations` com os embeds de `messages`, `contacts`, `sessao`
 * e `organizations(settings)`), e o egress do Supabase estourou (402 por ~14 h).
 *
 * A consulta só depende da ORGANIZAÇÃO — o corte de silêncio, o teto e os
 * segmentos são aplicados em memória. O conserto guarda as linhas num mapa
 * `orgId → linhas` e cada ponteiro continua decidindo com o seu `pointerId`,
 * o seu `agent_id` e o seu canal: nada de pular ponteiro.
 *
 * Estes testes fixam o número de REQUISIÇÕES e a IGUALDADE dos efeitos: o
 * mesmo conjunto de inscrições, com os mesmos campos, antes e depois.
 */

const ORG = "org-1";
const ORG_B = "org-2";
const AGORA = new Date("2026-11-03T12:00:00.000Z");
const CUTOFF = new Date(AGORA.getTime() - 120 * 60_000).toISOString();

/** Grafo mínimo válido: só texto fixo (nenhum agente é exigido). */
const GRAFO = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
};

/**
 * Admin de mentira que ROTEIA por tabela e CONTA cada `from(tabela)`.
 *
 * É a mesma borda que os outros testes de query deste diretório usam
 * (`silence-sweep-contagem-query.test.ts`): a lógica testada é a de produção,
 * `createSupabaseSilenceSweepDb`, e o dublê é só o PostgREST. Tabela sem linha
 * configurada responde vazio — é o caso de `followup_enrollments`, `cron_jobs`
 * e `messages` aqui, onde "nada" é exatamente a resposta que interessa.
 */
function fakeAdmin(tabelas: Record<string, unknown[]>) {
  const consultas = new Map<string, number>();
  const chain = (tabela: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown) => resolve({ data: tabelas[tabela] ?? [], error: null });
          }
          if (prop === "single" || prop === "maybeSingle") {
            return async () => ({ data: (tabelas[tabela] ?? [])[0] ?? null, error: null });
          }
          return () => chain(tabela);
        },
      },
    );

  return {
    admin: {
      from: (tabela: string) => {
        consultas.set(tabela, (consultas.get(tabela) ?? 0) + 1);
        return chain(tabela);
      },
    } as never,
    consultas: (tabela: string) => consultas.get(tabela) ?? 0,
  };
}

function conversa(opts: {
  contactId: string;
  conversationId: string;
  organizationId?: string;
  inbound: string;
  bloqueado?: boolean;
}) {
  return {
    id: opts.conversationId,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    assignee_kind: null,
    bot_silenced_until: null,
    last_outbound_at: null,
    contact_id: opts.contactId,
    last_inbound_at: opts.inbound,
    channel_session_id: "canal-1",
    messages: [
      {
        organization_id: opts.organizationId ?? ORG,
        contact_id: opts.contactId,
        conversation_id: opts.conversationId,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        sent_at: opts.inbound,
      },
    ],
    contacts: {
      tags: [],
      is_blocked: opts.bloqueado ?? false,
      ai_authorized_at: null,
      phone_number: "+558****0000",
      force_human: false,
      ai_opt_out: false,
    },
    sessao: { metadata: {} },
    organizations: { status: "active", settings: {} },
  };
}

/** Um silencioso (deve entrar), um que falou depois do corte e um bloqueado. */
const CONVERSAS = [
  conversa({ contactId: "c-silencioso", conversationId: "conv-1", inbound: "2026-09-01T10:00:00.000Z" }),
  conversa({ contactId: "c-recente", conversationId: "conv-2", inbound: "2026-11-03T11:30:00.000Z" }),
  conversa({ contactId: "c-bloqueado", conversationId: "conv-3", inbound: "2026-09-01T10:00:00.000Z", bloqueado: true }),
];

function ponteiro(id: string, orgId = ORG) {
  return {
    id,
    organization_id: orgId,
    active_version_id: `versao-${id}`,
    trigger_config: { kind: "silence", params: { threshold_minutes: 120 } },
    surface: null,
    handoff_policy: "pause",
  };
}

const CINCO_PONTEIROS = ["p1", "p2", "p3", "p4", "p5"].map((id) => ponteiro(id));

/** Só texto fixo: grafo sem IA não exige agente publicado. */
const GATE = { loadEnabledPublishedFollowupAgents: async () => [] };

/** O efeito de uma conversa: exatamente o que o `insertEnrollment` recebe. */
interface Efeito {
  pointer_id: string;
  contact_id: string;
  version_id: string;
  agent_id: string | null;
  next_eval_at: string;
}

function montarDb(pointers: unknown[], conversas: unknown[] = CONVERSAS) {
  const { admin, consultas } = fakeAdmin({
    followup_flow_pointers: pointers,
    followup_flow_versions: [{ graph: GRAFO }],
    conversations: conversas,
  });
  const adapter = createSupabaseSilenceSweepDb(admin);
  const efeitos: Efeito[] = [];
  // O INSERT é a única coisa que sai do adapter: a fronteira de atendimento e a
  // proteção da agenda não são o que este teste mede, e o efeito que interessa é
  // o que a varredura ENTREGA ao insert (ponteiro, contato, versão, agente).
  const db: SilenceSweepDb = {
    ...adapter,
    insertEnrollment: async (input) => {
      efeitos.push({
        pointer_id: input.pointer_id,
        contact_id: input.contact_id,
        version_id: input.version_id,
        agent_id: input.agent_id,
        next_eval_at: input.next_eval_at,
      });
      return { inserted: true };
    },
  };
  return { db, efeitos, consultas };
}

describe("#4311 — consulta de conversas: uma por organização, nunca uma por ponteiro", () => {
  it("5 ponteiros da MESMA organização leem as conversas UMA vez (antes: 5)", async () => {
    const { admin, consultas } = fakeAdmin({ conversations: CONVERSAS });
    const db = createSupabaseSilenceSweepDb(admin);

    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      await db.loadSilentContactIds(ORG, CUTOFF, [], undefined);
      expect(id).toBeTruthy();
    }

    expect(consultas("conversations")).toBe(1);
  });

  it("ponteiros de DUAS organizações: uma leitura por organização (2 no total)", async () => {
    const { admin, consultas } = fakeAdmin({ conversations: CONVERSAS });
    const db = createSupabaseSilenceSweepDb(admin);

    await db.loadSilentContactIds(ORG, CUTOFF, [], undefined);
    await db.loadSilentContactIds(ORG, CUTOFF, [], undefined);
    await db.loadSilentContactIds(ORG, CUTOFF, [], undefined);
    await db.loadSilentContactIds(ORG_B, CUTOFF, [], undefined);
    await db.loadSilentContactIds(ORG_B, CUTOFF, [], undefined);

    expect(consultas("conversations")).toBe(2);
  });

  it("a varredura de 5 ponteiros da mesma org inscreve exatamente os MESMOS efeitos de antes, sem pular ponteiro", async () => {
    // ANTES: uma varredura por ponteiro, adapter novo em cada uma — é o
    // comportamento medido em produção (uma leitura de conversas por ponteiro).
    const antes: Efeito[] = [];
    let consultasAntes = 0;
    for (const p of CINCO_PONTEIROS) {
      const rodada = montarDb([p]);
      const summary = await runSilenceSweep({ db: rodada.db, gateDb: GATE, clock: () => AGORA });
      expect(summary.pointers_scanned).toBe(1);
      expect(summary.enrolled).toBe(1);
      antes.push(...rodada.efeitos);
      consultasAntes += rodada.consultas("conversations");
    }
    expect(consultasAntes).toBe(5);

    // DEPOIS: uma varredura, um adapter — a leitura sai uma vez e os cinco
    // ponteiros continuam sendo avaliados.
    const depois = montarDb(CINCO_PONTEIROS);
    const summary = await runSilenceSweep({ db: depois.db, gateDb: GATE, clock: () => AGORA });

    expect(depois.consultas("conversations")).toBe(1);
    expect(summary.pointers_scanned).toBe(5);
    expect(summary.pointers_failed).toBe(0);
    expect(summary.enrolled).toBe(5);

    const chave = (e: Efeito) => `${e.pointer_id}:${e.contact_id}:${e.version_id}:${e.agent_id}:${e.next_eval_at}`;
    expect(depois.efeitos.map(chave).sort()).toEqual(antes.map(chave).sort());
    // Nenhum ponteiro deixou de ser avaliado.
    expect(new Set(depois.efeitos.map((e) => e.pointer_id))).toEqual(new Set(CINCO_PONTEIROS.map((p) => p.id)));
    // E a janela de silêncio continua a mesma: só o silencioso entra.
    expect(new Set(depois.efeitos.map((e) => e.contact_id))).toEqual(new Set(["c-silencioso"]));
  });

  it("falha de leitura não fica memorizada: o próximo ponteiro da org tenta de novo", async () => {
    let chamadas = 0;
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            chamadas += 1;
            return (resolve: (value: unknown) => unknown) =>
              resolve(chamadas === 1 ? { data: null, error: { message: "timeout" } } : { data: [], error: null });
          }
          return () => chain;
        },
      },
    );
    const db = createSupabaseSilenceSweepDb({ from: () => chain } as never);

    await expect(db.loadSilentContactIds(ORG, CUTOFF, [], undefined)).rejects.toThrow("timeout");
    await expect(db.loadSilentContactIds(ORG, CUTOFF, [], undefined)).resolves.toEqual([]);
    expect(chamadas).toBe(2);
  });
});

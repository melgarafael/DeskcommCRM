import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

/**
 * #4311 (resíduo) — o que sobrou depois do PR #4330.
 *
 * O #4330 já tirou a leitura de CONVERSAS de dentro do laço de ponteiros (uma
 * por organização por tick). Ficaram dois pesos no mesmo tick:
 *
 *   1. `organizations:organization_id(status, settings)` EMBUTIDO na consulta
 *      de conversas: o objeto de ~7,7 KB vem repetido em CADA linha (~110
 *      conversas ≈ 850 KB por resposta), e só dois campos são consumidos;
 *   2. o grafo da versão relido uma vez por ponteiro — 29 ponteiros da mesma
 *      versão faziam 29 leituras do MESMO grafo.
 *
 * Estes testes fixam: UMA leitura de conversas por tick (com 3 ponteiros), UMA
 * leitura de `organizations` por organização (e nenhuma por conversa), UMA
 * leitura de versão por versão no tick, o MESMO conjunto atendido por ponteiro,
 * e o silêncio ativo continuando a barrar.
 */

const ORG = "org-1";
const ORG_B = "org-2";
const AGORA = new Date("2026-11-03T12:00:00.000Z");
const CUTOFF = new Date(AGORA.getTime() - 120 * 60_000).toISOString();

const GRAFO = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
};

type Linha = Record<string, unknown>;

/**
 * Admin de mentira que ROTEIA por tabela, HONRA `.eq()` e CONTA cada
 * `from(tabela)`. Também guarda o argumento de `.select()` — é assim que o
 * teste prova que `organizations(settings)` saiu do embed.
 */
function fakeAdmin(tabelas: Record<string, Linha[]>) {
  const consultas = new Map<string, number>();
  const selects = new Map<string, string[]>();

  const linhas = (tabela: string, eq: Array<[string, unknown]>): Linha[] =>
    (tabelas[tabela] ?? []).filter((linha) => eq.every(([col, valor]) => !(col in linha) || linha[col] === valor));

  const chain = (tabela: string, eq: Array<[string, unknown]> = []): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown) => resolve({ data: linhas(tabela, eq), error: null });
          }
          if (prop === "single" || prop === "maybeSingle") {
            return async () => ({ data: linhas(tabela, eq)[0] ?? null, error: null });
          }
          if (prop === "select") {
            return (cols?: unknown) => {
              if (typeof cols === "string") {
                selects.set(tabela, [...(selects.get(tabela) ?? []), cols]);
              }
              return chain(tabela, eq);
            };
          }
          if (prop === "eq") {
            return (col: string, valor: unknown) => chain(tabela, [...eq, [col, valor]]);
          }
          return () => chain(tabela, eq);
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
    selects: (tabela: string) => selects.get(tabela) ?? [],
  };
}

function conversa(opts: {
  contactId: string;
  conversationId: string;
  inbound: string;
  tags?: string[];
  bloqueado?: boolean;
  silenciadoAte?: string | null;
}) {
  return {
    id: opts.conversationId,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    assignee_kind: null,
    bot_silenced_until: opts.silenciadoAte ?? null,
    last_outbound_at: null,
    contact_id: opts.contactId,
    last_inbound_at: opts.inbound,
    channel_session_id: "canal-1",
    messages: [
      {
        organization_id: ORG,
        contact_id: opts.contactId,
        conversation_id: opts.conversationId,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        sent_at: opts.inbound,
      },
    ],
    contacts: {
      tags: opts.tags ?? [],
      is_blocked: opts.bloqueado ?? false,
      ai_authorized_at: null,
      phone_number: "+558590000000",
      force_human: false,
      ai_opt_out: false,
    },
    sessao: { metadata: {} },
  };
}

/** Cinco conversas abertas: quatro silenciosas e uma que falou depois do corte. */
const CINCO_CONVERSAS = [
  conversa({ contactId: "c-a", conversationId: "conv-1", inbound: "2026-09-01T10:00:00.000Z" }),
  conversa({ contactId: "c-b", conversationId: "conv-2", inbound: "2026-09-02T10:00:00.000Z" }),
  conversa({ contactId: "c-c", conversationId: "conv-3", inbound: "2026-09-03T10:00:00.000Z" }),
  conversa({ contactId: "c-d", conversationId: "conv-4", inbound: "2026-09-04T10:00:00.000Z" }),
  conversa({ contactId: "c-recente", conversationId: "conv-5", inbound: "2026-11-03T11:30:00.000Z" }),
];

/**
 * Settings da organização com a lista de tags INTERNA: o único campo de
 * `settings` que a decisão de silêncio consome. Se a leitura por organização
 * fosse só decorativa, o contato marcado `interno` entraria — e este arquivo
 * fica vermelho.
 */
const SETTINGS_COM_TAG_INTERNA = { crm: { internal_contact_tags: ["interno"] } };

function ponteiro(id: string, versionId = "versao-1", orgId = ORG) {
  return {
    id,
    organization_id: orgId,
    active_version_id: versionId,
    trigger_config: { kind: "silence", params: { threshold_minutes: 120 } },
    surface: null,
    handoff_policy: "pause",
  };
}

const GATE = { loadEnabledPublishedFollowupAgents: async () => [] };

interface Efeito {
  pointer_id: string;
  contact_id: string;
  version_id: string;
  agent_id: string | null;
  next_eval_at: string;
}

const chave = (e: Efeito) => `${e.pointer_id}:${e.contact_id}:${e.version_id}:${e.agent_id}:${e.next_eval_at}`;

/** Só texto fixo: grafo sem IA não exige agente publicado. */
function montarDb(tabelas: Record<string, Linha[]>) {
  const { admin, consultas, selects } = fakeAdmin(tabelas);
  const adapter = createSupabaseSilenceSweepDb(admin);
  const efeitos: Efeito[] = [];
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
  return { db, efeitos, consultas, selects };
}

/** O tick completo: um `runSilenceSweep` sobre as tabelas informadas. */
async function tick(tabelas: Record<string, Linha[]>) {
  const rodada = montarDb(tabelas);
  const summary = await runSilenceSweep({ db: rodada.db, gateDb: GATE, clock: () => AGORA });
  return { ...rodada, summary };
}

describe("#4311 (resíduo) — a varredura não repete o mesmo trabalho por ponteiro", () => {
  it("3 ponteiros da mesma organização fazem UMA leitura de conversas por tick", async () => {
    const { consultas, summary } = await tick({
      followup_flow_pointers: [ponteiro("p1"), ponteiro("p2"), ponteiro("p3")],
      followup_flow_versions: [{ graph: GRAFO }],
      conversations: CINCO_CONVERSAS,
      organizations: [{ id: ORG, status: "active", settings: {} }],
    });

    // A leitura pesada: uma por tick, independente do número de ponteiros.
    expect(consultas("conversations")).toBe(1);
    // E nenhum ponteiro deixou de ser avaliado.
    expect(summary.pointers_scanned).toBe(3);
    expect(summary.pointers_failed).toBe(0);
  });

  it("`organizations(settings)` saiu do embed: uma leitura por organização no tick, nenhuma por conversa", async () => {
    const { consultas, selects, efeitos, summary } = await tick({
      followup_flow_pointers: [ponteiro("p1"), ponteiro("p2"), ponteiro("p3")],
      followup_flow_versions: [{ graph: GRAFO }],
      conversations: [
        ...CINCO_CONVERSAS,
        conversa({ contactId: "c-interno", conversationId: "conv-6", inbound: "2026-09-05T10:00:00.000Z", tags: ["interno"] }),
      ],
      organizations: [{ id: ORG, status: "active", settings: SETTINGS_COM_TAG_INTERNA }],
    });

    // (a) o embed não está mais na consulta de conversas...
    expect(selects("conversations").join(" ")).not.toMatch(/organizations/);
    // (b) ...e `organizations` é lida UMA vez no tick, não uma por conversa
    // (6 conversas) nem uma por ponteiro (3).
    expect(consultas("organizations")).toBe(1);
    // (c) e o `settings` lido uma vez CONTINUA decidindo por conversa: o
    // contato com a tag interna da org não é atendido.
    expect(efeitos.every((e) => e.contact_id !== "c-interno")).toBe(true);
    expect(new Set(efeitos.map((e) => e.contact_id))).toEqual(new Set(["c-a", "c-b", "c-c", "c-d"]));
    expect(summary.pointers_failed).toBe(0);
  });

  it("o conjunto atendido por cada ponteiro é idêntico ao de antes (caracterização)", async () => {
    const PONTEIROS = [ponteiro("p1"), ponteiro("p2"), ponteiro("p3")];
    const tabelas = () => ({
      followup_flow_pointers: PONTEIROS,
      followup_flow_versions: [{ graph: GRAFO }],
      conversations: [
        ...CINCO_CONVERSAS,
        conversa({ contactId: "c-interno", conversationId: "conv-6", inbound: "2026-09-05T10:00:00.000Z", tags: ["interno"] }),
        conversa({ contactId: "c-bloqueado", conversationId: "conv-7", inbound: "2026-09-06T10:00:00.000Z", bloqueado: true }),
      ],
      organizations: [{ id: ORG, status: "active", settings: SETTINGS_COM_TAG_INTERNA }],
    });

    // ANTES: um adapter por ponteiro, cada um lendo o seu — é o formato que a
    // produção tinha quando cada ponteiro era um tick independente. A lista de
    // efeitos abaixo é a régua do comportamento antigo.
    const antes: Efeito[] = [];
    for (const p of PONTEIROS) {
      const rodada = await tick({ ...tabelas(), followup_flow_pointers: [p] });
      expect(rodada.summary.pointers_scanned).toBe(1);
      antes.push(...rodada.efeitos);
    }
    expect(antes.length).toBeGreaterThan(0);

    // DEPOIS: um tick, um adapter — a leitura compartilhada não pode mudar
    // QUEM é atendido por QUEM.
    const depois = await tick(tabelas());
    expect(depois.summary.pointers_scanned).toBe(3);
    expect(depois.efeitos.map(chave).sort()).toEqual(antes.map(chave).sort());
    // E a janela/segmentos continuam valendo: ninguém que respondeu depois do
    // corte, nem bloqueado, nem interno, entra.
    expect(new Set(depois.efeitos.map((e) => e.contact_id))).toEqual(new Set(["c-a", "c-b", "c-c", "c-d"]));
  });

  it("silêncio ativo continua bloqueando o follow-up", async () => {
    // `bot_silenced_until` é comparado com o relógio de PAREDE dentro da leitura
    // (não com o `clock` do sweep) — o instante tem de ser futuro de verdade.
    const silenciadoAte = new Date(Date.now() + 60 * 60_000).toISOString();
    const { efeitos } = await tick({
      followup_flow_pointers: [ponteiro("p1")],
      followup_flow_versions: [{ graph: GRAFO }],
      conversations: [
        conversa({ contactId: "c-silenciado-pela-ia", conversationId: "conv-1", inbound: "2026-09-01T10:00:00.000Z", silenciadoAte }),
        conversa({ contactId: "c-livre", conversationId: "conv-2", inbound: "2026-09-01T10:00:00.000Z" }),
      ],
      organizations: [{ id: ORG, status: "active", settings: {} }],
    });

    // `bot_silenced_until` no futuro = alguém está com a conversa; o relógio do
    // silêncio do lead não pode atropelar isso. O cache por tick não muda isto.
    expect(efeitos.map((e) => e.contact_id)).toEqual(["c-livre"]);
  });

  it("as versões são lidas uma vez por tick quando os ponteiros compartilham a versão", async () => {
    const compartilhada = await tick({
      followup_flow_pointers: [ponteiro("p1"), ponteiro("p2"), ponteiro("p3")],
      followup_flow_versions: [{ graph: GRAFO, id: "versao-1" }],
      conversations: CINCO_CONVERSAS,
      organizations: [{ id: ORG, status: "active", settings: {} }],
    });

    // O grafo é o MESMO para os três: uma leitura (antes: 3).
    expect(compartilhada.consultas("followup_flow_versions")).toBe(1);
    expect(compartilhada.summary.pointers_scanned).toBe(3);
    expect(new Set(compartilhada.efeitos.map((e) => e.pointer_id))).toEqual(new Set(["p1", "p2", "p3"]));

    // Controle: versões DIFERENTES são dados diferentes — duas leituras. A
    // memoização é por versão, não "uma leitura por tick, aconteça o que for".
    const distintas = await tick({
      followup_flow_pointers: [ponteiro("p1", "versao-1"), ponteiro("p2", "versao-2")],
      followup_flow_versions: [{ graph: GRAFO, id: "versao-1" }, { graph: GRAFO, id: "versao-2" }],
      conversations: CINCO_CONVERSAS,
      organizations: [{ id: ORG, status: "active", settings: {} }],
    });
    expect(distintas.consultas("followup_flow_versions")).toBe(2);
    expect(distintas.summary.pointers_scanned).toBe(2);
  });
});

/**
 * O FLUXO DE SILÊNCIO RESPEITA A PAUSA ANTES DE RECOMEÇAR, E NÃO INSCREVE
 * CONVERSA QUE UMA PESSOA ASSUMIU.
 *
 * ## O defeito (medido numa instalação real, 25–26/09/2026)
 *
 * Fluxo de silêncio de 1 hora com `cancel_on_reply`: a cliente respondia
 * "gracias", a resposta cancelava a inscrição, e uma hora depois a varredura a
 * inscrevia de novo, do primeiro passo. Dois contatos entraram em laço (o passo
 * de IA terminava sem enviar — num deles porque uma pessoa já tinha assumido a
 * conversa —, a inscrição era cancelada e recriada na varredura seguinte).
 *
 * ## O que este arquivo prende
 *
 * - a regra pura (`pausa-de-reentrada.ts`): a pausa conta do mais tardio entre
 *   o fim da inscrição e a última mensagem; sem pausa ou sem histórico, nada muda;
 * - a varredura pula quem está na pausa e quem tem pessoa no comando (salvo
 *   `handoff_policy='allow'`), e conta cada pulo no resumo;
 * - sem pausa configurada, a varredura nem consulta o histórico;
 * - a consulta de PRODUÇÃO: lê os vetos da conversa e filtra o histórico por
 *   organização, fluxo e estados encerrados, em lotes.
 *
 * ## O que NÃO prova
 *
 * O efeito das consultas no PostgREST — o espelho em SQL puro, contra o banco,
 * mora no invariante `tests/invariants/followup-silence-sweep.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import { emPausaDeReentrada, pausaDeReentradaAte, type FatosDaReentrada } from "@/lib/followup/pausa-de-reentrada";
import {
  createSupabaseSilenceSweepDb,
  runSilenceSweep,
  type SilencePointer,
  type SilenceSweepDb,
} from "@/lib/followup/silence-sweep";

const AGORA = new Date("2026-09-27T12:00:00.000Z");
const H = 3_600_000;
const PAUSA_48H = 48 * 60;

describe("regra da pausa de reentrada", () => {
  it("⭐ conta do mais tardio entre o fim da inscrição e a última mensagem", () => {
    const fatos: FatosDaReentrada = { encerradaEm: AGORA.getTime() - 60 * H, ultimaMensagemEm: AGORA.getTime() - 20 * H };
    expect(pausaDeReentradaAte(fatos, PAUSA_48H)).toBe(AGORA.getTime() + 28 * H);
    expect(emPausaDeReentrada(fatos, PAUSA_48H, AGORA)).toBe(true);
  });

  it("sem a última mensagem, conta do fim da inscrição (o laço sem resposta)", () => {
    const fatos: FatosDaReentrada = { encerradaEm: AGORA.getTime() - 2 * H, ultimaMensagemEm: null };
    expect(pausaDeReentradaAte(fatos, PAUSA_48H)).toBe(AGORA.getTime() + 46 * H);
  });

  it("inclusiva no fim: exatamente na hora, já pode entrar", () => {
    const fatos: FatosDaReentrada = { encerradaEm: AGORA.getTime() - 48 * H, ultimaMensagemEm: AGORA.getTime() - 48 * H };
    expect(emPausaDeReentrada(fatos, PAUSA_48H, AGORA)).toBe(false);
    expect(emPausaDeReentrada(fatos, PAUSA_48H, new Date(AGORA.getTime() - 1))).toBe(true);
  });

  it("sem pausa configurada, ou sem histórico no fluxo, não há o que esperar", () => {
    const fatos: FatosDaReentrada = { encerradaEm: AGORA.getTime() - H, ultimaMensagemEm: AGORA.getTime() - H };
    expect(pausaDeReentradaAte(fatos, 0)).toBeNull();
    expect(pausaDeReentradaAte(undefined, PAUSA_48H)).toBeNull();
  });
});

describe("contrato do gatilho", () => {
  it("aceita a pausa no gatilho de silêncio, com teto de 90 dias", () => {
    const base = { kind: "silence", params: { threshold_minutes: 60 }, cancel_on_reply: true };
    expect(triggerConfigSchema.safeParse(base).success).toBe(true);
    expect(triggerConfigSchema.safeParse({ ...base, params: { threshold_minutes: 60, reentry_pause_minutes: 2880 } }).success).toBe(true);
    expect(triggerConfigSchema.safeParse({ ...base, params: { threshold_minutes: 60, reentry_pause_minutes: -1 } }).success).toBe(false);
    expect(
      triggerConfigSchema.safeParse({ ...base, params: { threshold_minutes: 60, reentry_pause_minutes: 90 * 24 * 60 + 1 } }).success,
    ).toBe(false);
  });
});

describe("varredura de silêncio", () => {
  function sweepDb(opts: {
    pointer?: Partial<SilencePointer>;
    encerramentos?: Map<string, FatosDaReentrada>;
    comPessoa?: Set<string>;
  }) {
    const insert = vi.fn(async () => ({ inserted: true }));
    const loadEncerramentosDoFluxo = vi.fn(async () => opts.encerramentos ?? new Map<string, FatosDaReentrada>());
    const loadContatosComPessoaNoComando = vi.fn(async () => opts.comPessoa ?? new Set<string>());
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        {
          id: "ptr",
          organization_id: "org",
          active_version_id: "v1",
          threshold_minutes: 60,
          segments: [],
          ...opts.pointer,
        },
      ],
      loadSilentContactIds: async () => ["respondeu-agora", "nunca-passou", "encerrou-ha-tempo"],
      loadContatosComRetornoVivo: async () => new Set<string>(),
      loadContatosComInscricaoViva: async () => new Set<string>(),
      loadContactIdsEmCooldown: async () => new Set<string>(),
      loadEncerramentosDoFluxo,
      loadContatosComPessoaNoComando,
      loadTriggerNode: async () => ({ id: "inicio", pedeAgente: false }),
      insertEnrollment: insert,
    };
    return { db, insert, loadEncerramentosDoFluxo, loadContatosComPessoaNoComando };
  }
  const gateDb = { loadEnabledPublishedFollowupAgents: async () => [] };
  const inscritos = (insert: ReturnType<typeof vi.fn>) =>
    insert.mock.calls.map((c) => (c[0] as { contact_id: string }).contact_id).sort();

  const historico = new Map<string, FatosDaReentrada>([
    ["respondeu-agora", { encerradaEm: AGORA.getTime() - 2 * H, ultimaMensagemEm: AGORA.getTime() - 2 * H }],
    ["encerrou-ha-tempo", { encerradaEm: AGORA.getTime() - 72 * H, ultimaMensagemEm: AGORA.getTime() - 72 * H }],
  ]);

  it("⭐ com pausa, quem respondeu há pouco fica de fora; quem nunca passou e quem já cumpriu a pausa entram", async () => {
    const { db, insert } = sweepDb({ pointer: { reentry_pause_minutes: PAUSA_48H }, encerramentos: historico });
    const resumo = await runSilenceSweep({ db, gateDb, clock: () => AGORA });

    expect(inscritos(insert)).toEqual(["encerrou-ha-tempo", "nunca-passou"]);
    expect(resumo.skipped_reentry_pause).toBe(1);
    expect(resumo.enrolled).toBe(2);
  });

  it("controle: sem pausa, os três entram — e o histórico nem é consultado", async () => {
    const { db, insert, loadEncerramentosDoFluxo } = sweepDb({ encerramentos: historico });
    const resumo = await runSilenceSweep({ db, gateDb, clock: () => AGORA });

    expect(inscritos(insert)).toHaveLength(3);
    expect(resumo.skipped_reentry_pause).toBe(0);
    expect(loadEncerramentosDoFluxo).not.toHaveBeenCalled();
  });

  it("⭐ conversa com pessoa no comando não é inscrita (política padrão)", async () => {
    const { db, insert } = sweepDb({ comPessoa: new Set(["nunca-passou"]) });
    const resumo = await runSilenceSweep({ db, gateDb, clock: () => AGORA });

    expect(inscritos(insert)).not.toContain("nunca-passou");
    expect(resumo.skipped_human_owned).toBe(1);
  });

  it("controle: fluxo com handoff_policy='allow' inscreve mesmo com pessoa no comando", async () => {
    const { db, insert, loadContatosComPessoaNoComando } = sweepDb({
      pointer: { handoff_policy: "allow" },
      comPessoa: new Set(["nunca-passou"]),
    });
    const resumo = await runSilenceSweep({ db, gateDb, clock: () => AGORA });

    expect(inscritos(insert)).toContain("nunca-passou");
    expect(resumo.skipped_human_owned).toBe(0);
    expect(loadContatosComPessoaNoComando).not.toHaveBeenCalled();
  });
});

/** Registra a cadeia do PostgREST; cada `await` devolve a próxima resposta da fila. */
function fakeSupabase(respostas: unknown[][]) {
  const chamadas: { tabela: string; metodo: string; args: unknown[] }[] = [];
  let tabela = "";
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: respostas.shift() ?? [], error: null });
        }
        return (...args: unknown[]) => {
          chamadas.push({ tabela, metodo: String(prop), args });
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  const client = {
    from: (t: string) => {
      tabela = t;
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

describe("createSupabaseSilenceSweepDb — a consulta de PRODUÇÃO", () => {
  const conversa = (contato: string, extra: Record<string, unknown>) => ({
    id: `conv-${contato}`,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    contact_id: contato,
    last_inbound_at: "2026-09-27T09:00:00.000Z",
    messages: [
      {
        organization_id: "org",
        contact_id: contato,
        conversation_id: `conv-${contato}`,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        sent_at: "2026-09-27T09:00:00.000Z",
      },
    ],
    contacts: { tags: [], is_blocked: false, ai_authorized_at: null, phone_number: null, force_human: false },
    sessao: { metadata: { ai_gate_mode: "open" } },
    organizations: { status: "active" },
    assignee_kind: null,
    bot_silenced_until: null,
    ...extra,
  });

  it("⭐ lê os vetos da conversa: assumida, force_human e IA silenciada contam como pessoa no comando", async () => {
    const { client, chamadas } = fakeSupabase([
      [
        conversa("livre", {}),
        conversa("assumida", { assignee_kind: "user" }),
        conversa("forcada", {
          contacts: { tags: [], is_blocked: false, ai_authorized_at: null, phone_number: null, force_human: true },
        }),
        conversa("silenciada", { bot_silenced_until: new Date(Date.now() + H).toISOString() }),
      ],
    ]);
    const db = createSupabaseSilenceSweepDb(client);
    const silenciosos = await db.loadSilentContactIds("org", "2026-09-27T11:00:00.000Z", []);
    const select = String(chamadas.find((c) => c.metodo === "select")?.args[0]);

    expect(select).toContain("assignee_kind");
    expect(select).toContain("bot_silenced_until");
    expect(select).toContain("force_human");
    // Controle: o dublê alcançou o caminho — os quatro foram lidos como silenciosos.
    expect(silenciosos.sort()).toEqual(["assumida", "forcada", "livre", "silenciada"]);
    expect([...(await db.loadContatosComPessoaNoComando("org", silenciosos))].sort()).toEqual([
      "assumida",
      "forcada",
      "silenciada",
    ]);
  });

  it("⭐ o histórico filtra organização, fluxo e estados encerrados, e soma a última mensagem", async () => {
    const { client, chamadas } = fakeSupabase([
      [conversa("respondeu", {})],
      [
        { contact_id: "respondeu", completed_at: "2026-09-27T09:00:00.000Z", updated_at: "2026-09-27T09:00:00.000Z" },
        { contact_id: "respondeu", completed_at: null, updated_at: "2026-09-20T09:00:00.000Z" },
      ],
    ]);
    const db = createSupabaseSilenceSweepDb(client);
    await db.loadSilentContactIds("org", "2026-09-27T11:00:00.000Z", []);
    const fatos = await db.loadEncerramentosDoFluxo("org", "ptr", ["respondeu"]);

    const doHistorico = chamadas.filter((c) => c.tabela === "followup_enrollments");
    expect(doHistorico).toContainEqual(expect.objectContaining({ metodo: "eq", args: ["organization_id", "org"] }));
    expect(doHistorico).toContainEqual(expect.objectContaining({ metodo: "eq", args: ["pointer_id", "ptr"] }));
    expect(doHistorico).toContainEqual(
      expect.objectContaining({ metodo: "in", args: ["status", ["completed", "cancelled", "dead"]] }),
    );
    expect(fatos.get("respondeu")).toEqual({
      encerradaEm: Date.parse("2026-09-27T09:00:00.000Z"),
      ultimaMensagemEm: Date.parse("2026-09-27T09:00:00.000Z"),
    });
  });

  it("consulta o histórico em lotes: a lista de contatos vai na URL", async () => {
    const { client, chamadas } = fakeSupabase([]);
    const ids = Array.from({ length: 250 }, (_, i) => `c-${i}`);
    await createSupabaseSilenceSweepDb(client).loadEncerramentosDoFluxo("org", "ptr", ids);

    const lotes = chamadas.filter((c) => c.metodo === "in" && c.args[0] === "contact_id").map((c) => (c.args[1] as string[]).length);
    expect(lotes).toEqual([100, 100, 50]);
  });

  it("o fluxo carrega a pausa e a política de handoff", async () => {
    const { client } = fakeSupabase([
      [
        {
          id: "ptr",
          organization_id: "org",
          active_version_id: "v1",
          surface: "followup",
          handoff_policy: "cancel",
          trigger_config: { kind: "silence", params: { threshold_minutes: 60, reentry_pause_minutes: 2880 } },
        },
      ],
    ]);
    const [pointer] = await createSupabaseSilenceSweepDb(client).loadActiveSilencePointers();
    expect(pointer).toMatchObject({ reentry_pause_minutes: 2880, handoff_policy: "cancel" });
  });
});

describe("base da pausa: a partir do último ENVIO do fluxo", () => {
  // Um toque curto "10 min depois de o cliente parar, no máximo 1× por dia": com a
  // base `ultima_mensagem` e o teto de silêncio de 60 min, a pausa de 24 h nunca se
  // cumpria — contava da mensagem que acabou de chegar.
  const pausa24h = 24 * 60;

  it("⭐ encerrada há 25 h, cliente escreveu há 20 min: pela base do envio, pode entrar", () => {
    const fatos: FatosDaReentrada = { encerradaEm: AGORA.getTime() - 25 * H, ultimaMensagemEm: AGORA.getTime() - (20 * H) / 60 };
    expect(emPausaDeReentrada(fatos, pausa24h, AGORA, "ultimo_envio")).toBe(false);
    // controle: pela base da última mensagem, a mesma situação segue em pausa
    expect(emPausaDeReentrada(fatos, pausa24h, AGORA, "ultima_mensagem")).toBe(true);
    expect(emPausaDeReentrada(fatos, pausa24h, AGORA)).toBe(true);
  });

  it("encerrada há 2 h: pela base do envio, ainda em pausa", () => {
    const fatos: FatosDaReentrada = { encerradaEm: AGORA.getTime() - 2 * H, ultimaMensagemEm: AGORA.getTime() - (15 * H) / 60 };
    expect(emPausaDeReentrada(fatos, pausa24h, AGORA, "ultimo_envio")).toBe(true);
  });

  it("o contrato aceita as duas bases e recusa outra", () => {
    const base = { kind: "silence", params: { threshold_minutes: 10, reentry_pause_minutes: 1440 }, cancel_on_reply: true };
    for (const b of ["ultima_mensagem", "ultimo_envio"])
      expect(triggerConfigSchema.safeParse({ ...base, params: { ...base.params, reentry_pause_basis: b } }).success).toBe(true);
    expect(triggerConfigSchema.safeParse({ ...base, params: { ...base.params, reentry_pause_basis: "outra" } }).success).toBe(false);
  });

  it("a varredura aplica a base do ponteiro", async () => {
    const insert = vi.fn(async (_row: { contact_id: string }) => ({ inserted: true }));
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "ptr", organization_id: "org", active_version_id: "v1", threshold_minutes: 10, segments: [], reentry_pause_minutes: pausa24h, reentry_pause_basis: "ultimo_envio" },
      ],
      loadSilentContactIds: async () => ["ontem", "hoje"],
      loadContatosComRetornoVivo: async () => new Set<string>(),
      loadContatosComInscricaoViva: async () => new Set<string>(),
      loadContactIdsEmCooldown: async () => new Set<string>(),
      loadEncerramentosDoFluxo: async () =>
        new Map<string, FatosDaReentrada>([
          ["ontem", { encerradaEm: AGORA.getTime() - 25 * H, ultimaMensagemEm: AGORA.getTime() - H / 3 }],
          ["hoje", { encerradaEm: AGORA.getTime() - 2 * H, ultimaMensagemEm: AGORA.getTime() - H / 3 }],
        ]),
      loadContatosComPessoaNoComando: async () => new Set<string>(),
      loadTriggerNode: async () => ({ id: "inicio", pedeAgente: false }),
      insertEnrollment: insert,
    };
    const resumo = await runSilenceSweep({ db, gateDb: { loadEnabledPublishedFollowupAgents: async () => [] }, clock: () => AGORA });
    expect(insert.mock.calls.map((c) => c[0].contact_id)).toEqual(["ontem"]);
    expect(resumo.skipped_reentry_pause).toBe(1);
  });

  it("a leitura do fluxo carrega a base", async () => {
    const { client } = fakeSupabase([
      [
        {
          id: "ptr", organization_id: "org", active_version_id: "v1", surface: "followup", handoff_policy: "cancel",
          trigger_config: { kind: "silence", params: { threshold_minutes: 10, reentry_pause_minutes: 1440, reentry_pause_basis: "ultimo_envio" } },
        },
      ],
    ]);
    const [pointer] = await createSupabaseSilenceSweepDb(client).loadActiveSilencePointers();
    expect(pointer).toMatchObject({ reentry_pause_minutes: 1440, reentry_pause_basis: "ultimo_envio" });
  });
});

/**
 * Suíte de testes: Bloqueio da IA durante atendimento humano
 *
 * Valida a correção em `app/api/v1/messages/_handler.ts`,
 * `lib/agent-engine/agent/human-handoff.ts` (`iaVetadaNoEnvio`) e
 * `lib/agent-engine/agent/inbound-turn.ts` (guarda de envio do turno):
 * 1. Modo "IA com o dono" ligado: a resposta do dono NÃO cala a IA para sempre.
 * 2. Técnico responsável envia mensagem: bloqueio permanente ('infinity').
 * 3. Dono humano veta a entrega da IA mesmo sem silêncio gravado (corrida com rodízio/Assumir).
 * 4. Técnico não responsável envia mensagem: não assume indevidamente (apenas janela de 5min, não 'infinity').
 * 5. Conversa sem responsável recebe resposta humana pontual: janela de 5min (não 'infinity').
 * 6. Conversa livre (sem trava, sem dono): a IA segue entregando normalmente.
 * 7. Mensagem de IA já em processamento: TODO envio do turno reconfere a pessoa
 *    imediatamente antes de sair — e o aborto não é tratado como opt-out.
 * 8. Isolamento entre tenants: nenhuma escrita cruza organizações.
 *
 * Os casos 1, 3, 6 e 7 substituem versões anteriores que só conferiam a própria
 * fixture, o valor que o mock devolvia ou uma função escrita dentro do teste —
 * nenhuma delas reprovaria se a correção fosse removida.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import { iaVetadaNoEnvio } from "@/lib/agent-engine/agent/human-handoff";
import type pg from "pg";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const TECNICO_RESPONSAVEL = "66666666-6666-4666-8666-666666666666"; // técnico responsável (fixture)
const OUTRO_TECNICO = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, unknown>;

function conversationRow(opts: {
  botSilencedUntil?: string | null;
  assignedToUserId?: string | null;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}): Row {
  return {
    id: CONV_ID,
    organization_id: opts.organizationId ?? ORG_A,
    contact_id: CONTACT_ID,
    channel_session_id: SESSION_ID,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: opts.botSilencedUntil ?? null,
    assigned_to_user_id: opts.assignedToUserId ?? null,
    assignee_kind: opts.assignedToUserId ? "user" : null,
    metadata: opts.metadata ?? {},
    contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false, force_human: false, ai_opt_out: false },
    channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING" },
  };
}

const RPC_PADRAO = {
  organization_id: ORG_A,
  contact_id: CONTACT_ID,
  conversation_id: CONV_ID,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
  status: "open",
  demanda_fechada_em: null,
};

function duble(opts: {
  botSilencedUntil?: string | null;
  assignedToUserId?: string | null;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}) {
  const { supabase, capturas } = criarDubleDoHandler({
    conversation: conversationRow(opts),
    rpcData: RPC_PADRAO,
  });
  return { supabase, patches: capturas.patches.conversations! };
}

const inputMsg = { conversation_id: CONV_ID, type: "text", body: "Olá, suporte técnico." } as SendMessageInput;

function wahaConfigured() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: { id: "MSG_OK" } }), { status: 200 })));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Bloqueio da IA durante atendimento humano — Validação dos 8 Requisitos", () => {
  // 1. Modo "IA com o dono" (#3967): a pessoa LIGOU a IA para responder junto.
  // SABOTAGEM: tirar `&& !lerModoIaComDono(c.metadata)` do handler → o patch
  // grava 'infinity' e o primeiro expect acusa.
  it("1. Modo 'IA com o dono' ligado: a resposta do dono NÃO cala a IA para sempre", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({
      assignedToUserId: TECNICO_RESPONSAVEL,
      botSilencedUntil: null,
      metadata: { ai_com_dono: true },
    });
    const ctx: HandlerCtx = {
      organization_id: ORG_A,
      actor: { type: "user", id: TECNICO_RESPONSAVEL },
      requestId: "req-ia-com-dono-1",
    };

    await sendMessageHandler(supabase, ctx, inputMsg);

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until).not.toBe("infinity");
    // Continua havendo a janela curta de sempre — o modo não desliga a pausa da fala humana.
    expect(typeof convPatch.bot_silenced_until).toBe("string");
  });

  // 2. Técnico responsável envia primeira mensagem: bloqueio permanente ('infinity')
  it("2. Técnico responsável envia primeira mensagem: bloqueio permanente ('infinity')", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({
      assignedToUserId: TECNICO_RESPONSAVEL,
      botSilencedUntil: null,
    });
    const ctx: HandlerCtx = {
      organization_id: ORG_A,
      actor: { type: "user", id: TECNICO_RESPONSAVEL },
      requestId: "req-resp-1",
    };

    await sendMessageHandler(supabase, ctx, inputMsg);

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until).toBe("infinity");
  });

  // 3. O dono humano veta a entrega mesmo quando nenhum silêncio foi gravado
  // (o rodízio atribui sem gravar silêncio; o "Assumir" pode chegar no meio do turno).
  // SABOTAGEM: tirar a segunda consulta de `iaVetadaNoEnvio` → devolve false e o
  // primeiro expect acusa.
  it("3. Dono humano veta a entrega da IA mesmo sem silêncio gravado, e a leitura é presa à organização", async () => {
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const mockDb = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        // 1ª: isLeadInHandoff — sem trava de contato, sem silêncio em vigor.
        if (consultas.length === 1) return { rows: [{ handoff: false }], rowCount: 1 };
        // 2ª: a conversa tem dono humano e o modo "IA com o dono" está desligado.
        return { rows: [{ assignee_kind: "user", metadata: {} }], rowCount: 1 };
      }),
    } as unknown as pg.Pool;

    expect(await iaVetadaNoEnvio(mockDb, ORG_A, CONTACT_ID, CONV_ID)).toBe(true);
    expect(consultas).toHaveLength(2);
    const doDono = consultas[1]!;
    expect(doDono.params).toEqual([ORG_A, CONV_ID]);
    expect(doDono.sql).toMatch(/v\.organization_id = \$1 and v\.id = \$2/);
  });

  // A exceção do modo #3967 é a MESMA régua do gate (`lerModoIaComDono`): só o
  // BOOLEANO true libera. SABOTAGEM: trocar `lerModoIaComDono` por um teste de
  // verdade (`!!metadata.ai_com_dono`) faz o caso da string reprovar.
  it("3c. 'IA com o dono' libera só com o booleano true, como no gate", async () => {
    const comDono = (metadata: unknown) => {
      const respostas = [{ handoff: false }, { assignee_kind: "user", metadata }];
      return { query: vi.fn(async () => ({ rows: [respostas.shift()], rowCount: 1 })) } as unknown as pg.Pool;
    };
    expect(await iaVetadaNoEnvio(comDono({ ai_com_dono: true }), ORG_A, CONTACT_ID, CONV_ID)).toBe(false);
    expect(await iaVetadaNoEnvio(comDono({ ai_com_dono: "true" }), ORG_A, CONTACT_ID, CONV_ID)).toBe(true);
    expect(await iaVetadaNoEnvio(comDono(null), ORG_A, CONTACT_ID, CONV_ID)).toBe(true);
  });

  it("3b. Conversa já silenciada: veta na primeira leitura, sem consultar o dono", async () => {
    const query = vi.fn(async () => ({ rows: [{ handoff: true }], rowCount: 1 }));
    const mockDb = { query } as unknown as pg.Pool;
    expect(await iaVetadaNoEnvio(mockDb, ORG_A, CONTACT_ID, CONV_ID)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  // 4. Técnico não responsável envia mensagem: não assume indevidamente (apenas janela temporária de 5min)
  it("4. Técnico não responsável envia mensagem: não assume indevidamente (aplica janela temporária de 5min, NÃO 'infinity')", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({
      assignedToUserId: TECNICO_RESPONSAVEL, // o responsável é o técnico da fixture
      botSilencedUntil: null,
    });
    // Quem envia é OUTRO técnico (ex.: colega comentando)
    const ctx: HandlerCtx = {
      organization_id: ORG_A,
      actor: { type: "user", id: OUTRO_TECNICO },
      requestId: "req-outro-1",
    };

    const before = Date.now();
    await sendMessageHandler(supabase, ctx, inputMsg);
    const after = Date.now();

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until).not.toBe("infinity");
    const silencedUntil = new Date(convPatch.bot_silenced_until as string).getTime();
    expect(silencedUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1000);
    expect(silencedUntil).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 1000);
  });

  // 5. Conversa sem responsável recebe resposta humana pontual: preservar comportamento previsto (janela de 5min)
  it("5. Conversa sem responsável recebe resposta humana pontual: preserva janela temporária de 5min", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({
      assignedToUserId: null, // Sem dono
      botSilencedUntil: null,
    });
    const ctx: HandlerCtx = {
      organization_id: ORG_A,
      actor: { type: "user", id: TECNICO_RESPONSAVEL },
      requestId: "req-sem-dono-1",
    };

    const before = Date.now();
    await sendMessageHandler(supabase, ctx, inputMsg);
    const after = Date.now();

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until).not.toBe("infinity");
    const silencedUntil = new Date(convPatch.bot_silenced_until as string).getTime();
    expect(silencedUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1000);
    expect(silencedUntil).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 1000);
  });

  // 6. Requisito 4: fora do atendimento humano a IA segue normal.
  it("6. Conversa livre (sem trava, sem dono, ou com 'IA com o dono'): a IA segue entregando", async () => {
    const respostas = [{ handoff: false }, { assignee_kind: "ai", metadata: {} }];
    const query = vi.fn(async () => ({ rows: [respostas.shift()], rowCount: 1 }));
    const mockDb = { query } as unknown as pg.Pool;
    expect(await iaVetadaNoEnvio(mockDb, ORG_A, CONTACT_ID, CONV_ID)).toBe(false);

    // Conversa de outra organização (ou inexistente): a leitura não devolve linha
    // nenhuma, e "sem linha" não inventa veto — o gate do começo do turno, que
    // lê a conversa pela mesma organização, já não deixaria o turno nascer.
    const vazia = { query: vi.fn(async () => ({ rows: [{ handoff: false }], rowCount: 1 })) };
    vazia.query.mockResolvedValueOnce({ rows: [{ handoff: false }], rowCount: 1 });
    vazia.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await iaVetadaNoEnvio(vazia as unknown as pg.Pool, ORG_B, CONTACT_ID, CONV_ID)).toBe(false);
  });

  // 7. A IA já estava escrevendo quando a pessoa assumiu.
  //
  // O COMPORTAMENTO (turno real, banco real, a pessoa assumindo entre a resposta
  // do modelo e o envio) é medido em `tests/invariants/pessoa-assume-durante-o-turno.test.ts`.
  // Aqui o teste prende a ESTRUTURA: que TODO envio ao canal passa pela guarda,
  // inclusive os que aquele turno de teste não alcança (voz, template, roteiro).
  //
  // SABOTAGENS que cada expect acusa:
  //   - tirar a guarda de qualquer um dos envios ao canal (texto/bolha, voz,
  //     template, pergunta do roteiro);
  //   - voltar a abortar com `kind: 'blocked'` — que cancela o job e TODOS os
  //     follow-ups agendados do contato (`applySendOutcome`) e diz ao modelo
  //     que o cliente pediu para não receber mensagens;
  //   - deixar o `unavailable` da pessoa cair em `noteRunError` (a fila re-tentaria
  //     o turno inteiro como se o canal estivesse fora).
  describe("7. Mensagem da IA em processamento quando a pessoa assume", () => {
    const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

    it("todo envio ao canal do turno é precedido, imediatamente, pela guarda da pessoa", () => {
      const envios = [...FONTE.matchAll(/liveChannel\(\)\.send\(/g)].map((m) => m.index!);
      expect(envios.length).toBeGreaterThanOrEqual(4);
      for (const i of envios) {
        const antes = FONTE.slice(Math.max(0, i - 260), i);
        expect(antes, `envio ao canal sem a guarda, na posição ${i}`).toContain(
          "if (await pessoaAssumiuDuranteOTurno()) return ENVIO_ABORTADO_PELA_PESSOA;",
        );
      }
    });

    it("a guarda lê o veto completo (silêncio + dono) e descarta o turno inteiro", () => {
      const i = FONTE.indexOf("const pessoaAssumiuDuranteOTurno = async");
      expect(i).toBeGreaterThan(-1);
      const corpo = FONTE.slice(i, FONTE.indexOf("};", i));
      expect(corpo).toContain("if (preview) return false;");
      expect(corpo).toContain("iaVetadaNoEnvio(pool, tenantId, leadId, input.conversationId, { jobDoTurno: liveJob().id })");
      expect(corpo).toContain("turnoDescartado = true;");
    });

    it("o aborto é `unavailable` com motivo próprio — nunca `blocked` (que é opt-out)", () => {
      const i = FONTE.indexOf("const ENVIO_ABORTADO_PELA_PESSOA");
      const decl = FONTE.slice(i, FONTE.indexOf("};", i));
      expect(decl).toContain("kind: 'unavailable'");
      expect(decl).toContain("reason: MOTIVO_PESSOA_ASSUMIU_NO_TURNO");
      expect(FONTE).not.toMatch(/handoff humano durante o turno[\s\S]{0,200}kind: 'blocked'/);
    });

    it("o `unavailable` da pessoa é respondido ao modelo ANTES de virar erro do run", () => {
      const i = FONTE.indexOf("case 'unavailable':");
      expect(i).toBeGreaterThan(-1);
      const ramo = FONTE.slice(i, FONTE.indexOf("noteRunError(", i));
      expect(ramo).toContain("if (outcome.reason === MOTIVO_PESSOA_ASSUMIU_NO_TURNO) return ERRO_PESSOA_ASSUMIU;");
    });
  });

  // 8. Isolamento entre tenants: nenhuma operação cruza organizações
  it("8. Isolamento entre tenants: tentativa de envio com org diferente é rejeitada com 404", async () => {
    wahaConfigured();
    // Simula o Supabase onde a organização é operante, mas o filtro
    // .eq("organization_id", ctx.organization_id) não encontra a conversa de outro tenant (data: null).
    const supabaseMock = {
      from: (table: string) => ({
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => {
              if (table === "organizations") return { data: { status: "active" }, error: null };
              return { data: null, error: null };
            },
          };
          return chain;
        },
      }),
    } as unknown as Parameters<typeof sendMessageHandler>[0];

    const ctxOrgB: HandlerCtx = {
      organization_id: ORG_B,
      actor: { type: "user", id: TECNICO_RESPONSAVEL },
      requestId: "req-org-b-1",
    };

    await expect(sendMessageHandler(supabaseMock, ctxOrgB, inputMsg)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });
});

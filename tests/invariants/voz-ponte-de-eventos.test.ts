/**
 * A PONTE DE EVENTOS DA CHAMADA DE VOZ, CONTRA POSTGRES DE VERDADE.
 *
 * Quase tudo que `lib/wacalls/events-bridge.ts` faz é SQL: calar a IA enquanto
 * a ligação está de pé, devolvê-la ao desligar, abrir o aviso de perdida,
 * gravar o evento de registro, carimbar a linha do tempo do negócio. Um dublê
 * de `pg.Pool` mediria o TEXTO das consultas — que é a forma, não o desfecho —
 * e é exatamente o tipo de teste que fica verde quando o efeito muda. Aqui a
 * função REAL roda contra o container efêmero e o teste lê o ESTADO que sobrou.
 *
 * Cinco defeitos medidos no PR #628 e consertados, cada um com o seu caso:
 *
 *  1. a IA seguia respondendo por cima de uma ligação em andamento;
 *  2. o evento `voice_call.ended` nascia `pending` e nenhum handler o
 *     consumia — `lib/event-log/drain.ts` filtra por tipos declarados, então a
 *     linha ficava pendurada para sempre com cara de trabalho na fila;
 *  3. o aviso de chamada perdida apontava `ref_kind='voice_call'`, que não
 *     existe em `REFERENCIAS_DE_AVISO`, e o corpo era `Motivo: user_ended`;
 *  4. a atividade na linha do tempo dizia "Sistema" mesmo havendo alguém na
 *     linha, e uma ligação atendida não quebrava o silêncio do negócio;
 *  5. `wacalls_paired_at is distinct from now()` nunca casa falso, então cada
 *     heartbeat reescrevia a sessão e logava "sessão pareada" de novo.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { despacharEventoWacalls } from "@/lib/wacalls/events-bridge";
import type { WacallsSessionMap } from "@/lib/wacalls/events-bridge";

import {
  GOV_AGENT_A,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_SESSION,
  GOV_STAGE,
  seedGov,
  sql,
} from "./gov-helpers";

/** Fixtures próprias: este arquivo mexe em `bot_silenced_until` e em `channel_sessions`. */
const VOZ_SESSAO = "cccccccc-2222-4000-8000-0000000000v1".replace("v", "a");
const VOZ_CONTATO = "cccccccc-3333-4000-8000-0000000000f1";
const VOZ_CONVERSA = "cccccccc-4444-4000-8000-0000000000f1";
const VOZ_NEGOCIO = "cccccccc-6666-4000-8000-0000000000f1";
const SESSAO_UPSTREAM = "wacalls-sessao-de-teste";
// Duas formas, e a diferença é o defeito que este arquivo pegou: o WhatsApp
// manda o peer em dígitos puros, e `contacts.phone_number` guarda E.164 com
// '+' (constraint `contacts_phone_e164_format`). Uma fixture com a mesma forma
// nos dois lados casaria por acidente e esconderia a ponte que não normaliza.
const TELEFONE = "5511977770000";
const TELEFONE_E164 = `+${TELEFONE}`;

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 2,
});

const logMudo = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof despacharEventoWacalls>[3];

/** Cache vazio a cada despacho: força a resolução real da sessão pelo banco. */
function despachar(ev: Record<string, unknown>): Promise<void> {
  const cache = new Map<string, WacallsSessionMap>();
  return despacharEventoWacalls(pool, cache, JSON.stringify(ev), logMudo);
}

async function um<T extends pg.QueryResultRow>(texto: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await pool.query<T>(texto, params);
  return rows[0];
}

const CHAMADA = "chamada-de-teste-1";

beforeAll(async () => {
  seedGov();
  sql(`
    insert into public.channel_sessions
      (id, organization_id, provider, wacalls_session_id, status, webhook_secret_encrypted)
      values ('${VOZ_SESSAO}', '${GOV_ORG}', 'wacalls', '${SESSAO_UPSTREAM}', 'STARTING', '\\x00'::bytea)
      on conflict (id) do update set wacalls_session_id = excluded.wacalls_session_id,
                                     wacalls_paired_at = null, status = 'STARTING';
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${VOZ_CONTATO}', '${GOV_ORG}', 'Contato da Voz', '${TELEFONE_E164}')
      on conflict (id) do update set phone_number = excluded.phone_number;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${VOZ_CONVERSA}', '${GOV_ORG}', '${VOZ_CONTATO}', '${GOV_SESSION}', 'ai_handling')
      on conflict (id) do update set bot_silenced_until = null, last_handoff_reason = null;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, last_activity_at)
      values ('${VOZ_NEGOCIO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${VOZ_CONTATO}', 'Negocio da voz', 'open', now() - interval '30 days')
      on conflict (id) do update set last_activity_at = now() - interval '30 days';
    delete from public.voice_calls where organization_id = '${GOV_ORG}';
    delete from public.agent_inbox_items where organization_id = '${GOV_ORG}' and kind = 'voice_call_missed';
    delete from public.event_log where organization_id = '${GOV_ORG}' and event_type = 'voice_call.ended';
    delete from public.crm_lead_activities where organization_id = '${GOV_ORG}' and source_module = 'voice_calls';
  `);
  // Controle do instrumento: pool no MESMO banco do helper psql.
  const linha = await um<{ n: string }>(
    `select count(*)::text as n from public.channel_sessions where id = $1`,
    [VOZ_SESSAO],
  );
  if (linha?.n !== "1") {
    throw new Error(`o pool não vê a sessão de voz semeada (porta ${PORTA})`);
  }
});

afterAll(async () => {
  await pool.end();
});

describe("pareamento — o heartbeat não reescreve a sessão a cada minuto", () => {
  it("o primeiro auth-state pareia; os seguintes não tocam na linha", async () => {
    await despachar({ type: "auth-state", sessionId: SESSAO_UPSTREAM, paired: true, state: "open" });
    const depois = await um<{ pareada: string; status: string; atualizada: string }>(
      `select wacalls_paired_at::text as pareada, status, updated_at::text as atualizada
         from public.channel_sessions where id = $1`,
      [VOZ_SESSAO],
    );
    expect(depois?.pareada).not.toBeNull();
    expect(depois?.status).toBe("WORKING");

    // O SEGUNDO heartbeat. Com a guarda antiga (`is distinct from now()`) esta
    // linha era reescrita — `now()` é sempre distinto de qualquer valor.
    await despachar({ type: "auth-state", sessionId: SESSAO_UPSTREAM, paired: true, state: "open" });
    const denovo = await um<{ pareada: string; atualizada: string }>(
      `select wacalls_paired_at::text as pareada, updated_at::text as atualizada
         from public.channel_sessions where id = $1`,
      [VOZ_SESSAO],
    );
    expect(denovo?.pareada).toBe(depois?.pareada);
    expect(denovo?.atualizada).toBe(depois?.atualizada);
  });

  it("sessão que caiu e voltou é remarcada como WORKING", async () => {
    // A guarda não pode ser só "já pareou": uma queda deixaria a linha parada
    // em STOPPED para sempre.
    await pool.query(`update public.channel_sessions set status = 'STOPPED' where id = $1`, [
      VOZ_SESSAO,
    ]);
    await despachar({ type: "auth-state", sessionId: SESSAO_UPSTREAM, paired: true, state: "open" });
    const linha = await um<{ status: string }>(
      `select status from public.channel_sessions where id = $1`,
      [VOZ_SESSAO],
    );
    expect(linha?.status).toBe("WORKING");
  });
});

describe("a IA se cala enquanto a ligação está de pé", () => {
  it("connected silencia a conversa do contato; ended devolve a voz", async () => {
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: CHAMADA,
      status: "ringing",
      peer: `${TELEFONE}@s.whatsapp.net`,
      direction: "inbound",
      startedAt: Date.now(),
    });
    // Tocando ainda não é falar: ninguém foi calado.
    let conv = await um<{ ate: string | null }>(
      `select bot_silenced_until::text as ate from public.conversations where id = $1`,
      [VOZ_CONVERSA],
    );
    expect(conv?.ate).toBeNull();

    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: CHAMADA,
      status: "connected",
      peer: `${TELEFONE}@s.whatsapp.net`,
      direction: "inbound",
      startedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    conv = await um<{ ate: string | null }>(
      `select bot_silenced_until::text as ate from public.conversations where id = $1`,
      [VOZ_CONVERSA],
    );
    expect(conv?.ate).not.toBeNull();
    const vigente = await um<{ calada: boolean }>(
      `select (bot_silenced_until > now()) as calada from public.conversations where id = $1`,
      [VOZ_CONVERSA],
    );
    expect(vigente?.calada).toBe(true);

    // Teto, não 'infinity': se esta ponte morrer entre o connected e o ended, o
    // silêncio expira sozinho em vez de deixar a conversa muda para sempre.
    const teto = await um<{ finito: boolean }>(
      `select (bot_silenced_until < 'infinity'::timestamptz) as finito
         from public.conversations where id = $1`,
      [VOZ_CONVERSA],
    );
    expect(teto?.finito).toBe(true);

    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: CHAMADA,
      reason: "user_ended",
      endedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    conv = await um<{ ate: string | null }>(
      `select bot_silenced_until::text as ate from public.conversations where id = $1`,
      [VOZ_CONVERSA],
    );
    expect(conv?.ate).toBeNull();
  });

  it("desligar NÃO apaga o silêncio que outro dono pôs", async () => {
    // Um atendente assume a conversa no meio da ligação. Ao desligar, a ponte
    // devolveria a voz à IA numa conversa que uma pessoa tomou para si — o
    // atropelo que o predicado do motivo existe para impedir.
    await pool.query(
      `update public.conversations
          set bot_silenced_until = 'infinity', last_handoff_reason = 'Atendente assumiu'
        where id = $1`,
      [VOZ_CONVERSA],
    );
    await pool.query(`delete from public.voice_calls where organization_id = $1`, [GOV_ORG]);
    const outra = "chamada-de-teste-2";
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: outra,
      status: "connected",
      peer: `${TELEFONE}@s.whatsapp.net`,
      direction: "inbound",
      startedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: outra,
      reason: "user_ended",
      endedAt: Date.now(),
    });
    const conv = await um<{ motivo: string | null; duravel: boolean | null }>(
      `select last_handoff_reason as motivo,
              (bot_silenced_until = 'infinity'::timestamptz) as duravel
         from public.conversations where id = $1`,
      [VOZ_CONVERSA],
    );
    expect(conv?.motivo).toBe("Atendente assumiu");
    expect(conv?.duravel).toBe(true);
    // Limpa para os casos seguintes.
    await pool.query(
      `update public.conversations set bot_silenced_until = null, last_handoff_reason = null where id = $1`,
      [VOZ_CONVERSA],
    );
  });
});

describe("chamada perdida vira aviso com porta, e o motivo vira frase de gente", () => {
  const PERDIDA = "chamada-de-teste-3";

  // O negócio volta a esfriar ANTES deste bloco, e não é zelo: o bloco anterior
  // ("a IA se cala") ATENDE chamadas, e ligação atendida quebra o silêncio de
  // propósito (0079). Sem este reset, o caso do silêncio abaixo mediria o estado
  // que o vizinho deixou em vez do efeito da chamada perdida — passaria ou
  // falharia pela ordem dos testes, que é o pior tipo de verde.
  beforeAll(async () => {
    await pool.query(
      `update public.crm_leads set last_activity_at = now() - interval '30 days' where id = $1`,
      [VOZ_NEGOCIO],
    );
  });

  it("o aviso aponta para o contato e não carrega token do upstream", async () => {
    await pool.query(`delete from public.voice_calls where organization_id = $1`, [GOV_ORG]);
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: PERDIDA,
      status: "ringing",
      peer: `${TELEFONE}@s.whatsapp.net`,
      direction: "inbound",
      startedAt: Date.now(),
    });
    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: PERDIDA,
      reason: "do_not_disturb",
      endedAt: Date.now(),
    });

    const aviso = await um<{
      kind: string;
      title: string;
      body: string;
      ref_kind: string | null;
      ref_id: string | null;
    }>(
      `select kind, title, body, ref_kind, ref_id from public.agent_inbox_items
        where organization_id = $1 and kind = 'voice_call_missed'
        order by created_at desc limit 1`,
      [GOV_ORG],
    );
    expect(aviso).toBeDefined();
    // `contact` existe em REFERENCIAS_DE_AVISO; `voice_call` não existia, e o
    // aviso caía em "indisponível" com botão nenhum.
    expect(aviso?.ref_kind).toBe("contact");
    expect(aviso?.ref_id).toBe(VOZ_CONTATO);
    expect(aviso?.title).toContain(TELEFONE);
    expect(aviso?.body).not.toContain("do_not_disturb");
    expect(aviso?.body).toMatch(/não perturbe/i);
  });

  it("chamada perdida NÃO quebra o silêncio do negócio", async () => {
    // 0079: telefone que tocou sem resposta é constatação de silêncio, não
    // interação. Carimbar `last_activity_at` aqui esfriaria o Radar de Risco
    // por um contato com quem ninguém falou.
    const lead = await um<{ velho: boolean }>(
      `select (last_activity_at < now() - interval '20 days') as velho
         from public.crm_leads where id = $1`,
      [VOZ_NEGOCIO],
    );
    expect(lead?.velho).toBe(true);
    const atividade = await um<{ tipo: string; ator: string }>(
      `select type as tipo, actor_kind as ator from public.crm_lead_activities
        where organization_id = $1 and source_module = 'voice_calls'
        order by created_at desc limit 1`,
      [GOV_ORG],
    );
    expect(atividade?.tipo).toBe("voice_call_missed");
  });
});

describe("ligação atendida: dono, silêncio quebrado, evento consumido", () => {
  const ATENDIDA = "chamada-de-teste-4";

  it("quem atendeu assina a linha do tempo e o negócio deixa de ser frio", async () => {
    await pool.query(`delete from public.voice_calls where organization_id = $1`, [GOV_ORG]);
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: ATENDIDA,
      status: "connected",
      peer: `${TELEFONE}@s.whatsapp.net`,
      direction: "inbound",
      startedAt: Date.now() - 60_000,
      owner: GOV_AGENT_A,
    });
    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: ATENDIDA,
      reason: "user_ended",
      endedAt: Date.now(),
      owner: GOV_AGENT_A,
    });

    const chamada = await um<{ dono: string | null; atendida: string | null }>(
      `select owner_user_id as dono, answered_at::text as atendida
         from public.voice_calls where organization_id = $1 and wacalls_call_id = $2`,
      [GOV_ORG, ATENDIDA],
    );
    expect(chamada?.dono).toBe(GOV_AGENT_A);
    expect(chamada?.atendida).not.toBeNull();

    const atividade = await um<{ tipo: string; ator: string; quem: string | null }>(
      `select type as tipo, actor_kind as ator, performed_by_user_id as quem
         from public.crm_lead_activities
        where organization_id = $1 and source_module = 'voice_calls'
        order by created_at desc limit 1`,
      [GOV_ORG],
    );
    expect(atividade?.tipo).toBe("voice_call");
    // Dizia 'system' — a linha do tempo do negócio nomeava "Sistema" onde havia
    // uma pessoa, porque o `owner` que o upstream manda era descartado.
    expect(atividade?.ator).toBe("user");
    expect(atividade?.quem).toBe(GOV_AGENT_A);

    // 0079: ligação ATENDIDA é interação. Sem esta linha o Radar de Risco
    // seguia marcando como frio quem acabou de falar ao telefone.
    const lead = await um<{ quente: boolean }>(
      `select (last_activity_at > now() - interval '1 minute') as quente
         from public.crm_leads where id = $1`,
      [VOZ_NEGOCIO],
    );
    expect(lead?.quente).toBe(true);
  });

  it("o evento de registro nasce 'done', não pendurado na fila para sempre", async () => {
    const ev = await um<{ status: string }>(
      `select status from public.event_log
        where organization_id = $1 and event_type = 'voice_call.ended'
        order by created_at desc limit 1`,
      [GOV_ORG],
    );
    // `lib/event-log/drain.ts` só enxerga tipos com handler declarado. Nascendo
    // `pending`, esta linha ficava para sempre com cara de trabalho na fila —
    // e `event_log` não tem poda.
    expect(ev?.status).toBe("done");
  });

  it("o trabalho ao telefone aparece nas métricas do atendente", async () => {
    const metricas = await um<{ atendidas: number }>(
      `select coalesce((
         select (a ->> 'calls_answered')::int
           from jsonb_array_elements(
                  public.fn_attendant_metrics($1, now() - interval '1 day', now() + interval '1 day', $2)
                  -> 'attendants') as a
          where a ->> 'user_id' = $2::text
       ), 0) as atendidas`,
      [GOV_ORG, GOV_AGENT_A],
    );
    expect(metricas?.atendidas).toBeGreaterThanOrEqual(1);
  });
});

describe("LGPD: o telefone de quem ligou não sobrevive à anonimização", () => {
  it("a cascata alcança voice_calls", async () => {
    const antes = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls
        where organization_id = $1 and contact_id = $2 and peer_phone = $3`,
      [GOV_ORG, VOZ_CONTATO, TELEFONE],
    );
    expect(Number(antes?.n)).toBeGreaterThan(0);

    await pool.query(`select public.fn_lgpd_cascade_redact_contact($1, $2, gen_random_uuid())`, [
      GOV_ORG,
      VOZ_CONTATO,
    ]);

    const sobrou = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls
        where organization_id = $1 and peer_phone = $2`,
      [GOV_ORG, TELEFONE],
    );
    // Sobrevivendo, o número real reidentifica quem pediu para ser esquecido.
    expect(sobrou?.n).toBe("0");

    // O REGISTRO fica: duração e desfecho sustentam métrica e fatura e não
    // identificam ninguém. Anonimizar não é apagar a contabilidade.
    const restou = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls where organization_id = $1`,
      [GOV_ORG],
    );
    expect(Number(restou?.n)).toBeGreaterThan(0);
    const dono = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls
        where organization_id = $1 and owner_user_id is not null`,
      [GOV_ORG],
    );
    expect(dono?.n).toBe("0");
  });
});

describe("apagar o canal não apaga o histórico de ligações", () => {
  it("a FK recusa a exclusão em vez de cascatear o histórico embora", async () => {
    await expect(
      pool.query(`delete from public.channel_sessions where id = $1`, [VOZ_SESSAO]),
    ).rejects.toThrow(/violates foreign key constraint|voice_calls/i);
    const sobrou = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls where channel_session_id = $1`,
      [VOZ_SESSAO],
    );
    expect(Number(sobrou?.n)).toBeGreaterThan(0);
  });
});

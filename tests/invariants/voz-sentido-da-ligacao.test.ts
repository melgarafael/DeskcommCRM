/**
 * O SENTIDO DA LIGAÇÃO QUANDO O EVENTO NÃO O TRAZ — contra Postgres de verdade.
 *
 * `call-status` sai do broker do WaCalls SEM `direction`
 * (`internal/app/events/callregistry.go`: `type, sessionId, id, owner, status,
 * peer, startedAt, peerName, peerPhotoUrl`). A versão anterior de
 * `lib/wacalls/events-bridge.ts` caía em 'inbound' sempre que o campo faltava —
 * isto é, em TODA ligação feita pelo CRM: o painel dizia "Conectando…" em vez
 * de "Chamando…", e a que ninguém atendeu abria "Chamada perdida" na Central
 * pedindo para ligar de volta a quem acabou de ligar. Medido na VPS em
 * 2026-09-15: duas ligações feitas, duas linhas `inbound`, dois avisos falsos.
 *
 * Arquivo próprio (e não casos novos em `voz-ponte-de-eventos.test.ts`) porque
 * `tests/invariants/**` existente é congelado pelo pre-commit — e porque estas
 * fixtures são suas: sessão, contato e negócio com ids que nenhum outro
 * invariante toca.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { despacharEventoWacalls } from "@/lib/wacalls/events-bridge";
import type { WacallsSessionMap } from "@/lib/wacalls/events-bridge";

import { GOV_AGENT_A, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

const VOZ_SESSAO = "cccccccc-2222-4000-8000-0000000000d1";
const VOZ_CONTATO = "cccccccc-3333-4000-8000-0000000000d1";
const VOZ_NEGOCIO = "cccccccc-6666-4000-8000-0000000000d1";
const SESSAO_UPSTREAM = "wacalls-sessao-do-sentido";
// Dígitos puros no evento, E.164 com '+' no contato — as duas formas de
// propósito, como em voz-ponte-de-eventos.test.ts.
const TELEFONE = "5511966660000";
const TELEFONE_E164 = `+${TELEFONE}`;
const PEER = `${TELEFONE}@s.whatsapp.net`;

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

async function sentido(id: string) {
  return um<{ direction: string; status: string; contato: string | null; atendida: string | null }>(
    `select direction, status, contact_id as contato, answered_at::text as atendida
       from public.voice_calls where organization_id = $1 and wacalls_call_id = $2`,
    [GOV_ORG, id],
  );
}

async function avisos(): Promise<number> {
  const r = await um<{ n: string }>(
    `select count(*)::text as n from public.agent_inbox_items
      where organization_id = $1 and kind = 'voice_call_missed' and title like '%' || $2 || '%'`,
    [GOV_ORG, TELEFONE],
  );
  return Number(r?.n ?? 0);
}

beforeAll(async () => {
  seedGov();
  sql(`
    insert into public.channel_sessions
      (id, organization_id, provider, wacalls_session_id, status, webhook_secret_encrypted)
      values ('${VOZ_SESSAO}', '${GOV_ORG}', 'wacalls', '${SESSAO_UPSTREAM}', 'WORKING', '\\x00'::bytea)
      on conflict (id) do update set wacalls_session_id = excluded.wacalls_session_id;
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${VOZ_CONTATO}', '${GOV_ORG}', 'Contato do Sentido', '${TELEFONE_E164}')
      on conflict (id) do update set phone_number = excluded.phone_number;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status)
      values ('${VOZ_NEGOCIO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${VOZ_CONTATO}', 'Negocio do sentido', 'open')
      on conflict (id) do nothing;
    delete from public.voice_calls where organization_id = '${GOV_ORG}' and peer_phone = '${TELEFONE}';
    delete from public.agent_inbox_items
      where organization_id = '${GOV_ORG}' and kind = 'voice_call_missed' and title like '%${TELEFONE}%';
  `);
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

describe("o sentido da ligação quando o evento não o traz", () => {
  const FEITA = "sentido-feita";
  const RECEBIDA = "sentido-recebida";
  const NASCIDA_DO_INCOMING = "sentido-incoming";
  const DO_SNAPSHOT = "sentido-snapshot";
  const CORRIGIDA = "sentido-corrigida";

  it("com dono e sem direction nasce FEITA; sem resposta, fica na linha do tempo como 'sem resposta' e NÃO abre 'perdida'", async () => {
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: FEITA,
      status: "ringing",
      peer: PEER,
      startedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    expect((await sentido(FEITA))?.direction).toBe("outbound");

    const antes = await avisos();
    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: FEITA,
      reason: "timeout",
      endedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    // Quem discou já sabe que ninguém atendeu: um aviso pedindo para "ligar de
    // volta" a quem acabou de ligar é ruído com cara de urgência.
    expect(await avisos()).toBe(antes);
    const atividade = await um<{ tipo: string }>(
      `select type as tipo from public.crm_lead_activities
        where organization_id = $1 and source_module = 'voice_calls'
          and source_id = (select id from public.voice_calls
                            where organization_id = $1 and wacalls_call_id = $2)`,
      [GOV_ORG, FEITA],
    );
    // Tipo próprio: a linha do tempo rotula pelo tipo, e `voice_call_missed`
    // escrevia "Chamada de voz perdida" no negócio de quem acabou de discar.
    expect(atividade?.tipo).toBe("voice_call_unanswered");
  });

  it("sem dono nasce RECEBIDA, `incoming` confirma sem duplicar, e sem resposta continua abrindo o aviso", async () => {
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: RECEBIDA,
      status: "ringing",
      peer: PEER,
      startedAt: Date.now(),
      owner: null,
    });
    expect((await sentido(RECEBIDA))?.direction).toBe("inbound");
    await despachar({
      type: "incoming",
      sessionId: SESSAO_UPSTREAM,
      id: RECEBIDA,
      peer: PEER,
      offeredAt: Date.now(),
    });
    const linhas = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls
        where organization_id = $1 and wacalls_call_id = $2`,
      [GOV_ORG, RECEBIDA],
    );
    expect(linhas?.n).toBe("1");

    const antes = await avisos();
    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: RECEBIDA,
      reason: "timeout",
      endedAt: Date.now(),
    });
    expect(await avisos()).toBe(antes + 1);
  });

  it("`incoming` sem call-status anterior cria a linha como recebida, tocando, com o contato resolvido", async () => {
    await despachar({
      type: "incoming",
      sessionId: SESSAO_UPSTREAM,
      id: NASCIDA_DO_INCOMING,
      peer: PEER,
      offeredAt: Date.now(),
    });
    const linha = await sentido(NASCIDA_DO_INCOMING);
    expect(linha).toMatchObject({ direction: "inbound", status: "ringing", contato: VOZ_CONTATO });
  });

  it("o snapshot call-list da reconexão grava o sentido verdadeiro, mesmo sem dono", async () => {
    // Única fonte no stream que carrega `direction`; cobre a ligação que
    // começou enquanto a ponte estava caída.
    await despachar({
      type: "call-list",
      calls: [
        {
          sessionId: SESSAO_UPSTREAM,
          callId: DO_SNAPSHOT,
          direction: "outbound",
          peer: PEER,
          startedAt: Date.now(),
          status: "connected",
          owner: null,
        },
      ],
    });
    const linha = await sentido(DO_SNAPSHOT);
    expect(linha?.direction).toBe("outbound");
    expect(linha?.status).toBe("connected");
    expect(linha?.atendida).not.toBeNull();
  });

  it("defesa: `incoming` corrige para recebida uma linha cuja inferência errou", async () => {
    // O upstream emite `incoming` uma vez, logo depois do primeiro
    // `call-status`; esta ORDEM (connected com dono antes do incoming) não é a
    // do produto. O caso prende a correção em si, que é o que protege quando a
    // inferência pelo dono falhar por qualquer motivo.
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: CORRIGIDA,
      status: "connected",
      peer: PEER,
      startedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    expect((await sentido(CORRIGIDA))?.direction).toBe("outbound");
    await despachar({
      type: "incoming",
      sessionId: SESSAO_UPSTREAM,
      id: CORRIGIDA,
      peer: PEER,
      offeredAt: Date.now(),
    });
    expect((await sentido(CORRIGIDA))?.direction).toBe("inbound");
  });
  it("o snapshot DECLARA o sentido e corrige a linha que a inferência já tinha gravado", async () => {
    // Ligação feita fora do CRM (sem dono) nasce 'inbound' pela inferência; a
    // reconexão traz o `call-list` com `direction` verdadeiro. Sem reescrever no
    // conflito, a linha seguia recebida e abria "perdida" ao terminar.
    const ID = "sentido-snapshot-corrige";
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: ID,
      status: "ringing",
      peer: PEER,
      startedAt: Date.now(),
      owner: null,
    });
    expect((await sentido(ID))?.direction).toBe("inbound");
    await despachar({
      type: "call-list",
      calls: [{ sessionId: SESSAO_UPSTREAM, callId: ID, direction: "outbound", peer: PEER, startedAt: Date.now(), status: "ringing", owner: null }],
    });
    expect((await sentido(ID))?.direction).toBe("outbound");
  });

  it("o snapshot não aborta no primeiro registro ruim: os seguintes entram", async () => {
    const BOM = "sentido-snapshot-depois-do-ruim";
    await despachar({
      type: "call-list",
      calls: [
        { sessionId: SESSAO_UPSTREAM, id: "chave-errada", status: "ringing", peer: PEER },
        { sessionId: SESSAO_UPSTREAM, callId: "sentido-status-invalido", direction: "outbound", peer: PEER, startedAt: Date.now(), status: "status-que-o-check-recusa", owner: null },
        { sessionId: SESSAO_UPSTREAM, callId: BOM, direction: "outbound", peer: PEER, startedAt: Date.now(), status: "ringing", owner: null },
      ],
    });
    expect((await sentido(BOM))?.direction).toBe("outbound");
  });

  it("`incoming` sem id ou sem peer não cria linha fantasma", async () => {
    const antes = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls where organization_id = $1`,
      [GOV_ORG],
    );
    await despachar({ type: "incoming", sessionId: SESSAO_UPSTREAM, peer: PEER, offeredAt: Date.now() });
    await despachar({ type: "incoming", sessionId: SESSAO_UPSTREAM, id: "sem-peer", offeredAt: Date.now() });
    const depois = await um<{ n: string }>(
      `select count(*)::text as n from public.voice_calls where organization_id = $1`,
      [GOV_ORG],
    );
    expect(depois?.n).toBe(antes?.n);
    expect(await sentido("undefined")).toBeUndefined();
  });
});

describe("o contato da ligação pelas duas grafias do nono dígito", () => {
  it("peer SEM o nono acha o contato cadastrado COM o nono", async () => {
    // O caso medido: o WhatsApp registra `553198966398`, o CRM guarda
    // `+5531998966398`. Com a ligação discada para o endereço certo, casar só
    // `'+' || peer` deixaria toda ligação desse contato sem ele.
    const SEM_NONO = TELEFONE.slice(0, 4) + TELEFONE.slice(5); // 55 11 [9]66660000
    const ID = "grafia-sem-nono";
    await despachar({
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: ID,
      status: "ringing",
      peer: `${SEM_NONO}@s.whatsapp.net`,
      startedAt: Date.now(),
      owner: GOV_AGENT_A,
    });
    expect((await sentido(ID))?.contato).toBe(VOZ_CONTATO);

    const INCOMING = "grafia-sem-nono-incoming";
    await despachar({
      type: "incoming",
      sessionId: SESSAO_UPSTREAM,
      id: INCOMING,
      peer: `${SEM_NONO}@s.whatsapp.net`,
      offeredAt: Date.now(),
    });
    expect((await sentido(INCOMING))?.contato).toBe(VOZ_CONTATO);
  });
});

describe("o aparelho desvinculado pelo celular volta a 'não pareado'", () => {
  async function pareamento() {
    return um<{ pareada: boolean; status: string }>(
      `select wacalls_paired_at is not null as pareada, status from public.channel_sessions where id = $1`,
      [VOZ_SESSAO],
    );
  }

  it("logged_out limpa o pareamento; o QR de um pareamento em curso não", async () => {
    await pool.query(
      `update public.channel_sessions set wacalls_paired_at = now(), status = 'WORKING' where id = $1`,
      [VOZ_SESSAO],
    );

    // Controle: `paired:false` com state 'qr' é o pareamento emitindo código.
    await despachar({ type: "auth-state", sessionId: SESSAO_UPSTREAM, paired: false, state: "qr", qr: "x" });
    expect(await pareamento()).toEqual({ pareada: true, status: "WORKING" });

    // Sem isto a tela seguia "pareado", o botão Chamar ficava oferecido e parear
    // de novo recebia 409 — um beco sem saída.
    await despachar({ type: "auth-state", sessionId: SESSAO_UPSTREAM, paired: false, state: "logged_out" });
    expect(await pareamento()).toEqual({ pareada: false, status: "STOPPED" });

    // E pareando de novo, a mesma ponte marca pareada outra vez.
    await despachar({ type: "auth-state", sessionId: SESSAO_UPSTREAM, paired: true, state: "open" });
    expect(await pareamento()).toEqual({ pareada: true, status: "WORKING" });
  });
});

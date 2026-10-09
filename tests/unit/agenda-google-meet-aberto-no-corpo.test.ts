// @vitest-environment node
/**
 * O ESPAÇO ABERTO NASCE, E A MESMA ESCRITA JÁ LEVA O LINK (#2063, itens 2 e 3).
 *
 * O executor inteiro roda aqui contra um banco e um Google de mentira, mas com
 * a MESMA superfície que os invariantes exercem de verdade: `fn_google_appointment`
 * (claim/prepare/renew/commit/meet/idle/release) e o transporte HTTP. O que se
 * prova é ordem e conteúdo de escrita — as duas coisas que o review de 08/10
 * mediu por leitura de código e que os testes de unidade não cobriam:
 *
 *   1. com a opção ligada, a PRIMEIRA publicação já sai com o link do espaço
 *      aberto no `location` — o convidado recebe UM convite com a sala, não um
 *      convite sem link e um "alterado" cinco minutos depois;
 *   2. a passada seguinte NÃO escreve nada: o link publicado é o do espaço
 *      aberto, a projeção converge, e nenhum PATCH `sendUpdates=all` sai para
 *      os convidados;
 *   3. desligada (o padrão), o comportamento da main é o mesmo byte a byte:
 *      `conferenceData.createRequest` no POST, o link do Calendar chegando
 *      DEPOIS sem virar escrita nenhuma.
 */
import { describe, expect, it } from "vitest";

import { decidirEspacoAberto, reconcileAppointment } from "@/lib/agenda/google/sync-executor";
import { hash } from "@/lib/agenda/google/sync-model";
import { ESCOPO_MEET_ESPACO_ABERTO } from "@/lib/agenda/google/oauth";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONN = "33333333-3333-4333-8333-333333333333";
const ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const EVENTO = "deskcommapp22222222222242228222222222222222";
const PEDIDO = "66666666-6666-4666-8666-666666666666";
const TOKEN = "77777777-7777-4777-8777-777777777777";
const LINK = "https://meet.google.com/abc-defg-hij";
const EMAIL = "cliente@clinica.test";
const DETALHE = "Atendimento online";

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

/** O `conferenceData` que o Calendar devolve quando ELE cria o Meet. */
const conferenciaDoCalendar = () => ({
  createRequest: { requestId: PEDIDO, status: { statusCode: "success" } },
  conferenceSolution: { key: { type: "hangoutsMeet" } },
  entryPoints: [{ entryPointType: "video", uri: LINK }],
});

/**
 * Um banco de mentira com a superfície real: `rpc` fala `fn_google_appointment`
 * e `from` devolve as três tabelas que o executor lê. As semânticas de
 * `meet`/`commit` espelham `fn_meet_observe` e o `update` do commit.
 */
function banco(opcaoLigada: boolean) {
  const linha: Record<string, unknown> = {
    id: ID,
    organization_id: ORG,
    owner_user_id: OWNER,
    contact_id: CONTATO,
    title: "Consulta de avaliação",
    description: null,
    starts_at: "2026-09-02T17:00:00+00:00",
    ends_at: "2026-09-02T17:30:00+00:00",
    time_zone: "America/Sao_Paulo",
    status: "pending",
    location_kind: "google_meet",
    location_details: DETALHE,
    guest_email: null,
    revision: "1",
    google_local_revision: "1",
    google_synced_local_revision: "0",
    google_connection_id: CONN,
    google_calendar_id: "primary",
    google_event_id: EVENTO,
    google_etag: null,
    google_base_projection: null,
    google_conflict: null,
    google_pending_write: { reservation: true },
    google_claim_token: null,
    google_claim_epoch: 0,
    google_claim_until: null,
    meeting_allowed_types: ["hangoutsMeet"],
    meeting_state: "pending",
    meeting_request_id: PEDIDO,
    meeting_requested_at: "2026-09-02T10:00:00+00:00",
    meeting_received_at: null,
    meeting_ready_at: null,
    meeting_url: null,
    meeting_last_error: null,
    meeting_attempts: 0,
    meeting_next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const snapshot = () => ({
    ...linha,
    revision: String(linha.revision),
    google_local_revision: String(linha.google_local_revision),
    google_synced_local_revision: String(linha.google_synced_local_revision),
    claim: {
      token: TOKEN,
      epoch: String(linha.google_claim_epoch),
      lease_until: new Date(Date.now() + 90_000).toISOString(),
    },
  });
  // `fn_meet_observe`: o recuso é o estado, não a linha inteira.
  const observar = (r: Record<string, unknown>) => {
    const agora = new Date().toISOString();
    linha.meeting_state = r.state;
    linha.meeting_url = r.state === "ready" ? r.url : null;
    linha.meeting_last_error = r.error ?? null;
    if (r.received) linha.meeting_received_at = linha.meeting_received_at ?? agora;
    linha.meeting_ready_at = r.state === "ready" ? (linha.meeting_ready_at ?? agora) : null;
    linha.meeting_attempts = Number(linha.meeting_attempts) + 1;
    if (r.etag) linha.google_etag = r.etag;
  };
  const confirmar = (resultado: Record<string, unknown>) => {
    if (resultado.base) linha.google_base_projection = resultado.base;
    if ("etag" in resultado) linha.google_etag = resultado.etag ?? null;
    if ("conflict" in resultado) linha.google_conflict = resultado.conflict ?? null;
    if (resultado.clear_pending) linha.google_pending_write = null;
    if (resultado.ack) linha.google_synced_local_revision = linha.google_local_revision;
  };
  const tabela = (registro: unknown) => {
    const nó: Record<string, unknown> = { maybeSingle: async () => ({ data: registro, error: null }) };
    nó.eq = () => nó;
    return { select: () => nó };
  };
  const tabelas: Record<string, ReturnType<typeof tabela>> = {
    organizations: tabela({ settings: opcaoLigada ? { google_meet_acesso_aberto: true } : {} }),
    calendar_connections: tabela({ scopes: [ESCOPO_MEET_ESPACO_ABERTO] }),
    contacts: tabela({ email: EMAIL, name: null, display_name: null, is_anonymized: false }),
  };
  const db = {
    linha,
    from: (tabelaNome: string) => tabelas[tabelaNome] ?? tabela(null),
    rpc: async (_nome: string, args: Record<string, unknown>) => ({
      data: await acao(args),
      error: null,
    }),
  };
  /** `fn_google_appointment` de mentira: a ação devolve a linha, o `rpc` o envelope. */
  async function acao(args: Record<string, unknown>): Promise<unknown> {
    {
      const nomeDaAcao = String(args.p_action);
      const p = (args.p_args ?? {}) as Record<string, Record<string, unknown>>;
      if (nomeDaAcao === "claim") {
        linha.google_claim_token = TOKEN;
        linha.google_claim_epoch = Number(linha.google_claim_epoch) + 1;
        linha.google_claim_until = new Date(Date.now() + 90_000).toISOString();
        return snapshot();
      }
      if (nomeDaAcao === "release") {
        linha.google_claim_token = null;
        linha.google_claim_until = null;
        return "true";
      }
      if (nomeDaAcao === "renew" || nomeDaAcao === "idle") return "true";
      if (nomeDaAcao === "prepare") {
        linha.google_pending_write = p.operation;
        return "true";
      }
      if (nomeDaAcao === "meet") {
        observar(p.result ?? {});
        return snapshot();
      }
      if (nomeDaAcao === "commit") {
        confirmar(p.result ?? {});
        return snapshot();
      }
      if (nomeDaAcao === "error") return "true";
      throw new Error(`ação desconhecida: ${nomeDaAcao}`);
    }
  }
  return { db, linha, snapshot };
}

/** O Google de mentira: guarda o evento escrito e devolve o eco de sempre. */
function google(eventoInicial?: Record<string, unknown>) {
  let remoto: Record<string, unknown> | null = eventoInicial ?? null;
  const escritas: Array<{ metodo: string; corpo: Record<string, unknown> }> = [];
  const espacosCriados: unknown[] = [];
  const transporte = async (url: RequestInfo | URL, init?: RequestInit) => {
    const destino = String(url);
    const metodo = init?.method ?? "GET";
    if (destino.startsWith("https://meet.googleapis.com/")) {
      espacosCriados.push(init?.body);
      return json({ name: "spaces/abc", meetingUri: LINK, config: { accessType: "OPEN" } });
    }
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (metodo === "GET") {
      if (destino.includes("/events/")) return remoto ? json(remoto) : json({ error: { code: 404 } }, 404);
      return json({ id: "primary" });
    }
    if (metodo === "POST") {
      escritas.push({ metodo, corpo });
      remoto = {
        id: EVENTO,
        etag: "etag-1",
        status: "confirmed",
        summary: corpo.summary,
        description: corpo.description ?? null,
        location: corpo.location ?? null,
        start: corpo.start,
        end: corpo.end,
        attendees: corpo.attendees ?? [],
        ...(corpo.conferenceData ? { conferenceData: conferenciaDoCalendar() } : {}),
      };
      return json(remoto);
    }
    if (metodo === "PATCH") {
      escritas.push({ metodo, corpo });
      remoto = { ...remoto!, ...corpo, etag: `etag-${escritas.length + 1}` };
      return json(remoto);
    }
    if (metodo === "DELETE") {
      escritas.push({ metodo, corpo: {} });
      remoto = { ...remoto!, status: "cancelled" };
      return json(remoto);
    }
    throw new Error(`chamada inesperada: ${metodo} ${destino}`);
  };
  return { transporte, escritas, espacosCriados, evento: () => remoto };
}

const passada = (db: unknown, transporte: unknown) =>
  reconcileAppointment(db as never, ORG, ID, { token: "token-de-teste", transport: transporte } as never);

describe("espaço aberto — a primeira escrita já leva o link (#2063)", () => {
  it("publica o evento COM o link, sem conferenceData, e a passada seguinte não escreve nada", async () => {
    const { db } = banco(true);
    const g = google();

    expect(await passada(db, g.transporte)).toBe("processed");

    // Item 3: UM convite, já com a sala.
    expect(g.espacosCriados).toHaveLength(1);
    expect(g.escritas).toHaveLength(1);
    const post = g.escritas[0]!;
    expect(post.metodo).toBe("POST");
    expect(post.corpo.location).toBe(LINK);
    expect(post.corpo).not.toHaveProperty("conferenceData");
    // O convite do POST é o da ficha do compromisso novo — decisão do doc 36.
    expect(post.corpo.attendees).toEqual([{ email: EMAIL, responseStatus: "needsAction" }]);

    // O marcador persistiu no registro da publicação, sem coluna nova.
    expect(linhaMeetingUrl(db)).toBe(LINK);
    expect(basePublicada(db).local.location).toBe(hash(LINK));

    // Item 2/3: a passada seguinte converge — NENHUMA escrita, nenhum
    // "evento alterado" com sendUpdates=all para os convidados.
    const antes = g.escritas.length;
    expect(await passada(db, g.transporte)).toBe("unchanged");
    expect(g.escritas).toHaveLength(antes);

    // E uma edição posterior manda SÓ o título: o link não é republicado e o
    // e-mail da ficha não vira convite retroativo.
    editar(db, { title: "Avaliação com a dra. Ana", revision: "2", google_local_revision: "2" });
    expect(await passada(db, g.transporte)).toBe("processed");
    expect(g.escritas).toHaveLength(antes + 1);
    const patch = g.escritas.at(-1)!;
    expect(patch.metodo).toBe("PATCH");
    expect(patch.corpo).toEqual({ summary: "Avaliação com a dra. Ana" });
  });

  it("o PATCH de reunião do caminho aberto também leva o link na mesma escrita", async () => {
    const { db } = banco(true);
    const g = google(EVENTO_JA_PUBLICADO);
    // Compromisso já publicado (sem Meet) e a reunião pedida agora: o link do
    // espaço aberto entra no MESMO PATCH que sai, não numa passada seguinte.
    publicarSemMeet(db);
    editar(db, { title: "Consulta reagendada", revision: "2", google_local_revision: "2" });

    expect(await passada(db, g.transporte)).toBe("processed");
    expect(g.espacosCriados).toHaveLength(1);
    const patch = g.escritas.at(-1)!;
    expect(patch.metodo).toBe("PATCH");
    expect(patch.corpo).toMatchObject({ summary: "Consulta reagendada", location: LINK });
    // O convite da ficha vai junto da ALTERAÇÃO (doc 36, opção b) — e só ele.
    expect(patch.corpo.attendees).toEqual([{ email: EMAIL, responseStatus: "needsAction" }]);
  });
});

describe("desligada (o padrão) — o comportamento da main, medido", () => {
  it("o POST sai com conferenceData e SEM o link; o link do Calendar que chega depois não vira escrita", async () => {
    const { db } = banco(false);
    const g = google();

    expect(await passada(db, g.transporte)).toBe("processed");
    expect(g.espacosCriados).toHaveLength(0);
    expect(g.escritas).toHaveLength(1);
    const post = g.escritas[0]!;
    expect(post.metodo).toBe("POST");
    expect(post.corpo.location).toBe(DETALHE);
    expect(post.corpo).toMatchObject({
      conferenceData: { createRequest: { requestId: PEDIDO, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    // O link do Calendar nasceu na resposta do POST: o recuso gravou o link,
    // e a projeção continuou a mesma. Nenhum PATCH sai por causa dele.
    expect(linhaMeetingUrl(db)).toBe(LINK);
    expect(basePublicada(db).local.location).toBe(hash(DETALHE));

    const antes = g.escritas.length;
    expect(await passada(db, g.transporte)).toBe("unchanged");
    expect(g.escritas).toHaveLength(antes);
  });

  it("sem o escopo opcional, a opção ligada não cria espaço nenhum", async () => {
    const { db } = banco(true);
    const nóSemEscopo: Record<string, unknown> = {
      maybeSingle: async () => ({ data: { scopes: [] }, error: null }),
    };
    nóSemEscopo.eq = () => nóSemEscopo;
    (db.from("calendar_connections") as { select: () => unknown }).select = () => nóSemEscopo;
    const g = google();
    expect(await passada(db, g.transporte)).toBe("processed");
    expect(g.espacosCriados).toHaveLength(0);
    expect(g.escritas[0]!.corpo).toHaveProperty("conferenceData");
  });
});

describe("o gate do executor lê o ENVELOPE do PostgREST (#2063)", () => {
  it("opção ligada + escopo na conexão abre; qualquer outra coisa fecha", async () => {
    const { db } = banco(true);
    await expect(decidirEspacoAberto(db as never, ORG, CONN)).resolves.toBe(true);

    const { db: apagado } = banco(false);
    await expect(decidirEspacoAberto(apagado as never, ORG, CONN)).resolves.toBe(false);

    // Sem conexão nem se pergunta ao banco.
    await expect(decidirEspacoAberto(db as never, ORG, null)).resolves.toBe(false);

    // Erro de leitura vale como desligado — falha fechada.
    const fora = { from: () => ({ select: () => { throw new Error("banco fora"); } }) };
    await expect(decidirEspacoAberto(fora as never, ORG, CONN)).resolves.toBe(false);
  });
});

// ─── atalhos de leitura do banco falso ──────────────────────────────────────
const linhaDe = (db: unknown) => (db as { linha: Record<string, unknown> }).linha;
const linhaMeetingUrl = (db: unknown) => linhaDe(db).meeting_url;
const basePublicada = (db: unknown) =>
  linhaDe(db).google_base_projection as { local: Record<string, string>; remote: Record<string, string> };

/** O mesmo evento, já publicado SEM Meet nenhum — o estado do PATCH abaixo. */
const EVENTO_JA_PUBLICADO: Record<string, unknown> = {
  id: EVENTO,
  etag: "etag-0",
  status: "confirmed",
  summary: "Consulta de avaliação",
  location: DETALHE,
  start: { dateTime: "2026-09-02T17:00:00.000Z", timeZone: "America/Sao_Paulo" },
  end: { dateTime: "2026-09-02T17:30:00.000Z", timeZone: "America/Sao_Paulo" },
  attendees: [],
};

/** Uma publicação prévia SEM Meet, para o caso do PATCH de reunião. */
function publicarSemMeet(db: unknown) {
  const linha = linhaDe(db);
  const local = {
    shared: {
      starts_at: String(linha.starts_at),
      ends_at: String(linha.ends_at),
      time_zone: String(linha.time_zone),
      cancelled: false,
    },
    outbound: {
      title: hash(String(linha.title)),
      description: hash(""),
      location: hash(DETALHE),
      guest: hash(""),
    },
  };
  linha.google_base_projection = {
    shared: local.shared,
    local: { ...local.outbound },
    remote: { ...local.outbound },
  };
  linha.google_etag = "etag-0";
  linha.google_pending_write = null;
  linha.google_synced_local_revision = linha.google_local_revision;
  // O Google já tem o evento, e ele vem sem Meet nenhum.
  return { local };
}

/** Simula a edição de alguém na tela: domínio novo e revisão nova. */
function editar(db: unknown, mudancas: Record<string, unknown>) {
  Object.assign(linhaDe(db), mudancas);
}

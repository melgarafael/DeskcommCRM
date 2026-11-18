import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A queda do número vira importação sozinha (Spec 32, itens 2 e 4).
 *
 * O banco é uma lista em memória com o que importa para o contrato: filtros
 * de organização, índice único de `evento_de_saida_id` (23505) e a regra de
 * uma `rodando` por conexão. Cada consulta é gravada, para provar que toda
 * leitura filtra `organization_id`.
 */
type Linha = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tabelas: {} as Record<string, Linha[]>,
  consultas: [] as Array<{ tabela: string; filtros: Record<string, unknown> }>,
  verificar: vi.fn(),
  waha: true,
}));

const auditEspiao = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit: auditEspiao }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const avisoEspiao = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/channels/historico/avisos-da-queda", () => ({
  avisarResumoDaRecuperacao: avisoEspiao,
  fecharAvisosDeClienteRespondido: vi.fn(async () => 0),
}));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => (h.waha ? { getVerifiedSession: h.verificar } : null),
}));

const { abrirRecuperacoesDasQuedas, prepararRecuperacoesAguardando, quedasDosEventos, DURACAO_MINIMA_MS, MARGEM_ANTES_MS, OLHAR_PARA_TRAS_MS } =
  await import("@/lib/channels/historico/quedas");

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const CONEXAO = "22222222-2222-4222-8222-222222222222";
const CONEXAO_DE_OUTRA = "44444444-4444-4444-8444-444444444444";
const CONEXAO_OFICIAL = "55555555-5555-4555-8555-555555555555";
const AGORA = new Date("2026-10-28T12:00:00.000Z");
const minutos = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();

/** Um evento de status: `de` e `para` são os status do par. */
function evento(id: string, em: string, de: string, para: string, conexao = CONEXAO, org = ORG): Linha {
  return {
    id,
    organization_id: org,
    event_type: "channel_session.status_changed",
    created_at: em,
    payload: { channel_session_id: conexao, from_status: de, to_status: para, phone_number: "5531998966398" },
  };
}

/** Uma queda de 1 h, de 2 h atrás: saída e volta. */
function quedaPadrao(idSaida = "ev-saida", idVolta = "ev-volta"): Linha[] {
  return [evento(idSaida, minutos(120), "WORKING", "FAILED"), evento(idVolta, minutos(60), "STOPPED", "WORKING")];
}

function sessao(id: string, extra: Linha = {}): Linha {
  return { id, organization_id: ORG, provider: "waha", phone_number: "553198966398", metadata: { guardar_historico: true }, archived_at: null, waha_session_name: "sessao-1", ...extra };
}

/** Lista em memória com as regras que o contrato usa: filtros, ordem, faixa e os índices únicos. */
function admin() {
  return {
    from(tabela: string) {
      const alvo = () => (h.tabelas[tabela] ??= []);
      let op: "select" | "insert" | "update" = "select";
      let payload: Linha = {};
      const filtros: Array<(r: Linha) => boolean> = [];
      const vistos: Record<string, unknown> = {};
      const ordem: Array<(a: Linha, b: Linha) => number> = [];
      let faixa: [number, number] | null = null;
      let limite: number | null = null;

      const executar = (unica: boolean): { data: unknown; error: { code: string; message: string } | null } => {
        h.consultas.push({ tabela, filtros: { ...vistos } });
        const linhas = alvo().filter((r) => filtros.every((f) => f(r)));
        if (op === "insert") {
          if (tabela === "importacoes_de_historico" && alvo().some((r) => r.evento_de_saida_id === payload.evento_de_saida_id)) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const nova = { id: `imp-${alvo().length + 1}`, cursor: {}, erro: null, ...payload };
          alvo().push(nova);
          return { data: unica ? nova : [nova], error: null };
        }
        if (op === "update") {
          if (tabela === "importacoes_de_historico" && payload.status === "rodando") {
            const outra = alvo().find((r) => r.status === "rodando" && linhas.some((l) => l.channel_session_id === r.channel_session_id) && !linhas.includes(r));
            if (outra) return { data: null, error: { code: "23505", message: "uma_rodando" } };
          }
          linhas.forEach((r) => Object.assign(r, payload));
          return { data: linhas.map((r) => ({ id: r.id })), error: null };
        }
        let saida = [...linhas];
        for (const cmp of ordem) saida = saida.sort(cmp);
        if (faixa) saida = saida.slice(faixa[0], faixa[1] + 1);
        if (limite !== null) saida = saida.slice(0, limite);
        const copias = saida.map((r) => ({ ...r }));
        return { data: unica ? (copias[0] ?? null) : copias, error: null };
      };

      const q: Record<string, unknown> = {
        select: () => q,
        insert: (p: Linha) => { op = "insert"; payload = p; return q; },
        update: (p: Linha) => { op = "update"; payload = p; return q; },
        eq: (k: string, v: unknown) => { vistos[k] = v; filtros.push((r) => r[k] === v); return q; },
        in: (k: string, vs: unknown[]) => { vistos[k] = vs; filtros.push((r) => vs.includes(r[k])); return q; },
        is: (k: string, v: unknown) => { vistos[k] = v; filtros.push((r) => (r[k] ?? null) === v); return q; },
        gte: (k: string, v: string) => { vistos[`>=${k}`] = v; filtros.push((r) => String(r[k]) >= v); return q; },
        order: (k: string, { ascending = true }: { ascending?: boolean } = {}) => {
          ordem.push((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (ascending ? 1 : -1));
          return q;
        },
        range: (de: number, ate: number) => { faixa = [de, ate]; return q; },
        limit: (n: number) => { limite = n; return q; },
        maybeSingle: () => Promise.resolve(executar(true)),
        single: () => Promise.resolve(executar(true)),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(executar(false)).then(res, rej),
      };
      return q;
    },
  };
}

/** Só o que o teste precisa saber de uma importação criada. */
const importacoes = () => h.tabelas.importacoes_de_historico ?? [];

beforeEach(() => {
  h.tabelas = {
    organizations: [{ id: ORG, status: "active" }, { id: OUTRA, status: "active" }],
    event_log: [],
    channel_sessions: [sessao(CONEXAO), sessao(CONEXAO_OFICIAL, { provider: "zernio_social" }), sessao(CONEXAO_DE_OUTRA, { organization_id: OUTRA })],
    importacoes_de_historico: [],
  };
  h.consultas = [];
  h.waha = true;
  h.verificar.mockReset();
  auditEspiao.mockReset();
  avisoEspiao.mockClear();
});

describe("quedasDosEventos (Spec 32, item 2)", () => {
  it("queda de 4 min não conta: menos que o mínimo de 5 min", () => {
    const ev = [
      { id: "s", created_at: "2026-10-28T10:00:00.000Z", payload: { from_status: "WORKING", to_status: "FAILED" } },
      { id: "v", created_at: "2026-10-28T10:04:00.000Z", payload: { from_status: "STOPPED", to_status: "WORKING" } },
    ];
    expect(quedasDosEventos(ev)).toEqual([]);
    expect(DURACAO_MINIMA_MS).toBe(5 * 60_000);
  });

  it("queda de 6 min vira 1 com a saída e a volta certas", () => {
    const ev = [
      { id: "s", created_at: "2026-10-28T10:00:00.000Z", payload: { from_status: "WORKING", to_status: "FAILED" } },
      { id: "v", created_at: "2026-10-28T10:06:00.000Z", payload: { from_status: "STOPPED", to_status: "WORKING" } },
    ];
    expect(quedasDosEventos(ev)).toEqual([
      { eventoDeSaidaId: "s", saidaEm: new Date("2026-10-28T10:00:00.000Z"), voltaEm: new Date("2026-10-28T10:06:00.000Z"), numeroNaSaida: null },
    ]);
    // Sabotagem: contar a partir de qualquer saída (sem olhar a volta) traz a queda de 4 min também.
  });

  it("saída sem volta não gera nada", () => {
    const ev = [{ id: "s", created_at: "2026-10-28T10:00:00.000Z", payload: { from_status: "WORKING", to_status: "FAILED" } }];
    expect(quedasDosEventos(ev)).toEqual([]);
  });

  it("duas quedas viram duas", () => {
    const ev = [
      { id: "s1", created_at: "2026-10-28T08:00:00.000Z", payload: { from_status: "WORKING", to_status: "FAILED" } },
      { id: "v1", created_at: "2026-10-28T08:30:00.000Z", payload: { from_status: "STOPPED", to_status: "WORKING" } },
      { id: "s2", created_at: "2026-10-28T09:00:00.000Z", payload: { from_status: "WORKING", to_status: "FAILED" } },
      { id: "v2", created_at: "2026-10-28T09:20:00.000Z", payload: { from_status: "STOPPED", to_status: "WORKING" } },
    ];
    expect(quedasDosEventos(ev).map((q) => q.eventoDeSaidaId)).toEqual(["s1", "s2"]);
  });
});

describe("abrirRecuperacoesDasQuedas (Spec 32, item 2)", () => {
  it("o número esperado é o da SAÍDA, não o que a conexão tem depois de re-pareada com outro aparelho", async () => {
    // A tela de Conexões regrava `channel_sessions.phone_number` quando outro aparelho
    // é pareado. Esperar esse número compararia o aparelho novo com ele mesmo, e a
    // trava "o número mudou" nunca dispararia no caso para o qual ela existe.
    h.tabelas.event_log = quedaPadrao();
    h.tabelas.channel_sessions = [sessao(CONEXAO, { phone_number: "5511912345678" })];
    await abrirRecuperacoesDasQuedas(admin() as never, AGORA);
    expect(importacoes()[0]).toMatchObject({ numero_esperado: "5531998966398" });
  });

  it("cria 1 importação aguardando com desde = saída − 10 min e ate = volta, e audita como sistema", async () => {
    h.tabelas.event_log = quedaPadrao();
    const r = await abrirRecuperacoesDasQuedas(admin() as never, AGORA);
    expect(r).toEqual({ criadas: 1 });
    const [imp] = importacoes();
    expect(imp).toMatchObject({
      organization_id: ORG,
      channel_session_id: CONEXAO,
      status: "aguardando",
      dias: null,
      escopo: "so_crm",
      origem: "queda",
      evento_de_saida_id: "ev-saida",
      numero_esperado: "5531998966398",
      criada_por: null,
    });
    expect(imp!.desde).toBe(new Date(Date.parse(minutos(120)) - MARGEM_ANTES_MS).toISOString());
    expect(imp!.ate).toBe(minutos(60));
    expect(OLHAR_PARA_TRAS_MS).toBe(7 * 24 * 3_600_000);
    expect(auditEspiao).toHaveBeenCalledTimes(1);
    const audit = auditEspiao.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit).toMatchObject({ action: "channel.historico_import_started", organizationId: ORG, bypassedRls: true });
    expect(audit.actorUserId).toBeUndefined();
    expect((audit.metadata as Record<string, unknown>).origem).toBe("queda");
  });

  it("23505 (a queda já tem importação) não conta, não audita e não lança", async () => {
    h.tabelas.event_log = quedaPadrao();
    h.tabelas.importacoes_de_historico = [{ id: "ja", organization_id: ORG, evento_de_saida_id: "ev-saida", status: "aguardando" }];
    const r = await abrirRecuperacoesDasQuedas(admin() as never, AGORA);
    expect(r).toEqual({ criadas: 0 });
    expect(importacoes()).toHaveLength(1);
    expect(auditEspiao).not.toHaveBeenCalled();
  });

  it("evento que aponta para a conexão de OUTRA organização não cria nada", async () => {
    h.tabelas.event_log = [
      evento("ev-saida", minutos(120), "WORKING", "FAILED", CONEXAO_DE_OUTRA),
      evento("ev-volta", minutos(60), "STOPPED", "WORKING", CONEXAO_DE_OUTRA),
    ];
    expect((await abrirRecuperacoesDasQuedas(admin() as never, AGORA)).criadas).toBe(0);
    expect(importacoes()).toHaveLength(0);
  });

  it("conexão que não é WAHA (oficial, Zernio) não dispara", async () => {
    h.tabelas.event_log = [
      evento("ev-saida", minutos(120), "WORKING", "FAILED", CONEXAO_OFICIAL),
      evento("ev-volta", minutos(60), "STOPPED", "WORKING", CONEXAO_OFICIAL),
    ];
    expect((await abrirRecuperacoesDasQuedas(admin() as never, AGORA)).criadas).toBe(0);
  });

  it("volta há 8 dias não é recuperada sozinha", async () => {
    h.tabelas.event_log = [
      evento("ev-saida", minutos(8 * 24 * 60 + 60), "WORKING", "FAILED"),
      evento("ev-volta", minutos(8 * 24 * 60), "STOPPED", "WORKING"),
    ];
    expect((await abrirRecuperacoesDasQuedas(admin() as never, AGORA)).criadas).toBe(0);
    expect(importacoes()).toHaveLength(0);
  });

  it("'Guardar o histórico' desligado: não cria importação, avisa só se a volta foi nos últimos 10 min", async () => {
    h.tabelas.channel_sessions = [sessao(CONEXAO, { metadata: {} })];
    h.tabelas.event_log = quedaPadrao();
    expect((await abrirRecuperacoesDasQuedas(admin() as never, AGORA)).criadas).toBe(0);
    expect(importacoes()).toHaveLength(0);
    expect(avisoEspiao).not.toHaveBeenCalled();

    h.tabelas.event_log = [evento("ev-saida", minutos(30), "WORKING", "FAILED"), evento("ev-volta", minutos(5), "STOPPED", "WORKING")];
    await abrirRecuperacoesDasQuedas(admin() as never, AGORA);
    expect(avisoEspiao).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG, channelSessionId: CONEXAO, motivo: "acervo_desligado" }));
  });

  it("toda leitura do log e da conexão filtra organization_id", async () => {
    h.tabelas.event_log = quedaPadrao();
    await abrirRecuperacoesDasQuedas(admin() as never, AGORA);
    const lidas = h.consultas.filter((c) => c.tabela === "event_log" || c.tabela === "channel_sessions");
    expect(lidas.length).toBeGreaterThan(0);
    for (const c of lidas) {
      expect(c.filtros.organization_id).toBeDefined();
    }
    // Sabotagem: ler o event_log sem organization_id traz a queda de outra empresa (o teste acima a vê).
  });
});

describe("prepararRecuperacoesAguardando (Spec 32, item 2)", () => {
  function aguardando(extra: Linha = {}): Linha {
    return {
      id: "imp-1",
      organization_id: ORG,
      channel_session_id: CONEXAO,
      status: "aguardando",
      origem: "queda",
      numero_esperado: "553198966398",
      desde: minutos(130),
      ate: minutos(60),
      created_at: minutos(5),
      cursor: {},
      ...extra,
    };
  }
  const viva = (numero: string, status = "WORKING") => ({ name: "sessao-1", status, me: { id: `${numero}@c.us` } });

  it("número ao vivo igual ao esperado (com e sem o nono dígito) promove a rodando", async () => {
    h.tabelas.importacoes_de_historico = [aguardando()];
    h.verificar.mockResolvedValue(viva("5531998966398"));
    const r = await prepararRecuperacoesAguardando(admin() as never, AGORA);
    expect(r).toEqual({ promovidas: 1, canceladas: 0 });
    expect(importacoes()[0]!.status).toBe("rodando");
    // Sabotagem: comparar o phone_number dos eventos em vez do número ao vivo faria o teste passar sem conferir nada.
  });

  it("23505 na promoção (outra rodando na conexão): continua aguardando, sem lançar e sem contar", async () => {
    h.tabelas.importacoes_de_historico = [aguardando(), { id: "outra", organization_id: ORG, channel_session_id: CONEXAO, status: "rodando", origem: "manual" }];
    h.verificar.mockResolvedValue(viva("5531998966398"));
    const r = await prepararRecuperacoesAguardando(admin() as never, AGORA);
    expect(r).toEqual({ promovidas: 0, canceladas: 0 });
    expect(importacoes()[0]!.status).toBe("aguardando");
    expect(avisoEspiao).not.toHaveBeenCalled();
  });

  it("número ao vivo diferente: cancelada com o motivo e 1 aviso numero_mudou", async () => {
    h.tabelas.importacoes_de_historico = [aguardando()];
    h.verificar.mockResolvedValue(viva("5521999990000"));
    const r = await prepararRecuperacoesAguardando(admin() as never, AGORA);
    expect(r).toEqual({ promovidas: 0, canceladas: 1 });
    expect(importacoes()[0]).toMatchObject({ status: "cancelada", erro: "o número da conexão mudou" });
    expect(avisoEspiao).toHaveBeenCalledTimes(1);
    expect(avisoEspiao).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motivo: "numero_mudou", organizationId: ORG }));
    // Sabotagem: comparar o phone_number do evento (igual nos dois) deixaria esta importação seguir.
  });

  it("ilegível há menos de 60 min: segue aguardando, sem aviso", async () => {
    h.tabelas.importacoes_de_historico = [aguardando({ created_at: minutos(30) })];
    h.verificar.mockRejectedValue(new Error("canal fora do ar"));
    expect(await prepararRecuperacoesAguardando(admin() as never, AGORA)).toEqual({ promovidas: 0, canceladas: 0 });
    expect(importacoes()[0]!.status).toBe("aguardando");
    expect(avisoEspiao).not.toHaveBeenCalled();
  });

  it("ilegível há mais de 60 min: cancelada e aviso numero_nao_confirmado", async () => {
    h.tabelas.importacoes_de_historico = [aguardando({ created_at: minutos(90) })];
    h.verificar.mockResolvedValue(null);
    const r = await prepararRecuperacoesAguardando(admin() as never, AGORA);
    expect(r).toEqual({ promovidas: 0, canceladas: 1 });
    expect(importacoes()[0]).toMatchObject({ status: "cancelada", erro: "número não confirmado" });
    expect(avisoEspiao).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motivo: "numero_nao_confirmado" }));
  });

  it("conexão sem número gravado é ilegível, não igual a nada", async () => {
    h.tabelas.importacoes_de_historico = [aguardando({ numero_esperado: null, created_at: minutos(90) })];
    h.verificar.mockResolvedValue(viva("5531998966398"));
    expect((await prepararRecuperacoesAguardando(admin() as never, AGORA)).promovidas).toBe(0);
    expect(importacoes()[0]!.status).toBe("cancelada");
  });
});

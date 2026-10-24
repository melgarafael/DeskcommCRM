import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { calcularPrevia, lerSessaoDoHistorico } from "@/lib/channels/historico/previa";
import { GET, POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/channels/historico/previa", () => ({ lerSessaoDoHistorico: vi.fn(), calcularPrevia: vi.fn() }));

/**
 * A importação do histórico (#999), pela porta das rotas: a rota só cria e
 * muda o ESTADO da linha; quem anda o acervo é o cron. A tabela é uma lista em
 * memória que imita o índice único parcial da 0761 (uma `rodando` por número).
 */
const org = "11111111-1111-4111-8111-111111111111";
const outraOrg = "33333333-3333-4333-8333-333333333333";
const canal = "22222222-2222-4222-8222-222222222222";
const previaOk = { conversas: 4, mensagens: 120, audios: 7, imagens: 9, desde: "2026-07-22T00:00:00.000Z", parcial: false };

type Linha = Record<string, unknown>;
let tabela: Linha[] = [];
let seq = 0;
const escritas: Array<{ op: string; payload: Linha; filtros: Record<string, unknown> }> = [];

function consulta(op: "select" | "insert" | "update", payload?: Linha) {
  const filtros: Array<(l: Linha) => boolean> = [];
  const vistos: Record<string, unknown> = {};
  const rodar = async (unica: boolean) => {
    const alvo = tabela.filter((l) => filtros.every((f) => f(l)));
    if (op === "insert") {
      const nova = { id: `00000000-0000-4000-8000-00000000000${++seq}`, created_at: `2026-10-20T00:00:0${seq}Z`, cursor: {}, erro: null, ...payload };
      tabela.push(nova);
      escritas.push({ op, payload: payload!, filtros: vistos });
      return { data: unica ? nova : [nova], error: null };
    }
    if (op === "update") {
      escritas.push({ op, payload: payload!, filtros: vistos });
      if (payload!.status === "rodando") {
        const sessao = alvo[0]?.channel_session_id;
        if (tabela.some((l) => l.status === "rodando" && l.channel_session_id === sessao && !alvo.includes(l))) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
      }
      alvo.forEach((l) => Object.assign(l, payload));
      return { data: unica ? (alvo[0] ?? null) : alvo, error: null };
    }
    const ord = [...alvo].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { data: unica ? (ord[0] ?? null) : ord, error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => { vistos[k] = v; filtros.push((l) => l[k] === v); return q; },
    in: (k: string, vs: unknown[]) => { vistos[k] = vs; filtros.push((l) => vs.includes(l[k])); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: () => rodar(true),
    single: () => rodar(true),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => rodar(false).then(res, rej),
  };
  return q;
}

const context = (id = canal) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}, method = "POST") =>
  new NextRequest(`http://localhost/api/v1/channel-sessions/${canal}/historico`, method === "GET" ? { method } : { method, body: JSON.stringify(body) });
const comoAdmin = (orgId = org, role = "admin") =>
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1" }, org: { orgId, role } } as Awaited<ReturnType<typeof requireRole>>);
const linha = (extra: Linha = {}): Linha => {
  const l = { id: `00000000-0000-4000-8000-0000000000a${tabela.length}`, organization_id: org, channel_session_id: canal, status: "previa", dias: 90, previa: previaOk, cursor: {}, erro: null, created_at: `2026-10-19T00:00:0${tabela.length}Z`, ...extra };
  tabela.push(l);
  return l;
};
const acoes = () => vi.mocked(audit).mock.calls.map(([a]) => a.action);

beforeEach(() => {
  vi.clearAllMocks();
  tabela = [];
  seq = 0;
  escritas.length = 0;
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  comoAdmin();
  vi.mocked(lerSessaoDoHistorico).mockImplementation(async (_db, orgId, id) =>
    orgId === org && id === canal ? { guardarHistorico: true, nomeNoCanal: "sessao-1" } : null,
  );
  vi.mocked(calcularPrevia).mockResolvedValue(previaOk);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (t: string) => {
      if (t !== "importacoes_de_historico") throw new Error(`tabela inesperada: ${t}`);
      return { select: () => consulta("select"), insert: (p: Linha) => consulta("insert", p), update: (p: Linha) => consulta("update", p) };
    },
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("importação do histórico: rotas (#999)", () => {
  it("prévia nova com importação rodando no mesmo número: 409, sem contar nem gravar", async () => {
    linha({ status: "rodando" });
    const r = await POST(req({ acao: "previa", dias: 90 }), context());
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("state_conflict");
    expect(calcularPrevia).not.toHaveBeenCalled();
    expect(escritas.filter((e) => e.op === "insert")).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("importação rodando em OUTRO número não barra a prévia", async () => {
    linha({ status: "rodando", channel_session_id: "44444444-4444-4444-8444-444444444444" });
    expect((await POST(req({ acao: "previa", dias: 90 }), context())).status).toBe(200);
  });

  it("os quatro períodos são aceitos, 180 dias inclusive", async () => {
    for (const dias of [30, 90, 180, 365]) {
      expect((await POST(req({ acao: "previa", dias }), context())).status).toBe(200);
      expect(vi.mocked(calcularPrevia)).toHaveBeenLastCalledWith("sessao-1", dias);
    }
    const inseridas = escritas.filter((e) => e.op === "insert").map((e) => (e.payload as { dias?: number }).dias);
    expect(inseridas).toContain(180);
  });

  it("agente e gerente recebem 403, sem tocar no banco nem auditar", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    expect((await GET(req({}, "GET"), context())).status).toBe(403);
    expect((await POST(req({ acao: "previa", dias: 90 }), context())).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "channel_sessions", allowPlatformAdmin: true }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a porta é admin: POST com escrita (e suporte checado antes), GET só leitura para a plataforma", async () => {
    const ordem: string[] = [];
    vi.mocked(requireSupportWrite).mockImplementation(async () => { ordem.push("suporte"); return null; });
    vi.mocked(requireRole).mockImplementation(async () => {
      ordem.push("papel");
      return { ok: true, user: { id: "u1" }, org: { orgId: org, role: "admin" } } as Awaited<ReturnType<typeof requireRole>>;
    });
    await POST(req({ acao: "previa", dias: 90 }), context());
    expect(ordem).toEqual(["suporte", "papel"]);
    expect(requireRole).toHaveBeenLastCalledWith("admin", expect.objectContaining({ resource: "channel_sessions", allowPlatformAdmin: true }));
    await GET(req({}, "GET"), context());
    expect(requireRole).toHaveBeenLastCalledWith("admin", expect.objectContaining({ resource: "channel_sessions", allowPlatformAdmin: "leitura" }));
  });

  it("suporte sem escrita é barrado antes do papel e do banco", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden", "Somente leitura.", 403));
    expect((await POST(req({ acao: "previa", dias: 90 }), context())).status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("erro do banco ao ler a sessão responde 500, sem gravar nem auditar", async () => {
    vi.mocked(lerSessaoDoHistorico).mockRejectedValue(new Error("sessao_leitura: timeout"));
    expect((await GET(req({}, "GET"), context())).status).toBe(500);
    const r = await POST(req({ acao: "previa", dias: 90 }), context());
    expect(r.status).toBe(500);
    expect((await r.json()).error.code).toBe("internal_error");
    expect(escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão de outra organização responde 404 e não grava nem audita", async () => {
    comoAdmin(outraOrg);
    linha({ organization_id: org });
    expect((await GET(req({}, "GET"), context())).status).toBe(404);
    for (const body of [{ acao: "previa", dias: 90 }, { acao: "importar", importacaoId: tabela[0]!.id }, { acao: "cancelar", importacaoId: tabela[0]!.id }]) {
      expect((await POST(req(body), context())).status).toBe(404);
    }
    expect(escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo inválido responde 422 sem gravar", async () => {
    for (const body of [{}, { acao: "previa", dias: 60 }, { acao: "importar" }, { acao: "apagar", importacaoId: canal }]) {
      expect((await POST(req(body), context())).status).toBe(422);
    }
    expect((await POST(req({ acao: "previa", dias: 90 }), context("nao-e-uuid"))).status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("prévia com 'Guardar o histórico' desligado responde 409 com a frase da tela", async () => {
    vi.mocked(lerSessaoDoHistorico).mockResolvedValue({ guardarHistorico: false, nomeNoCanal: "sessao-1" });
    const r = await POST(req({ acao: "previa", dias: 90 }), context());
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toContain("Ligue 'Guardar o histórico' e conecte o número de novo");
    expect(calcularPrevia).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });

  it("prévia ok grava status 'previa' com a prévia, na org e no número do path, e audita", async () => {
    const r = await POST(req({ acao: "previa", dias: 90, organization_id: outraOrg }), context());
    expect(r.status).toBe(200);
    expect(calcularPrevia).toHaveBeenCalledWith("sessao-1", 90);
    expect(tabela).toHaveLength(1);
    expect(tabela[0]).toMatchObject({ organization_id: org, channel_session_id: canal, status: "previa", dias: 90, previa: previaOk, criada_por: "u1" });
    expect((await r.json()).data.importacao).toMatchObject({ status: "previa", previa: previaOk });
    expect(acoes()).toEqual(["channel.historico_previa"]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, resourceType: "channel_session", resourceId: canal }));
  });

  it("prévia que o canal não consegue responder vira 502, sem gravar", async () => {
    vi.mocked(calcularPrevia).mockRejectedValue(new Error("canal_chats_500"));
    expect((await POST(req({ acao: "previa", dias: 30 }), context())).status).toBe(502);
    expect(escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("importar muda de 'previa' para 'rodando' (sem executar rodada) e audita", async () => {
    const l = linha();
    const r = await POST(req({ acao: "importar", importacaoId: l.id }), context());
    expect(r.status).toBe(200);
    expect(l.status).toBe("rodando");
    expect(escritas.at(-1)!.filtros).toMatchObject({ id: l.id, organization_id: org, channel_session_id: canal, status: ["previa"] });
    expect(acoes()).toEqual(["channel.historico_import_started"]);
  });

  it("segunda importação na mesma conexão responde 409", async () => {
    const a = linha();
    const b = linha();
    expect((await POST(req({ acao: "importar", importacaoId: a.id }), context())).status).toBe(200);
    const r = await POST(req({ acao: "importar", importacaoId: b.id }), context());
    expect(r.status).toBe(409);
    expect(b.status).toBe("previa");
    // a mesma importação de novo também: já não está em prévia
    expect((await POST(req({ acao: "importar", importacaoId: a.id }), context())).status).toBe(409);
    expect(acoes()).toEqual(["channel.historico_import_started"]);
  });

  it("importação de outro número da mesma org responde 404", async () => {
    const l = linha({ channel_session_id: "44444444-4444-4444-8444-444444444444" });
    expect((await POST(req({ acao: "importar", importacaoId: l.id }), context())).status).toBe(404);
    expect(l.status).toBe("previa");
  });

  it("cancelar vale para prévia, rodando e erro; não para concluída", async () => {
    for (const status of ["previa", "rodando", "erro"]) {
      tabela = [];
      const l = linha({ status });
      expect((await POST(req({ acao: "cancelar", importacaoId: l.id }), context())).status).toBe(200);
      expect(l.status).toBe("cancelada");
    }
    tabela = [];
    const feita = linha({ status: "concluida" });
    expect((await POST(req({ acao: "cancelar", importacaoId: feita.id }), context())).status).toBe(409);
    expect(feita.status).toBe("concluida");
    expect(acoes()).toEqual(["channel.historico_import_cancelled", "channel.historico_import_cancelled", "channel.historico_import_cancelled"]);
  });

  it("retomar leva de 'erro' a 'rodando' limpando o erro; de outro estado é 409", async () => {
    const l = linha({ status: "erro", erro: "canal_chats_500" });
    expect((await POST(req({ acao: "retomar", importacaoId: l.id }), context())).status).toBe(200);
    expect(l).toMatchObject({ status: "rodando", erro: null });
    expect((await POST(req({ acao: "retomar", importacaoId: l.id }), context())).status).toBe(409);
    expect(acoes()).toEqual(["channel.historico_import_resumed"]);
  });

  it("GET devolve a última importação do número e a opção do acervo", async () => {
    linha({ status: "concluida" });
    const ultima = linha({ status: "rodando" });
    const r = await GET(req({}, "GET"), context());
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data).toMatchObject({ guardar_historico: true, importacao: { id: ultima.id, status: "rodando" } });
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ allowPlatformAdmin: "leitura" }));
  });
});

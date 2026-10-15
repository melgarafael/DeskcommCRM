/**
 * O AGENDADOR QUE FALHA AVISA NA CENTRAL E A JANELA EDITADA MANDA NO RELÓGIO
 * NOVO — critério 6 e o resto da #2388 (pendência declarada do PR #2673).
 *
 * ─── O que o #2673 deixou de fora, e este arquivo mede ──────────────────────
 *
 * O PR da pausa agendada entrou com `Refs #2388` porque declarou pendência: o
 * critério 6 (falha do agendador vira aviso na Central, em vez de silêncio no
 * log) e "editar uma janela já agendada" ficaram para depois. É isto aqui.
 *
 *   (a) Uma batida que FALHA abre UM aviso por organização na Central, com
 *       corpo fixo (o motivo vai só para o log) — nunca um por canal
 *       (critério 6) — e uma batida saudável FECHA
 *       o aviso de uma falha anterior (o laço do `canal-mudo-watcher`, DoD 13).
 *   (b) Editar uma janela que ainda não começou grava o horário NOVO, e o cron
 *       respeita o horário NOVO: no instante do horário ANTIGO já não pausa, e
 *       no instante do horário NOVO pausa.
 *
 * ─── Relógio injetado, nunca sleep ─────────────────────────────────────────
 *
 * Como em `agenda-de-pausa-agendada.test.ts`: `aplicarAgendas` recebe o instante
 * de quem chama, e o teste passa instantes fixos — nada dorme.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/channels/central-de-pausa", () => ({
  sincronizarAvisoDePausa: vi.fn(async () => "aberto"),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  CORPO_DO_AVISO_DO_AGENDADOR,
  sincronizarAvisoDoAgendador,
  TITULO_DO_AVISO_DO_AGENDADOR,
} from "@/lib/channels/aviso-do-agendador";
import { aplicarAgendas, aplicarAgendasEavisar } from "@/app/api/v1/cron/channel-pause-scheduler/route";
import { PATCH } from "@/app/api/v1/channel-schedules/[id]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_2 = "22222222-2222-4222-8222-222222222222";
const AUTORA = "99999999-9999-4999-8999-999999999999";
const JANELA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;
type Filtro = [string, unknown[]];
type Operacao = { tabela: string; tipo: "select" | "insert" | "update"; valor: unknown; filtros: Filtro[] };

/** O logger de mentira que o módulo recebe: `info` leva o motivo, `warn` a falha da Central. */
const logFake = { info: vi.fn(), warn: vi.fn() };

/**
 * Banco falso para as batidas do cron e para o aviso da Central.
 *
 * Distingue as duas leituras de `organizations` pelo filtro: a régua de orgs
 * paradas usa `neq("status", …)`; a lista todas-do-aviso não tem filtro.
 */
function dbFalso(programa: {
  agendas?: Linha[];
  canais?: Linha[];
  orgsParadas?: string[];
  todasAsOrgs?: string[];
  abertos?: string[];
  erroAgenda?: string | null;
  rpcRecusa?: boolean;
}) {
  const operacoes: Operacao[] = [];

  function tabela(nome: string) {
    const ctx: { filtros: Filtro[]; tipo: "select" | "insert" | "update"; valor: unknown } = {
      filtros: [],
      tipo: "select",
      valor: null,
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "lte", "neq", "limit", "order"]) {
      b[m] = (...args: unknown[]) => {
        if (m !== "select") ctx.filtros.push([m, args]);
        return b;
      };
    }
    b.insert = (valor: unknown) => {
      ctx.tipo = "insert";
      ctx.valor = valor;
      return b;
    };
    b.update = (valor: unknown) => {
      ctx.tipo = "update";
      ctx.valor = valor;
      return b;
    };
    b.maybeSingle = () => resolver(ctx, nome).then((r) => ({ ...r, data: unico(r.data) }));
    b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => resolver(ctx, nome).then(ok, erro);
    return b;
  }

  const unico = (data: unknown) => (Array.isArray(data) ? (data[0] ?? null) : data);

  function valorDe(filtros: Filtro[], metodo: string, coluna: string): unknown {
    return filtros.find(([m, args]) => m === metodo && args[0] === coluna)?.[1]?.[1];
  }

  async function resolver(
    ctx: { filtros: Filtro[]; tipo: "select" | "insert" | "update"; valor: unknown },
    nome: string,
  ): Promise<{ data: unknown; error: { message: string } | null }> {
    operacoes.push({ tabela: nome, tipo: ctx.tipo, valor: ctx.valor, filtros: [...ctx.filtros] });

    if (ctx.tipo === "insert") return { data: null, error: null };
    if (ctx.tipo === "update") return { data: null, error: null };

    if (nome === "organizations") {
      const temNeq = ctx.filtros.some(([m]) => m === "neq");
      if (temNeq) return { data: (programa.orgsParadas ?? []).map((id) => ({ id })), error: null };
      return { data: (programa.todasAsOrgs ?? []).map((id) => ({ id })), error: null };
    }
    if (nome === "channel_schedules") {
      if (programa.erroAgenda) return { data: null, error: { message: programa.erroAgenda } };
      return { data: programa.agendas ?? [], error: null };
    }
    if (nome === "channel_sessions") return { data: programa.canais ?? [], error: null };
    if (nome === "agent_inbox_items") {
      return { data: (programa.abertos ?? []).map((id) => ({ organization_id: id })), error: null };
    }
    throw new Error(`tabela não prevista no banco falso: ${nome}`);
  }

  return {
    from: (nome: string) => tabela(nome),
    rpc: vi.fn(async () =>
      programa.rpcRecusa
        ? { data: null, error: { message: "canal arquivado na corrida" } }
        : { data: 1, error: null },
    ),
    operacoes,
  };
}

const canal = (id: string, metadata: unknown = null): Linha => ({
  id,
  organization_id: ORG,
  archived_at: null,
  metadata,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: AUTORA },
    org: { orgId: ORG, role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

describe("a falha do agendador vira aviso na Central (critério 6 da #2388)", () => {
  it("abre UM aviso por organização, com corpo fixo — nunca um por canal", async () => {
    const db = dbFalso({ todasAsOrgs: [ORG, ORG_2], abertos: [] });

    await sincronizarAvisoDoAgendador(
      db as never,
      { estado: "falhou", motivo: "leitura da agenda: conexão recusada" },
      logFake as never,
    );

    const insert = db.operacoes.find((o) => o.tabela === "agent_inbox_items" && o.tipo === "insert");
    expect(insert).toBeDefined();
    const linhas = insert?.valor as Array<Linha>;
    // Um por ORGANIZAÇÃO (2), não um por canal.
    expect(linhas).toHaveLength(2);
    expect(linhas.map((l) => l.organization_id)).toEqual([ORG, ORG_2]);
    expect(linhas[0]).toMatchObject({ kind: "other", severity: "warn", title: TITULO_DO_AVISO_DO_AGENDADOR });
    // O corpo é FIXO: o motivo é detalhe técnico e vai só para o log.
    expect(linhas[0]?.body).toBe(CORPO_DO_AVISO_DO_AGENDADOR);
    expect(String(linhas[0]?.body)).not.toContain("leitura da agenda");
    expect(logFake.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ motivo: "leitura da agenda: conexão recusada" }),
    );
  });

  it("não reabre o aviso de quem já tem um aberto (dedup pelo título)", async () => {
    const db = dbFalso({ todasAsOrgs: [ORG, ORG_2], abertos: [ORG] });

    await sincronizarAvisoDoAgendador(
      db as never,
      { estado: "falhou", motivo: "escrita recusada" },
      logFake as never,
    );

    const linhas = db.operacoes.find((o) => o.tipo === "insert")?.valor as Array<Linha>;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.organization_id).toBe(ORG_2);
  });

  it("a batida saudável fecha o aviso aberto — o laço de retorno (DoD 13)", async () => {
    const db = dbFalso({});

    await sincronizarAvisoDoAgendador(db as never, { estado: "saudavel" }, logFake as never);

    const update = db.operacoes.find((o) => o.tabela === "agent_inbox_items" && o.tipo === "update");
    expect(update).toBeDefined();
    expect(update?.valor).toMatchObject({ status: "resolved" });
    // Fecha só o incidente do agendador: o filtro leva o título estável e "open".
    const filtros = update?.filtros ?? [];
    expect(filtros.some(([m, args]) => m === "eq" && args[1] === TITULO_DO_AVISO_DO_AGENDADOR)).toBe(true);
    expect(filtros.some(([m, args]) => m === "eq" && args[1] === "open")).toBe(true);
  });

  it("a Central fora do ar não derruba a batida: só loga (best-effort)", async () => {
    const db = {
      from: () => {
        throw new Error("Central indisponível");
      },
    };

    await expect(
      sincronizarAvisoDoAgendador(db as never, { estado: "falhou", motivo: "x" }, logFake as never),
    ).resolves.toBeUndefined();
    expect(logFake.warn).toHaveBeenCalled();
  });

  it("o cron que não consegue aplicar a janela abre o aviso SEM o motivo no corpo e segue falhando alto", async () => {
    const db = dbFalso({ erroAgenda: "leitura da agenda: conexão recusada", todasAsOrgs: [ORG] });

    await expect(aplicarAgendasEavisar(db as never, new Date("2026-10-10T03:00:00Z"))).rejects.toThrow(
      "leitura da agenda: conexão recusada",
    );

    const linhas = db.operacoes.find((o) => o.tipo === "insert")?.valor as Array<Linha>;
    expect(linhas).toHaveLength(1);
    expect(String(linhas[0]?.body)).not.toContain("leitura da agenda");
    expect(linhas[0]?.body).toBe(CORPO_DO_AVISO_DO_AGENDADOR);
  });

  it("escrita de canal recusada também vira aviso, e a contagem vai para o log", async () => {
    const db = dbFalso({
      agendas: [
        {
          id: JANELA,
          organization_id: ORG,
          channel_session_id: null,
          starts_at: "2026-10-10T03:00:00.000Z",
          ends_at: "2026-10-10T05:00:00.000Z",
          status: "scheduled",
          paused_channel_ids: [],
          created_by: AUTORA,
        },
      ],
      canais: [canal(CANAL)],
      todasAsOrgs: [ORG],
      rpcRecusa: true,
    });

    const resumo = await aplicarAgendasEavisar(db as never, new Date("2026-10-10T03:00:00Z"));

    expect(resumo.falhas).toBe(1);
    const linhas = db.operacoes.find((o) => o.tipo === "insert")?.valor as Array<Linha>;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.body).toBe(CORPO_DO_AVISO_DO_AGENDADOR);
    expect(String(linhas[0]?.body)).not.toContain("escrita(s) recusada(s)");
  });
});

describe("editar a janela: o relógio respeita o horário NOVO (critério 2 da #2388)", () => {
  const daqui = (horas: number) => new Date(Date.now() + horas * 3_600_000);
  const iso = (d: Date) => d.toISOString();

  /**
   * Banco falso só para a rota PATCH: guarda a linha, respeita o filtro de
   * organização e o claim por status. `depoisDoSelect` simula o cron virando a
   * janela entre a leitura e a escrita da rota.
   */
  function dbDaRota(linhas: Linha[], depoisDoSelect?: (linha: Linha) => void) {
    function tabela(nome: string) {
      const ctx: { filtros: Filtro[]; tipo: "select" | "update"; valor: unknown } = {
        filtros: [],
        tipo: "select",
        valor: null,
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) {
        b[m] = (...args: unknown[]) => {
          if (m !== "select") ctx.filtros.push([m, args]);
          return b;
        };
      }
      b.update = (valor: unknown) => {
        ctx.tipo = "update";
        ctx.valor = valor;
        return b;
      };
      b.maybeSingle = async () => resolver(ctx, nome).then((r) => ({ ...r, data: unico(r.data) }));
      b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
        resolver(ctx, nome).then(ok, erro);
      return b;
    }
    const unico = (d: unknown) => (Array.isArray(d) ? (d[0] ?? null) : d);
    const valorDe = (filtros: Filtro[], metodo: string, coluna: string): unknown =>
      filtros.find(([m, args]) => m === metodo && args[0] === coluna)?.[1]?.[1];

    async function resolver(
      ctx: { filtros: Filtro[]; tipo: "select" | "update"; valor: unknown },
      nome: string,
    ): Promise<{ data: unknown; error: null }> {
      if (nome !== "channel_schedules") throw new Error(`tabela não prevista: ${nome}`);
      const id = String(valorDe(ctx.filtros, "eq", "id") ?? "");
      const org = valorDe(ctx.filtros, "eq", "organization_id");
      const alvo = linhas.find((l) => l.id === id && (org === undefined || l.organization_id === org));
      if (ctx.tipo === "update") {
        const esperado = valorDe(ctx.filtros, "eq", "status");
        if (!alvo || (esperado && alvo.status !== esperado)) return { data: [], error: null };
        Object.assign(alvo, ctx.valor as Linha);
        return { data: [{ id }], error: null };
      }
      if (!alvo) return { data: null, error: null };
      const lida = { ...alvo };
      depoisDoSelect?.(alvo);
      return { data: lida, error: null };
    }

    return { from: (nome: string) => tabela(nome), rpc: vi.fn() };
  }

  const reqPatch = (id: string, body: unknown) =>
    new NextRequest(`http://localhost/api/v1/channel-schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });

  it("grava o horário novo e o cron passa a obedecer o NOVO, não o antigo", async () => {
    const antigo = daqui(2);
    const novo = daqui(6);
    const fim = daqui(8);
    const linha: Linha = {
      id: JANELA,
      organization_id: ORG,
      channel_session_id: null,
      status: "scheduled",
      starts_at: iso(antigo),
      ends_at: iso(daqui(3)),
      paused_channel_ids: [],
      created_by: AUTORA,
    };
    vi.mocked(createAdminClient).mockReturnValue(dbDaRota([linha]) as never);

    const r = await PATCH(reqPatch(JANELA, { starts_at: iso(novo), ends_at: iso(fim) }), {
      params: Promise.resolve({ id: JANELA }),
    });

    expect(r.status).toBe(200);
    expect(linha.starts_at).toBe(iso(novo));
    expect(linha.ends_at).toBe(iso(fim));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.schedule_updated", resourceId: JANELA, organizationId: ORG }),
    );

    // No instante do horário ANTIGO o cron já NÃO pausa: o início é o novo.
    const dbAntigo = dbFalso({ agendas: [linha], canais: [canal(CANAL)] });
    const resumoAntigo = await aplicarAgendas(dbAntigo as never, antigo);
    expect(resumoAntigo.pausadas).toBe(0);
    expect(dbAntigo.rpc).not.toHaveBeenCalled();

    // No instante do horário NOVO, pausa.
    const dbNovo = dbFalso({ agendas: [linha], canais: [canal(CANAL)] });
    const resumoNovo = await aplicarAgendas(dbNovo as never, novo);
    expect(resumoNovo.pausadas).toBe(1);
    expect(dbNovo.rpc).toHaveBeenCalledWith(
      "fn_definir_pausa_de_canal",
      expect.objectContaining({ p_canal: CANAL, p_desativado: true, p_origem: "schedule" }),
    );
  });

  it("não edita janela que já começou (409) — o passado não se reescreve", async () => {
    const inicioAntigo = iso(daqui(-1));
    const linha: Linha = {
      id: JANELA,
      organization_id: ORG,
      status: "running",
      starts_at: inicioAntigo,
      ends_at: iso(daqui(1)),
    };
    vi.mocked(createAdminClient).mockReturnValue(dbDaRota([linha]) as never);

    const r = await PATCH(reqPatch(JANELA, { starts_at: iso(daqui(2)), ends_at: iso(daqui(3)) }), {
      params: Promise.resolve({ id: JANELA }),
    });

    expect(r.status).toBe(409);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("ainda não começou");
    expect(linha.starts_at).toBe(inicioAntigo);
  });

  it("não edita janela de OUTRA organização (404, nada gravado)", async () => {
    const inicioAntigo = iso(daqui(2));
    const linha: Linha = {
      id: JANELA,
      organization_id: ORG_2,
      status: "scheduled",
      starts_at: inicioAntigo,
      ends_at: iso(daqui(3)),
    };
    vi.mocked(createAdminClient).mockReturnValue(dbDaRota([linha]) as never);

    const r = await PATCH(reqPatch(JANELA, { starts_at: iso(daqui(6)), ends_at: iso(daqui(8)) }), {
      params: Promise.resolve({ id: JANELA }),
    });

    expect(r.status).toBe(404);
    expect(linha.starts_at).toBe(inicioAntigo);
    expect(audit).not.toHaveBeenCalled();
  });

  it("perde a corrida para o cron que abriu a janela: 409 e nada gravado", async () => {
    const inicioAntigo = iso(daqui(2));
    const linha: Linha = {
      id: JANELA,
      organization_id: ORG,
      status: "scheduled",
      starts_at: inicioAntigo,
      ends_at: iso(daqui(3)),
    };
    // A rota lê `scheduled`; antes do update, o cron vira a linha para `running`.
    vi.mocked(createAdminClient).mockReturnValue(
      dbDaRota([linha], (l) => {
        l.status = "running";
      }) as never,
    );

    const r = await PATCH(reqPatch(JANELA, { starts_at: iso(daqui(6)), ends_at: iso(daqui(8)) }), {
      params: Promise.resolve({ id: JANELA }),
    });

    expect(r.status).toBe(409);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("mudou de estado");
    expect(linha.starts_at).toBe(inicioAntigo);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem papel admin não há edição sequer", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("negado", { status: 403 }),
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const r = await PATCH(reqPatch(JANELA, { starts_at: iso(daqui(2)), ends_at: iso(daqui(3)) }), {
      params: Promise.resolve({ id: JANELA }),
    });

    expect(r.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

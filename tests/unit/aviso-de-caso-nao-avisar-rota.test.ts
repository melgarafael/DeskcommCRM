/**
 * "NÃO ENVIAR AVISO DE CASO" (#4989) — a gravação pela rota e a leitura da tela.
 *
 * A marca mora em `organizations.settings.aviso_de_caso_nao_avisar` (jsonb, sem
 * migration). Três coisas que este arquivo prova:
 *
 * 1. Só viaja e só muda o que a pessoa MEXEU: um membro que a tela não mostrou
 *    não perde a marca por omissão (a mesma lição do #3935 para o WhatsApp).
 * 2. `settings` é compartilhado: gravar a marca não pode apagar as outras chaves.
 * 3. A marca é gravada DEPOIS do RPC; se ela falhar, a resposta diz que o resto
 *    foi salvo e a marca não — em vez de um "salvo" que mente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerEstadoDaTelaDeAviso } from "@/lib/escalacao/tela-do-aviso";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/tela-do-aviso", () => ({ lerEstadoDaTelaDeAviso: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false) }));

const { PUT, PATCH } = await import("@/app/api/v1/ai/cases/alerta/route");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const FILA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARLA_QUE_SAIU = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTRO_MARCADO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const CORPO = {
  channel_session_id: CANAL,
  telefone: "+5531998966398",
  rotulo: null,
  ligado: true,
  destino_modo: "responsavel",
};

function put(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/cases/alerta", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/cases/alerta", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/**
 * O client de serviço: `organizations` (ler `settings` + `updated_at` e gravar
 * com a condição do `updated_at`) e `user_organizations` (quem é membro ativo).
 * `concorrentes` simula escritas de OUTRA requisição que chegam entre a nossa
 * leitura e a nossa gravação: cada uma troca o `settings` e o carimbo.
 */
function adminFalso(opts: {
  settings: Record<string, unknown> | null;
  ativos: string[];
  erroAoGravar?: { message: string } | null;
  concorrentes?: Array<Record<string, unknown>>;
}) {
  const banco = { settings: opts.settings, updated_at: "2026-11-21T10:00:00.000000+00:00", versao: 0 };
  const concorrentes = [...(opts.concorrentes ?? [])];
  const gravacoes: Array<Record<string, unknown>> = [];
  const from = vi.fn((tabela: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in"]) c[m] = () => c;
    if (tabela === "organizations") {
      c.maybeSingle = async () => {
        const lido = { settings: banco.settings, updated_at: banco.updated_at };
        // Outra requisição grava DEPOIS da nossa leitura.
        const outra = concorrentes.shift();
        if (outra) {
          banco.settings = outra;
          banco.versao += 1;
          banco.updated_at = `2026-11-21T10:00:0${banco.versao}.000000+00:00`;
        }
        return { data: lido, error: null };
      };
      c.update = (valor: Record<string, unknown>) => {
        const filtros: Record<string, unknown> = {};
        const u: Record<string, unknown> = {};
        u.eq = (col: string, v: unknown) => {
          filtros[col] = v;
          return u;
        };
        u.select = async () => {
          if (opts.erroAoGravar) return { data: null, error: opts.erroAoGravar };
          if (filtros.updated_at !== banco.updated_at) return { data: [], error: null };
          gravacoes.push(valor);
          banco.settings = valor.settings as Record<string, unknown>;
          return { data: [{ id: ORG }], error: null };
        };
        return u;
      };
    }
    if (tabela === "user_organizations") {
      c.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.ativos.map((user_id) => ({ user_id })), error: null }).then(ok);
    }
    return c;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return { gravacoes, from, banco };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({ rpc: vi.fn(async () => ({ data: {}, error: null })) } as never);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(lerEstadoDaTelaDeAviso).mockResolvedValue({ config: null } as never);
});

describe("PUT — a marca 'não enviar aviso de caso'", () => {
  it("grava só o que mudou e preserva as outras chaves de settings", async () => {
    const { gravacoes } = adminFalso({
      settings: { branding: { cor: "azul" }, aviso_de_caso_nao_avisar: { user_ids: [OUTRO_MARCADO, ANA] } },
      ativos: [FILA, ANA],
    });
    const r = await PUT(
      put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }, { user_id: ANA, nao_avisar: false }] }),
    );
    expect(r.status).toBe(200);
    expect(gravacoes).toHaveLength(1);
    const settings = gravacoes[0]!.settings as Record<string, unknown>;
    expect(settings.branding).toEqual({ cor: "azul" });
    // O OUTRO_MARCADO não foi mostrado nem mexido: continua marcado.
    expect(
      [...((settings.aviso_de_caso_nao_avisar as { user_ids: string[] }).user_ids)].sort(),
    ).toEqual([FILA, OUTRO_MARCADO].sort());
  });

  it("marcar quem não é membro ativo não grava ninguém", async () => {
    const { gravacoes } = adminFalso({ settings: {}, ativos: [FILA] });
    const r = await PUT(put({ ...CORPO, nao_avisar: [{ user_id: CARLA_QUE_SAIU, nao_avisar: true }] }));
    expect(r.status).toBe(200);
    const settings = (gravacoes[0]?.settings ?? {}) as Record<string, unknown>;
    expect((settings.aviso_de_caso_nao_avisar as { user_ids: string[] } | undefined)?.user_ids ?? []).toEqual([]);
  });

  it("sem o campo, settings nem é lido", async () => {
    const { from } = adminFalso({ settings: {}, ativos: [] });
    const r = await PUT(put(CORPO));
    expect(r.status).toBe(200);
    expect(from).not.toHaveBeenCalledWith("organizations");
  });

  it("o RPC recusou: a marca não é gravada", async () => {
    const { gravacoes } = adminFalso({ settings: {}, ativos: [FILA] });
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(async () => ({ data: null, error: { message: "aviso_de_caso_forbidden" } })),
    } as never);
    const r = await PUT(put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }] }));
    expect(r.status).toBe(403);
    expect(gravacoes).toHaveLength(0);
  });

  it("a marca não gravou: 500 dizendo que o resto foi salvo e a marca não", async () => {
    adminFalso({ settings: {}, ativos: [FILA], erroAoGravar: { message: "timeout" } });
    const r = await PUT(put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }] }));
    expect(r.status).toBe(500);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("aviso_nao_avisar_nao_salvo");
    expect(corpo.error.message).toContain("Não enviar aviso de caso");
  });

  it("corpo com campo desconhecido dentro da marca é recusado (strict)", async () => {
    adminFalso({ settings: {}, ativos: [FILA] });
    const r = await PUT(put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true, extra: 1 }] }));
    expect(r.status).toBe(422);
  });

  it("outra escrita em organizations chegou no meio: relê e não apaga o que ela gravou", async () => {
    const { gravacoes, banco } = adminFalso({
      settings: { branding: { cor: "azul" } },
      ativos: [FILA],
      // Outro admin marcou a Ana (e outra tela mexeu em `mfa`) depois da nossa leitura.
      concorrentes: [{ branding: { cor: "azul" }, mfa: { exigir: true }, aviso_de_caso_nao_avisar: { user_ids: [ANA] } }],
    });
    const r = await PUT(put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }] }));
    expect(r.status).toBe(200);
    expect(gravacoes).toHaveLength(1);
    const settings = banco.settings as Record<string, unknown>;
    expect(settings.mfa).toEqual({ exigir: true });
    expect([...(settings.aviso_de_caso_nao_avisar as { user_ids: string[] }).user_ids].sort()).toEqual([ANA, FILA].sort());
  });

  it("a auditoria da marca conta o que de fato gravou — e não sai quando não gravou", async () => {
    adminFalso({ settings: {}, ativos: [FILA] });
    await PUT(
      put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }, { user_id: CARLA_QUE_SAIU, nao_avisar: true }] }),
    );
    const daMarca = vi.mocked(audit).mock.calls.map((c) => c[0]).filter((e) => e.action === "ai.case_alert_nao_avisar_changed");
    expect(daMarca).toHaveLength(1);
    expect(daMarca[0]!.metadata).toEqual({ ligados: 1, desligados: 0, ignorados: 1 });

    // Ligar quem já estava ligado não é "ligou"; desligar quem não estava, idem.
    vi.mocked(audit).mockClear();
    adminFalso({ settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] } }, ativos: [FILA] });
    await PUT(
      put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }, { user_id: ANA, nao_avisar: false }] }),
    );
    const repetida = vi.mocked(audit).mock.calls.map((c) => c[0]).filter((e) => e.action === "ai.case_alert_nao_avisar_changed");
    expect(repetida[0]!.metadata).toEqual({ ligados: 0, desligados: 0, ignorados: 0 });

    vi.mocked(audit).mockClear();
    adminFalso({ settings: {}, ativos: [FILA], erroAoGravar: { message: "timeout" } });
    await PUT(put({ ...CORPO, nao_avisar: [{ user_id: FILA, nao_avisar: true }] }));
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].action)).not.toContain("ai.case_alert_nao_avisar_changed");
  });
});

describe("PATCH — só a marca, sem o RPC", () => {
  it("grava a marca e NÃO chama o RPC (que tocaria a revisão dos avisos de resposta enfileirados)", async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);
    const { gravacoes } = adminFalso({ settings: {}, ativos: [FILA] });
    const r = await PATCH(patch({ nao_avisar: [{ user_id: FILA, nao_avisar: true }] }));
    expect(r.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect((gravacoes[0]!.settings as Record<string, { user_ids: string[] }>).aviso_de_caso_nao_avisar!.user_ids).toEqual([FILA]);
  });

  it("exige admin e MFA, e recusa corpo vazio ou com outros campos", async () => {
    adminFalso({ settings: {}, ativos: [FILA] });
    expect((await PATCH(patch({ nao_avisar: [] }))).status).toBe(422);
    expect((await PATCH(patch({ nao_avisar: [{ user_id: FILA, nao_avisar: true }], ligado: false }))).status).toBe(422);
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    expect((await PATCH(patch({ nao_avisar: [{ user_id: FILA, nao_avisar: true }] }))).status).toBe(403);
  });

  it("a gravação falhou: 500 com a frase da marca", async () => {
    adminFalso({ settings: {}, ativos: [FILA], erroAoGravar: { message: "timeout" } });
    const r = await PATCH(patch({ nao_avisar: [{ user_id: FILA, nao_avisar: true }] }));
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("aviso_nao_avisar_nao_salvo");
  });
});

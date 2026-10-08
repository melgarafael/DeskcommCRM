/**
 * GET/PUT /api/v1/ai/cases/alerta e POST /api/v1/ai/cases/alerta/teste.
 *
 * ## O que este arquivo prova, e o que ele NÃO prova
 *
 * Prova o que a rota faz com a resposta do banco: que cada exceção do RPC vira
 * uma frase e um código próprios, que a auditoria sai com o número MASCARADO, e
 * que a pergunta do "número que já é cliente" chega à tela como pergunta (422 +
 * código) em vez de virar erro genérico.
 *
 * **Não** prova a guarda de suporte. Quem a cobra é
 * `tests/unit/suporte-cobertura-de-efeitos.test.ts`, que varre o TEXTO de todo
 * handler mutante — e é ele o instrumento, porque aqui a função está mockada e
 * apagá-la da rota deixaria estes casos verdes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { enviarAvisoDeTeste } from "@/lib/escalacao/aviso-de-teste";
import { fail } from "@/lib/api/wrappers";
import { lerEstadoDaTelaDeAviso } from "@/lib/escalacao/tela-do-aviso";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/escalacao/tela-do-aviso", () => ({ lerEstadoDaTelaDeAviso: vi.fn() }));
vi.mock("@/lib/escalacao/aviso-de-teste", () => ({ enviarAvisoDeTeste: vi.fn() }));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: vi.fn(async () => ({})),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: vi.fn(async () => ({})),
}));

const { GET, PUT } = await import("@/app/api/v1/ai/cases/alerta/route");
const { POST: TESTE } = await import("@/app/api/v1/ai/cases/alerta/teste/route");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const TELEFONE = "+5531998966398";

const ESTADO_VAZIO = {
  config: null,
  conexoes: [],
  avisos: [],
  pode_ligar: false,
  entregas: [],
  laco: {
    comAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
    semAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
    medianaAteOAvisoMinutos: null,
  },
};

function sessao(role: Role = "admin") {
  const user: AuthUser = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[role] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG, name: "Org", role } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
}

/** O client de sessão: um `rpc` que devolve o que o caso mandar, e um `from`. */
function clienteDeSessao(opts: {
  rpc?: { data?: unknown; error?: { message: string } | null };
  config?: {
    channel_session_id: string | null;
    telefone_destino: string;
    sem_link?: boolean;
  } | null;
  erroDaConfig?: { message: string } | null;
}) {
  const rpc = vi.fn(async () => opts.rpc ?? { data: {}, error: null });
  const from = vi.fn(() => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) c[m] = () => c;
    c.maybeSingle = async () => ({
      data: opts.config ?? null,
      error: opts.erroDaConfig ?? null,
    });
    return c;
  });
  vi.mocked(createClient).mockResolvedValue({ rpc, from } as never);
  return { rpc, from };
}

function put(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/cases/alerta", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const CORPO_OK = {
  channel_session_id: CANAL,
  telefone: TELEFONE,
  rotulo: "Plantão da Ana",
  ligado: true,
  // A omissão deve preservar a compatibilidade e resultar no opt-in desligado.
};

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
  vi.mocked(lerEstadoDaTelaDeAviso).mockResolvedValue(ESTADO_VAZIO as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, limit: 3, count: 1 } as never);
});

describe("GET — o estado da tela", () => {
  it("exige admin", async () => {
    sessao("manager");
    const r = await GET(new NextRequest("http://localhost/api/v1/ai/cases/alerta"));
    expect(r.status).toBe(403);
    expect(lerEstadoDaTelaDeAviso).not.toHaveBeenCalled();
  });

  it("devolve o estado inteiro numa consulta só", async () => {
    clienteDeSessao({});
    const r = await GET(new NextRequest("http://localhost/api/v1/ai/cases/alerta"));
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: typeof ESTADO_VAZIO };
    // Alertas, conexões, entregas e laço saem JUNTOS: duas consultas
    // independentes deixariam a tela dizendo "nenhuma conexão" com o seletor
    // cheio.
    expect(Object.keys(corpo.data).sort()).toEqual([
      "avisos",
      "conexoes",
      "config",
      "entregas",
      "laco",
      "pode_ligar",
    ]);
  });

  it("devolve a escolha salva de reforços sem inferi-la do aviso inicial", async () => {
    vi.mocked(lerEstadoDaTelaDeAviso).mockResolvedValue({
      ...ESTADO_VAZIO,
      config: {
        channel_session_id: CANAL,
        telefone: TELEFONE,
        rotulo: null,
        ligado: false,
        repetir_lembretes_whatsapp: true,
        minutos_lembrete_equipe: [2, 7, 15],
        atualizado_em: "2026-10-07T12:00:00.000Z",
      },
    } as never);
    clienteDeSessao({});
    const r = await GET(new NextRequest("http://localhost/api/v1/ai/cases/alerta"));
    const corpo = (await r.json()) as {
      data: {
        config: {
          repetir_lembretes_whatsapp: boolean;
          minutos_lembrete_equipe: number[];
          ligado: boolean;
        } | null;
      };
    };
    expect(corpo.data.config).toMatchObject({
      repetir_lembretes_whatsapp: true,
      minutos_lembrete_equipe: [2, 7, 15],
      ligado: false,
    });
  });
});

describe("PUT — salvar a configuração", () => {
  it("exige admin", async () => {
    sessao("manager");
    expect((await PUT(put(CORPO_OK))).status).toBe(403);
  });

  it("recusa corpo inválido antes de tocar o banco", async () => {
    const { rpc } = clienteDeSessao({});
    const r = await PUT(put({ ...CORPO_OK, telefone: "31998966398" }));
    expect(r.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("chama o RPC pelo client de SESSÃO — ele lê `auth.uid()`", async () => {
    const { rpc } = clienteDeSessao({});
    await PUT(put(CORPO_OK));
    expect(rpc).toHaveBeenCalledWith(
      "fn_definir_aviso_de_caso_repeticao",
      expect.objectContaining({
        p_org: ORG,
        p_channel: CANAL,
        p_telefone: TELEFONE,
        p_ligado: true,
        p_confirma_contato: false,
        p_sem_link: false,
        p_repetir_lembretes_whatsapp: false,
        p_minutos_lembrete_equipe: [3, 6, 9],
      }),
    );
  });

  it("valida 1–10 minutos inteiros, distintos e crescentes, dentro de 24 horas", async () => {
    const { rpc } = clienteDeSessao({});
    for (const minutos of [
      [],
      [0],
      [1441],
      [3, 3],
      [6, 3],
      Array.from({ length: 11 }, (_, i) => i + 1),
      [1.5],
    ]) {
      const r = await PUT(put({ ...CORPO_OK, minutos_lembrete_equipe: minutos }));
      expect(r.status, JSON.stringify(minutos)).toBe(422);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("envia a cadência escolhida ao RPC", async () => {
    const { rpc } = clienteDeSessao({});
    await PUT(put({ ...CORPO_OK, minutos_lembrete_equipe: [1, 5, 20, 1440] }));
    expect(rpc).toHaveBeenCalledWith(
      "fn_definir_aviso_de_caso_repeticao",
      expect.objectContaining({ p_minutos_lembrete_equipe: [1, 5, 20, 1440] }),
    );
  });

  it("a auditoria leva o número MASCARADO, e nunca o telefone inteiro", async () => {
    clienteDeSessao({ rpc: { data: { trocou_numero: true, antes_ligado: false }, error: null } });
    await PUT(put(CORPO_OK));

    const entrada = vi.mocked(audit).mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(entrada.action).toBe("ai.case_alert_settings_changed");
    expect(entrada.metadata.destino_mascarado).toBe("••••6398");
    expect(entrada.metadata).toMatchObject({
      trocou_numero: true,
      antes_ligado: false,
      depois_ligado: true,
      repetir_lembretes_whatsapp: false,
    });
    // `api_audit_log` é append-only e a cascata de LGPD não o alcança: o que
    // entra ali fica para sempre.
    expect(JSON.stringify(entrada.metadata)).not.toContain("998966398");
  });

  it("o número que já é de um cliente vira PERGUNTA, com código próprio", async () => {
    clienteDeSessao({ rpc: { error: { message: "aviso_de_caso_numero_de_cliente" } } });
    const r = await PUT(put(CORPO_OK));
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("aviso_numero_de_cliente");
    expect(corpo.error.message).toContain("param de chegar ao CRM");
    // Pergunta não é efeito: nada foi salvo, e nada é auditado.
    expect(audit).not.toHaveBeenCalled();
  });

  it("confirmado, o mesmo corpo passa com `p_confirma_contato`", async () => {
    const { rpc } = clienteDeSessao({});
    await PUT(put({ ...CORPO_OK, confirma_contato: true }));
    expect(rpc).toHaveBeenCalledWith(
      "fn_definir_aviso_de_caso_repeticao",
      expect.objectContaining({ p_confirma_contato: true }),
    );
  });

  it("cada exceção do RPC tem um código e um status PRÓPRIOS", async () => {
    const casos = [
      ["aviso_de_caso_forbidden", 403, "forbidden_role"],
      ["aviso_de_caso_mfa_required", 403, "mfa_required"],
      ["aviso_de_caso_telefone_invalido", 422, "validation_failed"],
      ["aviso_de_caso_canal_invalido", 422, "aviso_canal_invalido"],
      ["aviso_de_caso_numero_da_propria_org", 422, "aviso_numero_da_propria_org"],
    ] as const;
    for (const [excecao, status, code] of casos) {
      vi.clearAllMocks();
      sessao();
      clienteDeSessao({ rpc: { error: { message: `erro: ${excecao}` } } });
      const r = await PUT(put(CORPO_OK));
      expect(r.status, excecao).toBe(status);
      expect(((await r.json()) as { error: { code: string } }).error.code, excecao).toBe(code);
    }
  });

  it("exceção desconhecida vira 500 genérico — nunca o texto cru do Postgres", async () => {
    clienteDeSessao({ rpc: { error: { message: 'relation "x" does not exist' } } });
    const r = await PUT(put(CORPO_OK));
    expect(r.status).toBe(500);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).not.toContain("relation");
  });
});

describe("POST /teste — o botão que manda de verdade", () => {
  const req = () =>
    new NextRequest("http://localhost/api/v1/ai/cases/alerta/teste", { method: "POST" });

  it("exige admin", async () => {
    sessao("manager");
    expect((await TESTE(req())).status).toBe(403);
    expect(enviarAvisoDeTeste).not.toHaveBeenCalled();
  });

  it("tem balde PRÓPRIO — cinco conferências consomem um quarto do dia do número", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, limit: 3, count: 4 } as never);
    clienteDeSessao({ config: { channel_session_id: CANAL, telefone_destino: TELEFONE } });
    const r = await TESTE(req());
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("3600");
    expect(vi.mocked(checkRateLimit).mock.calls[0]![0]).toBe(`aviso-teste:${ORG}`);
    expect(enviarAvisoDeTeste).not.toHaveBeenCalled();
  });

  it("sem configuração SALVA não manda nada, e diz o que falta", async () => {
    clienteDeSessao({ config: null });
    const r = await TESTE(req());
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "aviso_nao_configurado",
    );
    expect(enviarAvisoDeTeste).not.toHaveBeenCalled();
  });

  it("usa a configuração SALVA, não um corpo do cliente", async () => {
    clienteDeSessao({ config: { channel_session_id: CANAL, telefone_destino: TELEFONE } });
    vi.mocked(enviarAvisoDeTeste).mockResolvedValue({
      enviado: true,
      destinoMascarado: "••••6398",
      externalId: null,
    });
    await TESTE(req());
    expect(vi.mocked(enviarAvisoDeTeste).mock.calls[0]![1]).toEqual({
      organizationId: ORG,
      channelSessionId: CANAL,
      telefone: TELEFONE,
      sem_link: false,
    });
  });

  it("a recusa volta 200 com o motivo — ela É a resposta que o botão pediu", async () => {
    clienteDeSessao({ config: { channel_session_id: CANAL, telefone_destino: TELEFONE } });
    vi.mocked(enviarAvisoDeTeste).mockResolvedValue({
      enviado: false,
      codigo: "teto_diario_do_numero",
    });
    const r = await TESTE(req());
    // Num 4xx o motivo cairia no envelope de erro e a tela o trocaria por "erro
    // inesperado", apagando a única informação que o clique produzia.
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { codigo: string } }).data.codigo).toBe(
      "teto_diario_do_numero",
    );
  });

  it("audita nos DOIS desfechos, com o número mascarado e o motivo", async () => {
    clienteDeSessao({ config: { channel_session_id: CANAL, telefone_destino: TELEFONE } });
    vi.mocked(enviarAvisoDeTeste).mockResolvedValue({
      enviado: false,
      codigo: "canal_desconectado",
    });
    await TESTE(req());
    const entrada = vi.mocked(audit).mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(entrada.action).toBe("ai.case_alert_test_sent");
    expect(entrada.metadata).toMatchObject({
      destino_mascarado: "••••6398",
      enviado: false,
      motivo: "canal_desconectado",
    });
    expect(JSON.stringify(entrada.metadata)).not.toContain("998966398");
  });
});

describe("configuração do modo local", () => {
  it.each([true, false])(
    "grava sem_link=%s pelo RPC com as guardas originais",
    async (sem_link) => {
      const { rpc } = clienteDeSessao({});
      const r = await PUT(put({ ...CORPO_OK, sem_link }));
      expect(r.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith(
        "fn_definir_aviso_de_caso_repeticao",
        expect.objectContaining({
          p_org: ORG,
          p_sem_link: sem_link,
          p_repetir_lembretes_whatsapp: false,
          p_confirma_contato: false,
        }),
      );
    },
  );

  it("salva o opt-in de reforços independentemente do aviso inicial e do modo sem link", async () => {
    const { rpc } = clienteDeSessao({});
    const r = await PUT(
      put({ ...CORPO_OK, ligado: false, sem_link: true, repetir_lembretes_whatsapp: true }),
    );
    expect(r.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "fn_definir_aviso_de_caso_repeticao",
      expect.objectContaining({
        p_ligado: false,
        p_sem_link: true,
        p_repetir_lembretes_whatsapp: true,
      }),
    );
    const entrada = vi.mocked(audit).mock.calls[0]![0] as {
      metadata: Record<string, unknown>;
    };
    expect(entrada.metadata.repetir_lembretes_whatsapp).toBe(true);
    expect(JSON.stringify(entrada.metadata)).not.toContain("998966398");
  });
  it("o botão de teste usa modo sem link salvo", async () => {
    clienteDeSessao({
      config: { channel_session_id: CANAL, telefone_destino: TELEFONE, sem_link: true },
    });
    vi.mocked(enviarAvisoDeTeste).mockResolvedValue({
      enviado: true,
      destinoMascarado: "***0000",
      externalId: null,
    });
    await TESTE(
      new NextRequest("http://localhost/api/v1/ai/cases/alerta/teste", { method: "POST" }),
    );
    expect(vi.mocked(enviarAvisoDeTeste).mock.calls[0]![1]).toEqual({
      organizationId: ORG,
      channelSessionId: CANAL,
      telefone: TELEFONE,
      sem_link: true,
    });
  });
});

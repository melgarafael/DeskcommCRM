import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { type ApiError } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { seAvisosDesligado } from "@/lib/avisos/modulo";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";

import { POST } from "./route";

/**
 * POST /api/v1/avisos — o aviso escrito pelo ADMIN (#1418, fatia 1).
 *
 * O que este teste protege é a diferença entre "salvei o recado" e "o recado
 * tocou o celular de alguém": a janela. Publicar cedo demais entrega antes da
 * hora combinada; publicar um aviso já expirado entrega o que não vale mais.
 * Nos dois casos o certo é gravar e NÃO empurrar.
 *
 * O agendamento é o terceiro caso, e a resposta é outra: nada publica o aviso
 * DEPOIS nesta fatia (não há cron/worker), então um `publicar_em` no futuro
 * ficaria gravado para sempre sem tocar em ninguém. Ele é RECUSADO com 400
 * antes do insert, e a mensagem diz o caminho — publicar agora ou sem data.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/avisos/modulo", () => ({ seAvisosDesligado: vi.fn(async () => null) }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const AUTOR = "11111111-1111-4111-8111-111111111111";

/** O relógio congelado da rota: o `new Date()` dela devolve exatamente isto. */
const AGORA = new Date("2026-11-02T12:00:00.000Z");
const TOLERANCIA_MS = 60_000;
const HORA_MS = 60 * 60 * 1000;

function avisoSalvo(extra: Record<string, unknown> = {}) {
  return {
    id: "aviso-1",
    organization_id: ORG,
    autor_id: AUTOR,
    titulo: "Manutenção às 22h",
    corpo: "O WhatsApp fica ~20 min fora.",
    publicar_em: AGORA.toISOString(),
    expira_em: null,
    created_at: AGORA.toISOString(),
    ...extra,
  };
}

function bancoQueSalva(salvo: Record<string, unknown>) {
  const single = vi.fn(async () => ({ data: salvo, error: null }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn((_linha: { publicar_em: string | null }) => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { from, insert, select, single };
}

function pedido(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/avisos", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const CORPO_VALIDO = { titulo: "Manutenção às 22h", corpo: "O WhatsApp fica ~20 min fora." };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(seAvisosDesligado).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: AUTOR, idioma: "pt-BR" },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v1/avisos", () => {
  it("publica quando o aviso está dentro da janela", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(201);
    expect(banco.insert).toHaveBeenCalledWith(
      // Sem data, grava o relógio da rota — nunca `null`: a coluna é
      // `not null default now()`, e `null` explícito não aciona o default (23502).
      expect.objectContaining({ organization_id: ORG, autor_id: AUTOR, publicar_em: AGORA.toISOString() }),
    );
    expect(enviarPushDaOrg).toHaveBeenCalledTimes(1);
    expect(enviarPushDaOrg).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ title: "Manutenção às 22h" }),
    );
  });

  it("recusa com 400 o aviso marcado para o futuro, sem gravar nem empurrar", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const futuro = new Date(AGORA.getTime() + HORA_MS).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, publicar_em: futuro }));

    const corpo = (await resposta.json()) as ApiError;
    expect(resposta.status).toBe(400);
    expect(corpo.error.code).toBe("aviso_agendado_nao_suportado");
    expect(corpo.error.message).toContain("Publique agora");
    // O ponto do arremate: o aviso agendado não é gravado nem empurrado.
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("recusa um segundo além da tolerância de relógio", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const alem = new Date(AGORA.getTime() + TOLERANCIA_MS + 1_000).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, publicar_em: alem }));

    expect(resposta.status).toBe(400);
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("absorve o relógio do cliente adiantado alguns segundos e grava como agora", async () => {
    // "Publicar agora" num navegador com skew manda um instante à frente do
    // servidor. Isso NÃO é agendamento: entra, e o valor gravado é o relógio
    // desta rota — a linha não nasce no futuro.
    const banco = bancoQueSalva(avisoSalvo({ publicar_em: AGORA.toISOString() }));
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const adiantado = new Date(AGORA.getTime() + TOLERANCIA_MS).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, publicar_em: adiantado }));

    expect(resposta.status).toBe(201);
    expect(banco.insert).toHaveBeenCalledWith(
      expect.objectContaining({ publicar_em: AGORA.toISOString() }),
    );
    expect(enviarPushDaOrg).toHaveBeenCalledTimes(1);
  });

  it("aceita e publica `publicar_em` no passado", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const passado = new Date(AGORA.getTime() - HORA_MS).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, publicar_em: passado }));

    expect(resposta.status).toBe(201);
    expect(banco.insert).toHaveBeenCalledWith(expect.objectContaining({ publicar_em: passado }));
    expect(enviarPushDaOrg).toHaveBeenCalledTimes(1);
  });

  it("grava mas NÃO publica quando o aviso já expirou", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const passado = new Date(AGORA.getTime() - HORA_MS).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, expira_em: passado }));

    expect(resposta.status).toBe(201);
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("nenhum aviso aceito nasce com `publicar_em` no futuro", async () => {
    // A varredura dos caminhos que chegam ao insert: ausente, passado e o
    // futuro que a tolerância transforma em "agora". Em todos, o valor gravado
    // é preenchido e <= relógio da rota — o banco não guarda um agendamento órfão.
    const casos: Array<string | undefined> = [
      undefined,
      new Date(AGORA.getTime() - HORA_MS).toISOString(),
      new Date(AGORA.getTime() + TOLERANCIA_MS).toISOString(),
    ];

    for (const publicarEm of casos) {
      const banco = bancoQueSalva(avisoSalvo());
      vi.mocked(createAdminClient).mockReturnValue(banco as never);

      const resposta = await POST(
        pedido(publicarEm ? { ...CORPO_VALIDO, publicar_em: publicarEm } : CORPO_VALIDO),
      );

      expect(resposta.status).toBe(201);
      const gravado = banco.insert.mock.calls[0]![0];
      expect(gravado.publicar_em).not.toBeNull();
      expect(new Date(gravado.publicar_em!) <= AGORA).toBe(true);
    }
  });

  it("a recusa fala o idioma de quem pediu", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: ORG },
      user: { id: AUTOR, idioma: "es" },
    } as never);
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const futuro = new Date(AGORA.getTime() + HORA_MS).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, publicar_em: futuro }));

    const corpo = (await resposta.json()) as ApiError;
    expect(resposta.status).toBe(400);
    expect(corpo.error.message).toContain("Publica ahora");
  });

  it("recusa quem não é admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    } as never);
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(403);
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("recusa em acompanhamento somente leitura, antes de gravar e de empurrar", async () => {
    // `support_readonly` enxerga a empresa mas não escreve: o aviso sairia como
    // push para todos em nome do cliente. A guarda de efeito vem antes do RBAC
    // e do admin client, e é o que este caso mede (ordem, não só status).
    // `requireSupportWrite` devolve `NextResponse<ApiError>` (é o `fail()` que a
    // rota repassa). O dublê espelha o corpo e o status reais para o 403 testado
    // aqui ser o mesmo objeto que a produção entrega, não um Response genérico.
    vi.mocked(requireSupportWrite).mockResolvedValue(
      NextResponse.json<ApiError>(
        { error: { code: "forbidden", message: "Acompanhamento somente leitura." } },
        { status: 403 },
      ),
    );
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("módulo desligado (o padrão): 404 antes de autorizar, gravar ou empurrar", async () => {
    vi.mocked(seAvisosDesligado).mockResolvedValue(
      NextResponse.json<ApiError>({ error: { code: "not_found", message: "Not found." } }, { status: 404 }),
    );
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(404);
    expect(requireSupportWrite).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("audita a criação com a janela, sem o texto do aviso", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(201);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aviso.created",
        actorUserId: AUTOR,
        organizationId: ORG,
        resourceType: "avisos",
        resourceId: "aviso-1",
        metadata: { publicar_em: AGORA.toISOString(), expira_em: null },
      }),
    );
  });

  it("recusa título e corpo acima do teto, sem gravar", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    for (const corpo of [
      { ...CORPO_VALIDO, titulo: "t".repeat(121) },
      { ...CORPO_VALIDO, corpo: "c".repeat(2_001) },
    ]) {
      const resposta = await POST(pedido(corpo));
      expect(resposta.status).toBe(400);
    }
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("o corpo do push é truncado; o aviso gravado fica inteiro", async () => {
    const longo = "c".repeat(2_000);
    const banco = bancoQueSalva(avisoSalvo({ corpo: longo }));
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido({ ...CORPO_VALIDO, corpo: longo }));

    expect(resposta.status).toBe(201);
    expect(banco.insert).toHaveBeenCalledWith(expect.objectContaining({ corpo: longo }));
    const push = vi.mocked(enviarPushDaOrg).mock.calls[0]![1];
    expect(push.body.length).toBeLessThan(longo.length);
    expect(push.body.endsWith("…")).toBe(true);
  });

  it("recusa aviso sem corpo", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido({ titulo: "Só o título" }));

    expect(resposta.status).toBe(400);
    expect(banco.insert).not.toHaveBeenCalled();
  });
});

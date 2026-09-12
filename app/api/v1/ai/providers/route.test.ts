import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

/**
 * PATCH /api/v1/ai/providers — o padrão da organização ganha superfície.
 *
 * O padrão (`organizations.settings.llm`) decide o modelo de TODO ponto que não
 * tem binding explícito — numa instalação recém-criada, 24 dos 25. Até aqui ele
 * só era escrito de raspão, pela primeira publicação de um agente
 * (`lib/ai/agents/first-publication.ts`), e não tinha tela nenhuma: violava o
 * invariante 6 do Sistema Vivo ("toda configuração tem superfície").
 *
 * O caso que este arquivo existe para vigiar é o segundo: `settings` é um jsonb
 * COMPARTILHADO — `branding`, `security` e o que mais vier moram nele. Escrever
 * `{ llm: ... }` por cima apaga a marca da instalação e a política de MFA em
 * silêncio, e o sintoma aparece dias depois, longe daqui.
 *
 * ═══ E O TERCEIRO CASO, QUE UM TESTE DE UNIDADE NÃO PODE VER SOZINHO ═══
 *
 * A RLS de `organizations` só deixa ESCREVER platform admin. Com o cliente de
 * sessão, o `update` casa ZERO linhas para o `admin` do próprio tenant — e o
 * PostgREST devolve **sucesso**, sem erro: a tela diria "salvo" e nada teria
 * sido gravado. Medido: `admin` da org → 0 linhas; cliente admin → 1.
 *
 * Nenhum mock enxerga isso, porque o stub abaixo sempre dá certo. Por isso o
 * `createClient` e o `createAdminClient` são dublês DIFERENTES aqui, e há um
 * caso que afirma qual dos dois escreveu — trocar de volta reprova, mesmo com
 * o comportamento visível idêntico. A varredura por classe vive em
 * `tests/unit/escrita-em-organizations-usa-cliente-admin.test.ts`.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** O que já vive em `settings` e não pode sumir quando o padrão é gravado. */
const SETTINGS_EXISTENTES = {
  branding: { app_name: "THOTH CRM", accent_hex: "#506d48" },
  security: { mfa_required: false },
  llm: { provider: "anthropic", default_model: "claude-sonnet-5" },
};

interface EstadoDoBanco {
  atualizacao: Record<string, unknown> | null;
  modeloExiste: boolean;
}

function stubDoBanco(estado: EstadoDoBanco) {
  return {
    from(tabela: string) {
      if (tabela === "organizations") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          update(payload: Record<string, unknown>) {
            estado.atualizacao = payload;
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: estado.atualizacao
                ? { settings: estado.atualizacao.settings }
                : { settings: SETTINGS_EXISTENTES },
              error: null,
            });
          },
        };
      }
      if (tabela === "ai_models") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: estado.modeloExiste ? { model_id: "gpt-5.4-mini" } : null,
              error: null,
            });
          },
        };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  };
}

function autorizadoComoAdmin() {
  const user: AuthUser = {
    id: USER_ID,
    email: "dono@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
  } as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
}

function requisicao(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/providers", {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /api/v1/ai/providers — padrão da organização", () => {
  let estado: EstadoDoBanco;
  let estadoDeSessao: EstadoDoBanco;

  beforeEach(() => {
    vi.clearAllMocks();
    estado = { atualizacao: null, modeloExiste: true };
    estadoDeSessao = { atualizacao: null, modeloExiste: true };
    vi.mocked(requireSupportWrite).mockResolvedValue(null);
    vi.mocked(createClient).mockResolvedValue(
      stubDoBanco(estadoDeSessao) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
    // Dublê SEPARADO de propósito: é `estado` (o do admin) que as asserções
    // leem, então uma escrita pelo cliente de sessão aparece como ausência.
    vi.mocked(createAdminClient).mockReturnValue(
      stubDoBanco(estado) as unknown as ReturnType<typeof createAdminClient>,
    );
    autorizadoComoAdmin();
  });

  it("grava o padrão SEM apagar as outras chaves de settings", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(requisicao({ provider: "openai", default_model: "gpt-5.4-mini" }));

    expect(res.status).toBe(200);

    const settings = (estado.atualizacao?.settings ?? {}) as Record<string, unknown>;
    // O que mudou:
    expect(settings.llm).toEqual({ provider: "openai", default_model: "gpt-5.4-mini" });
    // O que NÃO podia ser tocado:
    expect(settings.branding).toEqual(SETTINGS_EXISTENTES.branding);
    expect(settings.security).toEqual(SETTINGS_EXISTENTES.security);
  });

  it("escreve pelo CLIENTE ADMIN, não pelo de sessão", async () => {
    // A RLS de `organizations` só deixa escrever platform admin: pelo cliente
    // de sessão isto casaria zero linhas e o PostgREST devolveria sucesso.
    const { PATCH } = await import("./route");
    await PATCH(requisicao({ provider: "openai", default_model: "gpt-5.4-mini" }));

    expect(estado.atualizacao, "o cliente admin não gravou").not.toBeNull();
    expect(
      estadoDeSessao.atualizacao,
      "o cliente de SESSÃO gravou — com a RLS real isto casaria zero linhas e " +
        "voltaria como sucesso, com a tela dizendo 'salvo'",
    ).toBeNull();
  });

  it("recusa provedor que esta instalação não suporta", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(requisicao({ provider: "foobar", default_model: "qualquer" }));

    expect(res.status).toBe(422);
    expect(estado.atualizacao).toBeNull();
  });

  it("recusa modelo que não está no catálogo do provedor", async () => {
    // `ai_models` é catálogo global e é lido pelo cliente de SESSÃO — só a
    // escrita em `organizations` precisa do admin. Por isso a bandeira vai no
    // dublê de sessão, e não no do admin.
    estadoDeSessao.modeloExiste = false;
    const { PATCH } = await import("./route");
    const res = await PATCH(requisicao({ provider: "openai", default_model: "modelo-que-nao-existe" }));

    expect(res.status).toBe(404);
    expect(estado.atualizacao).toBeNull();
  });

  it("exige papel admin — a troca do padrão muda todo ponto herdado", async () => {
    const { PATCH } = await import("./route");
    await PATCH(requisicao({ provider: "openai", default_model: "gpt-5.4-mini" }));

    expect(vi.mocked(requireRole)).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "ai_providers" }),
    );
  });
});

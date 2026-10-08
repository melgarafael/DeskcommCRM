/**
 * AS ALÍNEAS DO ART. 15.º TÊM ENTRADA (#2356) — rota, tela e o elo com o PDF.
 *
 * ─── O que cada caso fecha ──────────────────────────────────────────────────
 *
 * A issue mediu o problema: o #2354 faz o PDF de acesso de Portugal ler
 * `organizations.settings.art15`, mas NADA no produto gravava essa chave, então
 * toda organização PT imprimia "não informado pelo controlador" e só um
 * `UPDATE` em SQL consertava. Aqui fica a prova das três partes que faltavam:
 *
 * - a ROTA grava `settings.art15` SEM apagar as outras chaves de `settings`,
 *   recusa acima dos limites do próprio `art15SettingsSchema` (2000/2000/500),
 *   não vira gravação quando a leitura falhou, exige `admin`, audita
 *   `org.art15_updated` — e devolve o que `art15DoControlador` lê, que é a
 *   MESMA função com que o relatório monta as alíneas;
 * - a TELA existe só fora do Brasil (o documento brasileiro não tem esta
 *   seção) e oferece exatamente os três campos que a issue pediu, com os
 *   limites do schema — sem campo a mais, sem campo a menos;
 * - o SALVAR da tela manda os três textos para a rota certa.
 *
 * O render do PDF com as alíneas lidas de `settings` já é de
 * `tests/unit/art-15-entregue-no-pdf.test.tsx`; este arquivo cobre o que
 * faltava, o lado da ESCRITA.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import {
  alineasDoArt15Visiveis,
  art15DoControlador,
  NAO_INFORMADO_PELO_CONTROLADOR,
} from "@/lib/legal/art15";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// `useT` real exige o provider de idioma; aqui o que se mede é o TEXTO na tela
// e o payload do PATCH, não a tradução — essa é da cerca de i18n.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
const cli = vi.hoisted(() => ({
  patch: vi.fn(async (_path: string, _body: unknown): Promise<unknown> => undefined),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch: cli.patch } }));

const ORG = "11111111-1111-4111-8111-111111111111";
const estado: { settings: Record<string, unknown>; erroDeLeitura: boolean; updates: unknown[] } = {
  settings: {},
  erroDeLeitura: false,
  updates: [],
};

// O mesmo cliente-admin dublê de `assinatura-rota.test.ts`: `select().eq()`
// para a leitura e `update().eq()` para a escrita, com o estado em `estado`.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            estado.erroDeLeitura
              ? { data: null, error: { message: "falhou" } }
              : { data: { settings: estado.settings }, error: null },
        }),
      }),
      update: (patch: { settings: Record<string, unknown> }) => ({
        eq: async () => {
          estado.updates.push(patch);
          estado.settings = patch.settings;
          return { error: null };
        },
      }),
    }),
  }),
}));

const { PATCH } = await import("@/app/api/v1/settings/art15/route");
const { Art15Form } = await import("@/app/app/settings/tenant/_art15");

function sessao(role: Role) {
  const user: AuthUser = {
    id: "22222222-2222-4222-8222-222222222222",
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[role] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

const patch = (corpo: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/v1/settings/art15", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );

const CHEIO = {
  finalidades: "Atendimento ao cliente, gestão de pedidos e faturação.",
  destinatarios: "Prestadores de alojamento e de e-mail, dentro da UE.",
  prazo_conservacao: "5 anos depois do último contato.",
};

beforeEach(() => {
  estado.settings = { routing: { mode: "round_robin" }, campanhas: { x: 1 } };
  estado.erroDeLeitura = false;
  estado.updates = [];
  vi.mocked(audit).mockClear();
  cli.patch.mockClear();
});

describe("/api/v1/settings/art15 — a entrada que faltava", () => {
  it("grava settings.art15 SEM apagar as outras chaves, e audita org.art15_updated", async () => {
    sessao("admin");
    const res = await patch(CHEIO);
    expect(res.status).toBe(200);
    expect(estado.settings).toEqual({
      routing: { mode: "round_robin" },
      campanhas: { x: 1 },
      art15: CHEIO,
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.art15_updated", organizationId: ORG }),
    );
    // O que a tela devolve é o que o relatório lê: a MESMA função do PDF.
    expect(art15DoControlador(estado.settings)).toEqual(CHEIO);
    expect(NAO_INFORMADO_PELO_CONTROLADOR).toBe("não informado pelo controlador");
  });

  it("o campo em branco vira null — o documento segue dizendo que não foi informado", async () => {
    sessao("admin");
    expect(
      (
        await patch({
          finalidades: "  ",
          destinatarios: "",
          prazo_conservacao: null,
        })
      ).status,
    ).toBe(200);
    expect(estado.settings.art15).toEqual({
      finalidades: null,
      destinatarios: null,
      prazo_conservacao: null,
    });
    const lido = art15DoControlador(estado.settings);
    expect(lido.finalidades).toBeNull();
    expect(lido.destinatarios).toBeNull();
    expect(lido.prazo_conservacao).toBeNull();
  });

  it.each([
    ["finalidades acima de 2000", { finalidades: "x".repeat(2001) }],
    ["destinatários acima de 2000", { destinatarios: "x".repeat(2001) }],
    ["prazo acima de 500", { prazo_conservacao: "x".repeat(501) }],
    ["nada no corpo", null],
    ["tipo errado", { finalidades: 42 }],
  ])("%s: 422 do próprio schema e nada gravado", async (_rotulo, corpo) => {
    sessao("admin");
    expect((await patch(corpo)).status).toBe(422);
    expect(estado.updates).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("leitura que falhou NÃO vira gravação (regravaria o settings só com esta chave)", async () => {
    sessao("admin");
    estado.erroDeLeitura = true;
    expect((await patch(CHEIO)).status).toBe(500);
    expect(estado.updates).toHaveLength(0);
  });

  it("manager não declara alíneas perante a autoridade de supervisão (403)", async () => {
    sessao("manager");
    expect((await patch(CHEIO)).status).toBe(403);
    expect(estado.updates).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("o cartão de Configurações › Empresa", () => {
  it("existe fora do Brasil e não existe no Brasil (LGPD não tem esta seção)", () => {
    expect(alineasDoArt15Visiveis("PT")).toBe(true);
    expect(alineasDoArt15Visiveis("ES")).toBe(true);
    expect(alineasDoArt15Visiveis("BR")).toBe(false);
    // `null` de país É Brasil (migration 0277) — a mesma convenção do seletor.
    expect(alineasDoArt15Visiveis(null)).toBe(false);
  });

  it("renderiza exatamente as três alíneas da issue, com os limites do schema", () => {
    render(
      <Art15Form initial={{ finalidades: "", destinatarios: "", prazo_conservacao: "" }} />,
    );
    const campos = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(campos, "a tela precisa ter exatamente os três campos pedidos").toHaveLength(3);
    expect(campos.map((c) => c.maxLength)).toEqual([2000, 2000, 500]);
    expect(campos.map((c) => c.id)).toEqual([
      "art15-finalidades",
      "art15-destinatarios",
      "art15-prazo_conservacao",
    ]);
    const rotulos = [...document.querySelectorAll("label")].map((l) => l.textContent ?? "");
    for (const letra of ["alínea a)", "alínea c)", "alínea d)"]) {
      expect(rotulos.join(" ")).toContain(letra);
    }
    // O que a tela avisa é o que o PDF faz com o vazio.
    expect(screen.getByText(/não informado pelo controlador/)).toBeTruthy();
  });

  it("salvar manda os três textos para /api/v1/settings/art15", async () => {
    render(
      <Art15Form
        initial={{ finalidades: "A", destinatarios: "C", prazo_conservacao: "D" }}
      />,
    );
    fireEvent.change(screen.getByTestId("art15-finalidades"), {
      target: { value: "Fins novos" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alíneas" }));
    await waitFor(() => expect(cli.patch).toHaveBeenCalledTimes(1));
    expect(cli.patch).toHaveBeenCalledWith("/api/v1/settings/art15", {
      finalidades: "Fins novos",
      destinatarios: "C",
      prazo_conservacao: "D",
    });
  });
});

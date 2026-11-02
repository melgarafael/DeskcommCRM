/**
 * Doc 213 (A): setores de atendimento são módulo opcional da instalação,
 * desligado por padrão. Desligado, toda rota de setor responde 404 — antes de
 * autorizar e antes de tocar no banco — e a tela da Equipe não mostra a aba.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import * as setores from "@/app/api/v1/attendants/sectors/route";
import * as setor from "@/app/api/v1/attendants/sectors/[id]/route";
import * as vinculo from "@/app/api/v1/attendants/sector/[user_id]/route";

const ID = "44444444-4444-4444-8444-444444444444";
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/v1/attendants/sectors", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("módulo setores desligado: as rotas não existem", () => {
  const casos: Array<[string, () => Promise<Response>]> = [
    ["GET /sectors", () => setores.GET(req("GET"))],
    ["POST /sectors", () => setores.POST(req("POST", { name: "Suporte" }))],
    ["PATCH /sectors/[id]", () => setor.PATCH(req("PATCH", { name: "X" }), { params: Promise.resolve({ id: ID }) })],
    ["DELETE /sectors/[id]", () => setor.DELETE(req("DELETE"), { params: Promise.resolve({ id: ID }) })],
    ["PUT /sector/[user_id]", () => vinculo.PUT(req("PUT", { sector_id: ID }), { params: Promise.resolve({ user_id: ID }) })],
  ];

  for (const [nome, chamar] of casos) {
    it(`${nome} → 404, sem autorizar nem ler o banco`, async () => {
      const res = await chamar();
      expect(res.status).toBe(404);
      expect(moduloLigado).toHaveBeenCalledWith(expect.anything(), "setores");
      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    });
  }
});

describe("módulo setores desligado: a Equipe não mostra a aba", () => {
  // A página é componente de servidor com sessão; o contrato que importa é
  // que a aba, o endereço `?aba=setores` e a coluna dependem da MESMA leitura.
  const pagina = readFileSync("app/app/team/page.tsx", "utf8");

  it("a página lê o módulo e só desenha a aba quando ligado", () => {
    expect(pagina).toContain('moduloLigado(createAdminClient(), "setores")');
    expect(pagina).toMatch(/setoresLigado \? \(\s*<TabsTrigger value="sectors">/);
    expect(pagina).toMatch(/setoresLigado \? \(\s*<TabsContent value="sectors"/);
  });

  it("a aba Atendimento recebe a mesma chave", () => {
    expect(pagina).toContain("setoresLigado={setoresLigado}");
  });
});

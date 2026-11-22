import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
import { lerContaDeRelatorio, listarContasDeRelatorio } from "./contas-de-relatorio";

const { decifrar } = vi.hoisted(() => ({ decifrar: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: decifrar }));

const id = "1234567890";
const outroId = "9999999999";

function tabela(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    data, error: null,
  };
}

function banco(proprias: ReturnType<typeof tabela>, legado: ReturnType<typeof tabela>) {
  const from = vi.fn((nome: string) => {
    if (nome === "google_ads_reporting_accounts") return proprias;
    if (nome === "ad_platform_connections") return legado;
    throw new Error("Tabela inesperada");
  });
  return { admin: { from } as unknown as SupabaseClient, from };
}

beforeEach(() => vi.resetAllMocks());

it("lista metadados de ambas as fontes na organização ativa e deduplica o anunciante", async () => {
  const alias = { customer_id: id, label: "Conta B", login_customer_id: null };
  const proprias = tabela([alias]);
  const legado = tabela({ google_customer_id: "123-456-7890", google_login_customer_id: null });
  const { admin } = banco(proprias, legado);
  const resultado = await listarContasDeRelatorio(admin, "empresa");
  expect(resultado).toEqual({ ok: true, contas: [{ customerId: id, label: "Conta B", loginCustomerId: null, propria: true }] });
  expect(proprias.select).toHaveBeenCalledWith("customer_id,label,login_customer_id");
  expect(proprias.eq).toHaveBeenCalledWith("organization_id", "empresa");
  expect(legado.eq).toHaveBeenCalledWith("organization_id", "empresa");
  expect(decifrar).not.toHaveBeenCalled();
  legado.maybeSingle.mockResolvedValueOnce({ data: { google_customer_id: outroId }, error: null });
  expect(await listarContasDeRelatorio(admin, "empresa")).toMatchObject({ contas: [{ customerId: outroId, propria: false }, { customerId: id, propria: true }] });
});

it("usa a credencial dedicada apenas para o anunciante e organização escolhidos", async () => {
  const proprias = tabela({ customer_id: id, login_customer_id: outroId, refresh_token_encrypted: "cifrado" });
  const { admin, from } = banco(proprias, tabela(null));
  decifrar.mockResolvedValue("aberto");
  expect(await lerContaDeRelatorio(admin, "empresa", id)).toEqual({
    ok: true, dados: { customerId: id, loginCustomerId: outroId, refreshToken: "aberto" },
  });
  expect(proprias.eq.mock.calls).toEqual([["organization_id", "empresa"], ["customer_id", id]]);
  expect(from.mock.calls).toEqual([["google_ads_reporting_accounts"]]);
});

it("restringe também o fallback à conta solicitada e preserva falhas na leitura dedicada", async () => {
  const proprias = tabela(null);
  const legado = tabela({ google_customer_id: "123-456-7890", google_refresh_token_encrypted: "cifrado", google_login_customer_id: null });
  const { admin, from } = banco(proprias, legado);
  expect(await lerContaDeRelatorio(admin, "empresa", outroId)).toMatchObject({ ok: false, falha: "sem_conexao" });
  expect(legado.eq).toHaveBeenCalledWith("organization_id", "empresa");
  expect(decifrar).not.toHaveBeenCalled();
  decifrar.mockResolvedValueOnce("aberto");
  expect(await lerContaDeRelatorio(admin, "empresa", id)).toMatchObject({ ok: true, dados: { customerId: id, refreshToken: "aberto" } });
  from.mockClear();
  proprias.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "indisponível" } });
  expect(await lerContaDeRelatorio(admin, "empresa", outroId)).toMatchObject({ ok: false, falha: "transitorio" });
  expect(from.mock.calls).toEqual([["google_ads_reporting_accounts"]]);
  expect(decifrar).toHaveBeenCalledTimes(1);
});

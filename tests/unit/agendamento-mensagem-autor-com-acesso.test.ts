import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { autorAindaTemAcesso, type AgendamentoParaEnvio } from "@/lib/agendamento-mensagem/envio";

/**
 * Na hora do envio, quem agendou ainda é da equipe? (#3118, doc 314, pendência 3)
 *
 * O dublê responde como `user_organizations` responderia: a linha do vínculo
 * ATIVO (`revoked_at` nulo) ou nada. E registra os filtros pedidos, para o teste
 * provar que a consulta pede o vínculo ativo DESTA organização e DESTA pessoa.
 */
function adminCom(vinculo: { role: string } | null, erro: { message: string } | null = null) {
  const filtros: string[] = [];
  const consulta = {
    select: () => consulta,
    eq: (c: string, v: string) => (filtros.push(`${c}=${v}`), consulta),
    is: (c: string, v: null) => (filtros.push(`${c} is ${String(v)}`), consulta),
    maybeSingle: async () => ({ data: vinculo, error: erro }),
  };
  const admin = { from: (t: string) => (filtros.push(`from ${t}`), consulta) };
  return { admin: admin as unknown as SupabaseClient, filtros };
}

const AG: AgendamentoParaEnvio = {
  id: "a",
  organization_id: "org-1",
  contact_id: "c",
  channel_session_id: "s",
  created_by_user_id: "u-1",
  body: "oi",
};

describe("autorAindaTemAcesso", () => {
  it("pede o vínculo ATIVO desta pessoa nesta organização", async () => {
    const { admin, filtros } = adminCom({ role: "agent" });
    await autorAindaTemAcesso(admin, AG);
    expect(filtros).toEqual(["from user_organizations", "organization_id=org-1", "user_id=u-1", "revoked_at is null"]);
  });

  it("atendente, gestor e admin seguem enviando", async () => {
    for (const role of ["agent", "manager", "admin"]) {
      expect(await autorAindaTemAcesso(adminCom({ role }).admin, AG)).toBe(true);
    }
  });

  it("sem vínculo ativo (saiu da empresa) ou só leitura, não envia", async () => {
    expect(await autorAindaTemAcesso(adminCom(null).admin, AG)).toBe(false);
    expect(await autorAindaTemAcesso(adminCom({ role: "viewer" }).admin, AG)).toBe(false);
  });

  it("conta apagada (created_by nulo) não envia", async () => {
    expect(await autorAindaTemAcesso(adminCom({ role: "admin" }).admin, { ...AG, created_by_user_id: null })).toBe(false);
  });

  it("leitura que falhou não vira 'tem acesso' — lança e a rodada tenta de novo", async () => {
    await expect(autorAindaTemAcesso(adminCom(null, { message: "boom" }).admin, AG)).rejects.toThrow("leitura_do_vinculo_falhou");
  });
});

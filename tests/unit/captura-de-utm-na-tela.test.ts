import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ENDEREÇO DE CAPTURA SÓ MUDA COM ADMIN, MFA E `{token}` NO TEXTO.
 *
 * ─── Por que cada guarda está aqui ──────────────────────────────────────────
 *
 * A linha que esta action grava decide PARA QUAL NÚMERO o tráfego pago da
 * organização é despejado. Trocá-la sem querer — ou por quem não devia — manda
 * os leads de quem anuncia para o WhatsApp de outra pessoa, e nada quebra: a
 * página continua respondendo, o anúncio continua rodando, e o dono descobre
 * pelo telefone que parou de tocar. Por isso o mesmo par admin+MFA das outras
 * conexões desta tela.
 *
 * O `{token}` no texto é a outra guarda, e ela não é estética: sem ele a
 * mensagem chega sem ref, a conversa entra sem origem, e a tela teria dito
 * "salvo". O `check` da migration 0381 cobra a mesma coisa no banco — aqui a
 * recusa acontece ANTES de qualquer escrita, com motivo que a tela sabe
 * mostrar.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

let papel = "admin";
let mfaDevendo = false;
let usuarioLogado = true;
const upserts: Array<{ tabela: string; valores: Record<string, unknown>; opcoes: unknown }> = [];
const auditorias: Array<Record<string, unknown>> = [];

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => (usuarioLogado ? { id: USUARIO, is_platform_admin: false } : null),
  resolveActiveOrg: async () => ({ orgId: ORG, role: papel, name: "Acme" }),
  mfaEmDivida: async () => mfaDevendo,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => false }));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    auditorias.push(entrada);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      upsert: async (valores: Record<string, unknown>, opcoes: unknown) => {
        upserts.push({ tabela, valores, opcoes });
        return { error: null };
      },
    }),
  }),
}));

import { updateCapturaDeUtm } from "@/app/actions/settings/updateCapturaDeUtm";

const ENTRADA = {
  whatsapp_e164: "+5511999999999",
  message_template: "Olá! Vim pelo site. [ref:{token}]",
  enabled: true,
};

beforeEach(() => {
  papel = "admin";
  mfaDevendo = false;
  usuarioLogado = true;
  upserts.length = 0;
  auditorias.length = 0;
});

describe("updateCapturaDeUtm", () => {
  it("grava a configuração e registra quem mudou o número", async () => {
    const resultado = await updateCapturaDeUtm(ENTRADA);

    expect(resultado).toEqual({ ok: true });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.tabela).toBe("meta_ads_landing_pages");
    expect(upserts[0]?.valores.organization_id).toBe(ORG);
    expect(upserts[0]?.valores.whatsapp_e164).toBe("+5511999999999");
    // `upsert` por organização: esta configuração NASCE nesta tela, não existe
    // um passo anterior que crie a linha.
    expect(upserts[0]?.opcoes).toEqual({ onConflict: "organization_id" });
    expect(auditorias[0]?.action).toBe("captura_de_utm.updated");
  });

  it("texto sem o campo do código é recusado ANTES de escrever", async () => {
    const resultado = await updateCapturaDeUtm({
      ...ENTRADA,
      message_template: "Olá! Vim pelo site.",
    });

    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.error).toBe("validation_failed");
    expect(upserts).toHaveLength(0);
  });

  it("número fora do formato internacional é recusado", async () => {
    const resultado = await updateCapturaDeUtm({ ...ENTRADA, whatsapp_e164: "11 9999-9999" });

    expect(resultado.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("celular brasileiro sem código do país é recusado, não vira número dos EUA", async () => {
    // O caso acima cobre o formato de DEZ dígitos, extinto no celular desde o
    // nono dígito. O formato em vigor tem ONZE (DDD 2 + 9), e com o piso do
    // `+` automático em 11 ele passava: `11999999999` virava `+11999999999`,
    // casava com a regex e era GRAVADO — um número dos Estados Unidos que
    // existe. O tráfego pago da organização passaria a tocar o telefone de
    // outra pessoa sem nada quebrar, que é exatamente o desastre que a guarda
    // foi escrita para impedir.
    const resultado = await updateCapturaDeUtm({ ...ENTRADA, whatsapp_e164: "11 99999-9999" });

    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.error).toBe("validation_failed");
    expect(upserts).toHaveLength(0);
  });

  it("o `+` automático só começa em doze dígitos", async () => {
    // A outra borda do mesmo conserto, para o piso não subir de novo por
    // engano: nenhum número brasileiro LOCAL chega a doze dígitos, então daqui
    // para cima o digitado só pode estar carregando código de país (55 + fixo
    // de dez, aqui).
    const resultado = await updateCapturaDeUtm({ ...ENTRADA, whatsapp_e164: "551199999999" });

    expect(resultado).toEqual({ ok: true });
    expect(upserts[0]?.valores.whatsapp_e164).toBe("+551199999999");
  });

  it("número digitado sem o `+` é normalizado, não recusado", async () => {
    // Quem copia do WhatsApp cola sem o `+`; recusar isso seria atrito puro,
    // e a coluna tem formato único (E.164 com `+`, igual a contacts.phone_number).
    const resultado = await updateCapturaDeUtm({ ...ENTRADA, whatsapp_e164: "5511988887777" });

    expect(resultado).toEqual({ ok: true });
    expect(upserts[0]?.valores.whatsapp_e164).toBe("+5511988887777");
  });

  it("abaixo de admin não muda o endereço", async () => {
    papel = "manager";

    const resultado = await updateCapturaDeUtm(ENTRADA);

    expect(resultado.ok === false && resultado.error).toBe("forbidden_role");
    expect(upserts).toHaveLength(0);
  });

  it("MFA em dívida não muda o endereço", async () => {
    mfaDevendo = true;

    const resultado = await updateCapturaDeUtm(ENTRADA);

    expect(resultado.ok === false && resultado.error).toBe("mfa_required");
    expect(upserts).toHaveLength(0);
  });

  it("sem sessão, nem chega ao banco", async () => {
    usuarioLogado = false;

    const resultado = await updateCapturaDeUtm(ENTRADA);

    expect(resultado.ok === false && resultado.error).toBe("unauthenticated");
    expect(upserts).toHaveLength(0);
  });
});

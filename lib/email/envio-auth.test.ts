import { describe, expect, it, vi } from "vitest";
import { signInviteToken } from "@/lib/auth/invite-token";
import { ACOES_EMAIL_AUTH, payloadEmailAuthSchema, prepararEmailsAuth } from "./envio-auth";
import type { MarcaDeSaida } from "@/lib/branding/saida";

const org = "00000000-0000-4000-8000-000000000001";
const marcaBase: MarcaDeSaida = {
  nome: "Instalação",
  logoUrl: null,
  accent: "#ab5498",
  accentFg: "#fff",
  origens: { nome: "instalacao", cor: "instalacao" },
};
const base = {
  user: { id: "00000000-0000-4000-8000-000000000002", email: "convidado@example.test" },
  email_data: {
    email_action_type: "signup",
    token: "123456",
    token_hash: "hash-sintetico",
    redirect_to:
      "https://app.example.test/auth/confirm?type=signup&next=%2Fteam%2Faccept-invite%2Fsintetico",
    site_url: "https://auth.example.test",
    old_email: "anterior@example.test",
  },
};
const contexto = () => ({
  appUrl: "https://app.example.test",
  supabaseUrl: "https://auth.example.test",
  marca: vi.fn(async (id: string | null) => ({
    ...marcaBase,
    nome: id ? "Organização A" : "Instalação",
  })),
});
const convite = (email = base.user.email, exp = Math.floor(Date.now() / 1000) + 600) =>
  signInviteToken({
    invite_id: "00000000-0000-4000-8000-000000000003",
    organization_id: org,
    email,
    role: "manager",
    exp,
  });
describe("envio Auth com contexto de marca", () => {
  it("confirmação por convite usa somente organização assinada e conserva destino", async () => {
    const ctx = contexto();
    const p = payloadEmailAuthSchema.parse({
      ...base,
      user: { ...base.user, user_metadata: { invite_token: convite() } },
    });
    const [email] = await prepararEmailsAuth(p, ctx);
    expect(ctx.marca).toHaveBeenCalledWith(org);
    expect(email?.subject).toContain("Organização A");
    expect(email?.html).not.toContain("{{");
    const link = new URL(email!.text.split("\n")[1]!);
    expect(link.searchParams.get("next")).toBe("/team/accept-invite/sintetico");
    expect(link.searchParams.get("token_hash")).toBe("hash-sintetico");
    expect(link.pathname).toBe("/auth/confirm");
  });
  it.each(["sem_convite", "outra_pessoa", "expirado", "adulterado"])(
    "%s não escolhe organização editável",
    async (caso) => {
      const token =
        caso === "outra_pessoa"
          ? convite("outra@example.test")
          : caso === "expirado"
            ? convite(base.user.email, 1)
            : caso === "adulterado"
              ? convite() + "x"
              : undefined;
      const ctx = contexto();
      await prepararEmailsAuth(
        payloadEmailAuthSchema.parse({
          ...base,
          user: { ...base.user, user_metadata: { organization_id: org, invite_token: token } },
        }),
        ctx,
      );
      expect(ctx.marca).toHaveBeenCalledWith(null);
    },
  );
  it("recuperação usa instalação mesmo com convite antigo na conta", async () => {
    const ctx = contexto();
    const [email] = await prepararEmailsAuth(
      payloadEmailAuthSchema.parse({
        ...base,
        user: { ...base.user, user_metadata: { invite_token: convite() } },
        email_data: { ...base.email_data, email_action_type: "recovery", redirect_to: "" },
      }),
      ctx,
    );
    expect(ctx.marca).toHaveBeenCalledWith(null);
    expect(email?.text).toContain("type=recovery");
  });
  it("troca segura envia hashes corretos para atual e novo", async () => {
    const emails = await prepararEmailsAuth(
      payloadEmailAuthSchema.parse({
        ...base,
        user: { ...base.user, new_email: "novo@example.test" },
        email_data: {
          ...base.email_data,
          email_action_type: "email_change",
          token_hash_new: "hash-atual",
          token_new: "654321",
        },
      }),
      contexto(),
    );
    expect(emails.map((e) => e.to)).toEqual(["convidado@example.test", "novo@example.test"]);
    expect(emails[0]?.text).toContain("token=hash-atual");
    expect(emails[1]?.text).toContain("token=hash-sintetico");
  });
  it("troca não segura envia uma vez para novo endereço", async () => {
    const emails = await prepararEmailsAuth(
      payloadEmailAuthSchema.parse({
        ...base,
        user: { ...base.user, new_email: "novo@example.test" },
        email_data: { ...base.email_data, email_action_type: "email_change" },
      }),
      contexto(),
    );
    expect(emails).toHaveLength(1);
    expect(emails[0]?.to).toBe("novo@example.test");
  });
  it("aviso de e-mail alterado vai ao endereço anterior", async () => {
    const [email] = await prepararEmailsAuth(
      payloadEmailAuthSchema.parse({
        ...base,
        email_data: { ...base.email_data, email_action_type: "email_changed_notification" },
      }),
      contexto(),
    );
    expect(email?.to).toBe("anterior@example.test");
  });
  it.each(ACOES_EMAIL_AUTH)("cobre %s sem placeholders no envio", async (acao) => {
    const ctx = contexto();
    const emails = await prepararEmailsAuth(
      payloadEmailAuthSchema.parse({
        ...base,
        user: { ...base.user, new_email: "novo@example.test" },
        email_data: { ...base.email_data, email_action_type: acao },
      }),
      ctx,
    );
    expect(emails[0]?.html).not.toContain("{{");
    expect(emails[0]?.html).toContain('role="presentation"');
  });
  it("relê a marca a cada envio", async () => {
    const ctx = contexto();
    const p = payloadEmailAuthSchema.parse(base);
    const primeiro = await prepararEmailsAuth(p, ctx);
    ctx.marca.mockResolvedValue({ ...marcaBase, nome: "Marca nova", accent: "#112233" });
    const segundo = await prepararEmailsAuth(p, ctx);
    expect(primeiro[0]?.subject).toContain("Instalação");
    expect(segundo[0]?.subject).toContain("Marca nova");
    expect(segundo[0]?.html).toContain("#112233");
  });
  it.each(["https://terceiro.example.test/auth/confirm", "https://app.example.test/login"])(
    "recusa retorno inválido %s",
    async (redirect_to) => {
      await expect(
        prepararEmailsAuth(
          payloadEmailAuthSchema.parse({
            ...base,
            email_data: { ...base.email_data, redirect_to },
          }),
          contexto(),
        ),
      ).rejects.toThrow("retorno_divergente");
    },
  );
});

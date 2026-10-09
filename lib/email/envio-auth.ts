import { z } from "zod";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import { configuracaoDeEmailsAuth } from "@/lib/email/templates/configuracao-auth";

export const ACOES_EMAIL_AUTH = [
  "signup",
  "recovery",
  "invite",
  "magiclink",
  "email_change",
  "reauthentication",
  "password_changed_notification",
  "email_changed_notification",
  "phone_changed_notification",
  "identity_linked_notification",
  "identity_unlinked_notification",
  "mfa_factor_enrolled_notification",
  "mfa_factor_unenrolled_notification",
] as const;
const texto = z.string().max(8192).optional().default("");
export const payloadEmailAuthSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    new_email: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .default(""),
    user_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  email_data: z.object({
    email_action_type: z.enum(ACOES_EMAIL_AUTH),
    token: texto,
    token_hash: texto,
    token_new: texto,
    token_hash_new: texto,
    redirect_to: texto,
    site_url: z.string().url(),
    old_email: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .default(""),
  }),
});
export type PayloadEmailAuth = z.infer<typeof payloadEmailAuthSchema>;
export interface EmailAuthPreparado {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  organizationId: string | null;
}

/** Somente signup por convite HMAC válido identifica organização. Vínculo antigo e
 * user_metadata.organization_id NÃO identificam quem originou a mensagem atual.
 */
export async function prepararEmailsAuth(
  payload: PayloadEmailAuth,
  contexto: {
    appUrl: string;
    supabaseUrl: string;
    marca: (org: string | null) => Promise<MarcaDeSaida>;
  },
): Promise<EmailAuthPreparado[]> {
  const { user, email_data: dados } = payload;
  const app = new URL(contexto.appUrl);
  // GoTrue fornece sua URL externa como site_url; algumas instalações fornecem
  // o Site URL configurado. Só aceitamos as duas origens desta instalação.
  if (
    ![app.origin, new URL(contexto.supabaseUrl).origin].includes(new URL(dados.site_url).origin)
  ) {
    throw new Error("site_divergente");
  }
  let organizationId: string | null = null;
  if (dados.email_action_type === "signup") {
    const convite = decidirConviteDoSignup(user);
    if (convite.tipo === "convite") organizationId = convite.payload.organization_id;
    // Convite inválido não muda a marca; o aceite continua falhando fechado.
  }
  const marca = await contexto.marca(organizationId);
  const modelo =
    dados.email_action_type === "signup"
      ? "confirmation"
      : dados.email_action_type === "magiclink"
        ? "magic_link"
        : dados.email_action_type;
  const destinos =
    dados.email_action_type === "email_change"
      ? dados.token_hash_new
        ? [
            { to: user.email, hash: dados.token_hash_new, token: dados.token },
            { to: user.new_email, hash: dados.token_hash, token: dados.token_new },
          ]
        : [{ to: user.new_email, hash: dados.token_hash, token: dados.token_new || dados.token }]
      : [
          {
            to:
              dados.email_action_type === "email_changed_notification"
                ? dados.old_email
                : user.email,
            hash: dados.token_hash,
            token: dados.token,
          },
        ];
  return destinos.map(({ to, hash, token }) => {
    if (!to) throw new Error("destinatario_ausente");
    let url = contexto.appUrl;
    if (["signup", "recovery"].includes(dados.email_action_type)) {
      if (!hash) throw new Error("hash_ausente");
      const destino = dados.redirect_to
        ? new URL(dados.redirect_to)
        : new URL("/auth/confirm", app);
      if (destino.origin !== app.origin || destino.pathname !== "/auth/confirm")
        throw new Error("retorno_divergente");
      destino.searchParams.set("type", dados.email_action_type);
      destino.searchParams.set("token_hash", hash);
      url = destino.toString();
    } else if (["invite", "magiclink", "email_change"].includes(dados.email_action_type)) {
      if (!hash) throw new Error("hash_ausente");
      const destino = new URL("/auth/v1/verify", contexto.supabaseUrl);
      destino.searchParams.set("token", hash);
      destino.searchParams.set("type", dados.email_action_type);
      destino.searchParams.set("redirect_to", dados.redirect_to || contexto.appUrl);
      url = destino.toString();
    } else if (dados.email_action_type === "reauthentication" && !token)
      throw new Error("codigo_ausente");
    const config = configuracaoDeEmailsAuth(marca, { url, token });
    const subject = config[`mailer_subjects_${modelo}`];
    const html = config[`mailer_templates_${modelo}_content`];
    if (!subject || !html) throw new Error("modelo_ausente");
    return {
      to,
      subject,
      html,
      text: `${subject}\n${dados.email_action_type === "reauthentication" ? token : url}`,
      fromName: marca.nome,
      organizationId,
    };
  });
}

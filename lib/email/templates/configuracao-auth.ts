import type { MarcaDeSaida } from "@/lib/branding/saida";
import { assuntoDoModelo, MODELOS_DE_ACESSO, montarTemplateDeAcesso } from "./acesso-gotrue";
import { escaparHtml, estruturaDeEmail } from "./estrutura";

/** Apenas apresentação: não habilita notificações nem altera SMTP, URLs ou política Auth. */
export function configuracaoDeEmailsAuth(
  marca: MarcaDeSaida,
  valores?: { url: string; token: string },
): Record<string, string> {
  const config: Record<string, string> = {};
  for (const modelo of MODELOS_DE_ACESSO) {
    config[`mailer_subjects_${modelo}`] = assuntoDoModelo(modelo, marca);
    config[`mailer_templates_${modelo}_content`] = montarTemplateDeAcesso(
      modelo,
      marca,
      valores?.url,
    );
  }
  const outros = {
    invite: ["Você recebeu um convite", "Use o link abaixo para acessar sua conta.", "link"],
    magic_link: ["Seu acesso", "Use o link abaixo para entrar na sua conta.", "link"],
    email_change: [
      "Confirme a alteração de e-mail",
      "Use o link abaixo para confirmar a alteração solicitada.",
      "link",
    ],
    reauthentication: ["Confirme sua identidade", "Seu código de verificação:", "codigo"],
    password_changed_notification: [
      "Sua senha foi alterada",
      "A senha da sua conta foi alterada.",
      "aviso",
    ],
    email_changed_notification: [
      "Seu e-mail foi alterado",
      "O endereço de e-mail da sua conta foi alterado.",
      "aviso",
    ],
    phone_changed_notification: [
      "Seu telefone foi alterado",
      "O telefone da sua conta foi alterado.",
      "aviso",
    ],
    identity_linked_notification: [
      "Método de acesso adicionado",
      "Um método de acesso foi associado à sua conta.",
      "aviso",
    ],
    identity_unlinked_notification: [
      "Método de acesso removido",
      "Um método de acesso foi removido da sua conta.",
      "aviso",
    ],
    mfa_factor_enrolled_notification: [
      "Verificação adicionada",
      "Um método de verificação foi adicionado à sua conta.",
      "aviso",
    ],
    mfa_factor_unenrolled_notification: [
      "Verificação removida",
      "Um método de verificação foi removido da sua conta.",
      "aviso",
    ],
  } as const;
  for (const [modelo, [titulo, corpo, tipo]] of Object.entries(outros)) {
    config[`mailer_subjects_${modelo}`] = `${titulo} · ${marca.nome}`;
    const acao =
      tipo === "codigo"
        ? `<p style="font-size:24px;font-weight:bold">${valores ? escaparHtml(valores.token) : "{{ .Token }}"}</p>`
        : tipo === "link"
          ? `<p><a href="${valores ? escaparHtml(valores.url) : "{{ .ConfirmationURL }}"}" style="display:inline-block;padding:12px 24px;background:${marca.accent};color:${marca.accentFg};text-decoration:none">Continuar</a></p>`
          : "";
    config[`mailer_templates_${modelo}_content`] = estruturaDeEmail(
      marca,
      `<h1 style="font-size:22px">${escaparHtml(titulo)}</h1><p>${escaparHtml(corpo)}</p>${acao}<p>Se você não reconhece esta ação, acesse o sistema pelo endereço habitual e procure quem administra sua conta.</p>`,
    );
  }
  return config;
}

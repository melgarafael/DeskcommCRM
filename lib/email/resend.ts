/**
 * Caminho legado mantido para os invariantes que enumeram os módulos de e-mail.
 * Não integra com Resend: todo envio usa o transporte SMTP canônico.
 */
export { checkSmtpConfiguration, sendEmail } from "@/lib/email/smtp";

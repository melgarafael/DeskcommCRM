/**
 * O aviso ao endereço ANTIGO de que o e-mail de login da conta foi trocado pelo
 * administrador da plataforma (`PATCH /api/v1/admin/tenants/[id]/members/[userId]/email`).
 *
 * É a guarda de quem perde o acesso: a troca é feita por outra pessoa, com
 * `email_confirm: true`, e a dona da caixa antiga é a única que pode dizer "não
 * fui eu". Por isso o texto diz QUANDO e a quem recorrer — e NÃO diz o endereço
 * novo: se a troca for indevida, este e-mail não pode entregar ao destinatário
 * errado o caminho para a conta.
 *
 * Mesmo molde de `invite.ts`: a marca entra resolvida (`marcaDaSaida`, nunca o
 * nome do produto escrito aqui), estilo inline, zero asset externo. O idioma é
 * o de quem recebe (`user_metadata.locale`), pelo dicionário da interface.
 */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export interface AvisoDeTrocaDeEmailOpcoes {
  marca: MarcaDeSaida;
  /** A data da troca, já formatada no fuso da organização. */
  data: string;
  idioma: Idioma;
}

export function buildAvisoDeTrocaDeEmail(opts: AvisoDeTrocaDeEmailOpcoes): {
  subject: string;
  html: string;
  text: string;
} {
  const t = (texto: string) => traduzir(texto, opts.idioma);
  const subject = t("O e-mail de login da sua conta foi trocado");
  const quando = t("O e-mail de login da sua conta foi trocado pelo administrador da plataforma em {data}.")
    .replace("{data}", opts.data);
  const oQueFazer = t("Se você não reconhece a mudança, fale com o administrador da sua empresa.");
  const deAgoraEmDiante = t("Este endereço deixa de receber os e-mails de acesso desta conta.");

  const logo = opts.marca.logoUrl
    ? `<p style="margin:0 0 24px"><img src="${escapeHtml(opts.marca.logoUrl)}" alt="${escapeHtml(opts.marca.nome)}" height="40" style="height:40px;width:auto;max-width:200px;border:0;display:block"></p>`
    : "";

  const html = `<!doctype html>
<html lang="${opts.idioma}">
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${NEUTROS_DE_SAIDA.texto}">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    ${logo}
    <h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      ${escapeHtml(subject)}
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escapeHtml(quando)}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5"><strong>${escapeHtml(oQueFazer)}</strong></p>
    <p style="margin:24px 0 0;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">${escapeHtml(deAgoraEmDiante)}</p>
  </div>
</body>
</html>`;

  const text = [quando, "", oQueFazer, "", deAgoraEmDiante].join("\n");
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

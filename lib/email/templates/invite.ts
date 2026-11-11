/**
 * Convite de time, sem React Email. Devolve subject/html/text.
 * Estilo inline apenas (compatibilidade com cliente de e-mail); zero asset
 * externo.
 *
 * É o PRIMEIRO artefato que um usuário novo recebe do sistema — e chegava com
 * o nome do NOSSO produto em vez do da instalação que convidou. A marca entra
 * resolvida (`marcaDaSaida(organizationId)`, classe A: há organização), e as
 * cores deixam de ser hexes inventados aqui: o botão usa o accent derivado e o
 * resto vem dos neutros da régua do produto.
 *
 * O LOGO entrou depois, e por um motivo medido: `MarcaDeSaida.logoUrl` era
 * campo morto — resolvido, entregue a este template e a nenhum outro, e
 * renderizado por ninguém. Um e-mail que diz o nome do revendedor mas mostra a
 * arte de ninguém é meia marca; e este é o e-mail que a pessoa abre antes de
 * ter visto qualquer tela do produto.
 *
 * O IDIOMA (#4302) chega resolvido em `idioma` e vale para assunto, título,
 * corpo, botão, validade e texto puro. Quem convida é quem tem a organização —
 * a pessoa convidada ainda não tem preferência salva, então a cadeia
 * `destinatário → organização → APP_LOCALE` cai no idioma da empresa. O texto
 * vive no dicionário da interface; este arquivo não guarda frase nenhuma.
 */
import { rotuloDoPapel } from "@/lib/auth/types";
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

import { estruturaDeEmail } from "./estrutura";
import { preencher } from "./texto";

export interface InviteEmailOptions {
  inviterName: string;
  orgName: string;
  acceptUrl: string;
  role: string;
  expiresAt: Date;
  /** A marca de quem convidou. Obrigatória — sem ela o e-mail não tem dono. */
  marca: MarcaDeSaida;
  /** O idioma de quem recebe. Sem ele, `pt-BR` — o comportamento de antes. */
  idioma?: Idioma;
}

export function buildInviteEmail(opts: InviteEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const idioma = opts.idioma ?? IDIOMA_PADRAO;
  const t = (texto: string, valores: Readonly<Record<string, string>> = {}) =>
    preencher(traduzir(texto, idioma), valores);

  const expiresStr = opts.expiresAt.toLocaleString(idioma, {
    timeZone: "America/Sao_Paulo",
  });
  const marca = opts.marca.nome;
  const subject = t("{convidador} convidou você para a {organizacao} no {marca}", {
    convidador: opts.inviterName,
    organizacao: opts.orgName,
    marca,
  });

  // O papel pelo NOME (« Atendente »), não pelo código (« agent »): o convite dizia
  // « convidou você como agent » em toda instalação. O nome é traduzido pelo
  // mesmo dicionário do seletor de papel, então em espanhol sai « Asesor ».
  const papel = traduzir(rotuloDoPapel(opts.role), idioma);

  const html = estruturaDeEmail(
    opts.marca,
    `    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      ${escapeHtml(t("Você foi convidado para a {organizacao}", { organizacao: opts.orgName }))}
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      ${escapeHtml(t("{convidador} convidou você como", { convidador: opts.inviterName }))}
      <strong>${escapeHtml(papel)}</strong> ${escapeHtml(t("no {marca}.", { marca }))}
    </p>
    <p style="margin:24px 0">
      <a href="${escapeHtml(opts.acceptUrl)}" style="display:inline-block;padding:12px 24px;background:${opts.marca.accent};color:${opts.marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">
        ${escapeHtml(t("Aceitar convite"))}
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      ${escapeHtml(t("Ou copie e cole este link no navegador:"))}<br>
      <span style="word-break:break-all;color:${opts.marca.accent}">${escapeHtml(opts.acceptUrl)}</span>
    </p>
    <p style="margin:24px 0 0;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      ${escapeHtml(t("Este link expira em"))} <strong>${expiresStr}</strong>. ${escapeHtml(t("Se você não esperava este convite, pode ignorá-lo."))}
    </p>`,
    idioma,
  );

  const text = [
    t("Você foi convidado para a {organizacao} como {papel} no {marca}.", {
      organizacao: opts.orgName,
      papel,
      marca,
    }),
    "",
    t("Aceitar: {url}", { url: opts.acceptUrl }),
    "",
    t("Expira em {data}.", { data: expiresStr }),
  ].join("\n");

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

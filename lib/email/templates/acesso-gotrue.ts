import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

import { estruturaDeEmail } from "./estrutura";
import { preencher } from "./texto";

/**
 * Os dois e-mails de ACESSO — confirmar conta e redefinir senha — no formato
 * que o GoTrue renderiza.
 *
 * ─── POR QUE ISTO É DIFERENTE DE `invite.ts` ────────────────────────────────
 *
 * O convite de time é montado e ENVIADO por nós. Estes dois não: quem os
 * renderiza e envia é o GoTrue, um processo de terceiro. Nós só entregamos o
 * MOLDE, e ele preenche `{{ .RedirectTo }}` e `{{ .TokenHash }}` na hora do
 * envio. Por isso a saída aqui é uma string de template Go, não um e-mail
 * pronto — e por isso as chaves duplas NÃO passam por escape: elas são sintaxe
 * do renderizador, não dado.
 *
 * ─── POR QUE `token_hash` E NÃO `{{ .ConfirmationURL }}` ────────────────────
 *
 * O modelo PADRÃO do GoTrue linka para `/auth/v1/verify`, que devolve um `code`
 * PKCE. O verificador desse code vive num cookie `SameSite=Strict`
 * (`lib/supabase/server.ts`), e clique vindo de webmail é navegação
 * cross-site: o cookie não viaja, `exchangeCodeForSession` falha, e a conta é
 * confirmada sem que a sessão feche. `token_hash` não depende de cookie nenhum.
 *
 * Medido numa instalação self-hosted em 2026-09-10: com o modelo padrão, o
 * `api_audit_log` registrava `auth.email_link_rejected` com
 * `"PKCE code verifier not found in storage"`; com estes moldes, o mesmo fluxo
 * fecha a sessão.
 *
 * ─── `&`, NUNCA `?` ────────────────────────────────────────────────────────
 *
 * `.RedirectTo` já chega com `?type=` embutido — `signUp.ts` e
 * `requestPasswordReset.ts` o anexam de propósito, porque é o único jeito de o
 * `type` sobreviver ao hop pelo GoTrue no outro formato. Um `?` aqui duplicaria
 * o separador e o parser de URL do browser pararia de reconhecer `token_hash`.
 *
 * ─── O IDIOMA (#4302) ──────────────────────────────────────────────────────
 *
 * A cópia saiu deste arquivo e foi para `lib/i18n/dicionario.ts`, que é a fonte
 * de texto da interface. Quem decide o idioma é `idiomaDoEmail` — e aqui, como
 * não há sessão nem organização (o GoTrue busca o molde sozinho), o que vale é
 * o `APP_LOCALE` da instalação. Assunto e corpo saem SEMPRE do mesmo idioma:
 * meio e-mail traduzido é pior que e-mail em português.
 */

export type ModeloDeAcesso = "confirmation" | "recovery";

export const MODELOS_DE_ACESSO: readonly ModeloDeAcesso[] = ["confirmation", "recovery"];

interface CopiaDoModelo {
  assunto: string;
  titulo: string;
  corpo: string;
  botao: string;
  rodape: string;
}

/**
 * O texto de cada modelo, já traduzido e com a marca aplicada.
 *
 * `assunto` também sai daqui porque o assunto do GoTrue é configurado no
 * ambiente (`GOTRUE_MAILER_SUBJECTS_*`): quem monta essa configuração precisa da
 * mesma frase, no mesmo idioma do corpo, e não de uma segunda cópia escrita à mão.
 */
function copiaDoModelo(modelo: ModeloDeAcesso, marca: MarcaDeSaida, idioma: Idioma): CopiaDoModelo {
  const t = (texto: string) => preencher(traduzir(texto, idioma), { marca: marca.nome });

  if (modelo === "confirmation") {
    return {
      assunto: t("Confirme seu e-mail · {marca}"),
      titulo: t("Confirme seu e-mail"),
      corpo: t(
        "Sua conta no {marca} está quase pronta. Clique no botão abaixo para confirmar seu e-mail e ativar sua conta.",
      ),
      botao: t("Confirmar e-mail"),
      rodape: t("Se você não criou esta conta, ignore este e-mail."),
    };
  }

  return {
    assunto: t("Redefinir sua senha · {marca}"),
    titulo: t("Redefinir sua senha"),
    corpo: t(
      "Recebemos um pedido para redefinir a senha da sua conta no {marca}. Clique no botão abaixo para escolher uma nova.",
    ),
    botao: t("Definir nova senha"),
    rodape: t("Se não foi você quem pediu, ignore este e-mail — sua senha continua a mesma."),
  };
}

export function assuntoDoModelo(
  modelo: ModeloDeAcesso,
  marca: MarcaDeSaida,
  idioma: Idioma = IDIOMA_PADRAO,
): string {
  return copiaDoModelo(modelo, marca, idioma).assunto;
}

/**
 * O molde, com a marca da INSTALAÇÃO já aplicada.
 *
 * Estilo inline apenas e zero asset externo além do logo, pelas mesmas razões
 * de `invite.ts` — inclusive a dimensão no atributo, que o Outlook desktop
 * exige porque descarta `height` de style em imagem.
 */
export function montarTemplateDeAcesso(
  modelo: ModeloDeAcesso,
  marca: MarcaDeSaida,
  idioma: Idioma = IDIOMA_PADRAO,
): string {
  const t = copiaDoModelo(modelo, marca, idioma);

  // As chaves duplas ficam CRUAS de propósito: o GoTrue as substitui.
  const destino = "{{ .RedirectTo }}&token_hash={{ .TokenHash }}";

  return estruturaDeEmail(
    marca,
    `    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      ${escapeHtml(t.titulo)}
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      ${escapeHtml(t.corpo)}
    </p>
    <p style="margin:24px 0">
      <a href="${destino}" style="display:inline-block;padding:12px 24px;background:${marca.accent};color:${marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">
        ${escapeHtml(t.botao)}
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      ${escapeHtml(traduzir("Ou copie e cole este link no navegador:", idioma))}<br>
      <span style="word-break:break-all;color:${marca.accent}">${destino}</span>
    </p>
    <p style="margin:24px 0 0;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      ${escapeHtml(t.rodape)}
    </p>`,
    idioma,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

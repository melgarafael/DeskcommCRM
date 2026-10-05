/**
 * LGPD export email delivery — pelo transporte que a instalação tiver (SMTP ou
 * Resend; quem escolhe é `lib/email/roteador.ts`).
 *
 * NEVER logs the recipient address in plaintext (CLAUDE.md §LGPD L-08).
 * Only sha256(email) appears in logs/audit metadata.
 *
 * ── Este e-mail diz quem OPEROU; o PDF diz quem RESPONDE ────────────────────
 *
 * Aqui a marca resolvida é a resposta certa: o e-mail informa que a solicitação
 * foi PROCESSADA, e no produto de um revendedor quem processa é o sistema dele.
 * O relatório em anexo faz o oposto de propósito — nomeia o CONTROLADOR
 * (`organizations.legal_name`) e nenhuma marca, porque ali o que está em jogo é
 * quem responde legalmente pelos dados (ver `lib/lgpd/pdf-renderer.tsx`).
 *
 * São dois papéis diferentes, e é por isso que as duas saídas carregam nomes
 * diferentes. Sem esta frase escrita, a próxima pessoa "uniformiza" os dois e
 * refaz o defeito — numa direção ou na outra.
 *
 * Antes desta fase o nome vinha de `args.organizationName ?? "DeskcommCRM"`, e
 * isso NÃO era borda: o único chamador (`workers/lgpd-export-worker.ts`) nunca
 * passava o campo, então 100% dos e-mails de LGPD de todo clone diziam que a
 * solicitação tinha sido processada pelo DeskcommCRM. O campo agora é
 * obrigatório e resolvido — não sobra fallback porque `marcaDaSaida` já desce
 * até o padrão do produto por conta própria.
 *
 * ── O texto depende do PAÍS da organização (doc 88) ─────────────────────────
 *
 * O Brasil recebe o texto de sempre, byte a byte. Fora do Brasil o e-mail sai
 * em pt-PT, sem LGPD, citando a lei do país só quando o perfil tem citação
 * revisada (`citacaoDaLei`), e com o prazo do link no fuso da organização e o
 * nome do fuso escrito. Antes, com Portugal no seletor, o PDF citaria o RGPD e
 * este e-mail diria "LGPD Lei nº 13.709/2018" ao mesmo titular.
 * ponytail: o ramo não-BR é pt-PT; quando entrar país que não fala português,
 * ele vira ramo por idioma.
 */

import { createHash } from "node:crypto";

import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";
import { citacaoDaLei, PAIS_PADRAO, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";

export class EmailNotConfigured extends Error {
  constructor() {
    super("no email transport configured (neither SMTP nor Resend)");
    this.name = "EmailNotConfigured";
  }
}

export class EmailSendFailed extends Error {
  constructor(detail: string) {
    super(`email send failed: ${detail}`);
    this.name = "EmailSendFailed";
  }
}

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

interface SendArgs {
  to: string;
  requestId: string;
  signedUrl: string;
  expiresAt: Date;
  /** A marca de quem PROCESSOU a solicitação. Obrigatória — ver o cabeçalho. */
  marca: MarcaDeSaida;
  /** O país da organização decide a lei e o idioma do texto. */
  perfil: PerfilDoPais;
  /**
   * A ligação para o `data.json` — a cópia do art. 15.º, n.º 3 (issue #2340), que sobe no mesmo diretório do
   * `report.pdf` (`workers/lgpd-export-worker.ts`). Chave obrigatória com
   * valor possivelmente `undefined`, a mesma disciplina do `fuso`: o chamador
   * não a esquece calado. Imprime só no ramo FORA do Brasil — o e-mail
   * brasileiro é travado byte a byte pelo doc 88.
   */
  signedUrlDados: string | undefined;
  /**
   * Fuso IANA da organização; só é lido fora do Brasil. A chave é obrigatória
   * (o valor pode ser `undefined`) para quem chama não a esquecer calado.
   */
  fuso: string | undefined;
}

interface Mensagem {
  subject: string;
  html: string;
  text: string;
}

export async function sendExportEmail(args: SendArgs): Promise<{ messageId: string }> {
  const shortId = args.requestId.slice(0, 8);
  const { subject, html, text } =
    args.perfil.codigo === PAIS_PADRAO
      ? mensagemDoBrasil(args, shortId)
      : mensagemForaDoBrasil(args, shortId);

  const result = await sendEmail({
    to: args.to,
    subject,
    html,
    text,
    fromName: args.marca.nome,
    tags: [
      { name: "kind", value: "lgpd_export" },
      { name: "request_short", value: shortId },
    ],
  });

  if (!result.ok) {
    if (result.error === "not_configured") {
      throw new EmailNotConfigured();
    }
    throw new EmailSendFailed(result.details ?? result.error ?? "unknown");
  }

  return { messageId: result.id ?? "unknown" };
}

/** O texto de sempre, byte a byte — o Brasil não muda (doc 88). */
function mensagemDoBrasil(args: SendArgs, shortId: string): Mensagem {
  const orgName = escapeHtml(args.marca.nome);
  const expiresFmt = args.expiresAt.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });

  const subject = `Sua solicitação LGPD #${shortId}`;

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:${NEUTROS_DE_SAIDA.texto};line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Solicitação LGPD #${shortId} processada</h2>
  <p>Olá,</p>
  <p>Sua solicitação de acesso aos dados pessoais (LGPD Art. 18, II) foi processada por <strong>${orgName}</strong>.</p>
  <p>O relatório completo está disponível para download no link abaixo. Por motivos de segurança, o link expira em <strong>${expiresFmt}</strong>.</p>
  <p style="margin:24px 0;">
    <a href="${args.signedUrl}" style="background:${args.marca.accent};color:${args.marca.accentFg};padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Baixar relatório LGPD</a>
  </p>
  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">Se você não solicitou este relatório, ignore este email — nenhum dado adicional é compartilhado.</p>
  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">Base legal: LGPD Lei nº 13.709/2018, Art. 18, II.</p>
</body>
</html>`;

  // O corpo em texto puro NÃO passa por `escapeHtml` — escapar aqui mostraria
  // `&amp;` ao titular numa marca como "Silva &amp; Filhos".
  const text = `Solicitação LGPD #${shortId} processada por ${args.marca.nome}.

O relatório completo está disponível em:
${args.signedUrl}

O link expira em ${expiresFmt}.

Se você não solicitou este relatório, ignore este email.
Base legal: LGPD Lei nº 13.709/2018, Art. 18, II.`;

  return { subject, html, text };
}

/**
 * Fora do Brasil: pt-PT, sem LGPD. A linha do direito exercido só existe com
 * citação revisada — país sem revisão não cita lei nenhuma, nem a brasileira.
 */
function mensagemForaDoBrasil(args: SendArgs, shortId: string): Mensagem {
  const orgName = escapeHtml(args.marca.nome);
  const citacao = citacaoDaLei(args.perfil);
  const expiresFmt = expiraEm(args.expiresAt, args.fuso);
  const direito = citacao ? `Direito exercido: acesso aos dados pessoais, ${citacao}.` : null;

  const subject = `Pedido de acesso aos seus dados pessoais #${shortId}`;

  const html = `<!doctype html>
<html lang="pt-PT">
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:${NEUTROS_DE_SAIDA.texto};line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Pedido de acesso aos seus dados pessoais #${shortId}</h2>
  <p>Olá,</p>
  <p>O seu pedido de acesso aos dados pessoais foi tratado por <strong>${orgName}</strong>.</p>
  <p>O relatório está disponível na ligação abaixo. Por razões de segurança, a ligação expira em <strong>${expiresFmt}</strong>.</p>
  <p style="margin:24px 0;">
    <a href="${args.signedUrl}" style="background:${args.marca.accent};color:${args.marca.accentFg};padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Descarregar relatório</a>
  </p>${
    args.signedUrlDados
      ? `\n  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">A cópia dos seus dados pessoais (data.json) está em <a href="${args.signedUrlDados}" style="color:inherit;">${args.signedUrlDados}</a>.</p>`
      : ""
  }
  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">Se não fez este pedido, ignore este e-mail.</p>${
    direito ? `\n  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">${escapeHtml(direito)}</p>` : ""
  }
</body>
</html>`;

  const text = `Pedido de acesso aos seus dados pessoais #${shortId}, tratado por ${args.marca.nome}.

O relatório está disponível em:
${args.signedUrl}${
    args.signedUrlDados
      ? `

A cópia dos seus dados pessoais (data.json) está em:
${args.signedUrlDados}`
      : ""
  }

A ligação expira em ${expiresFmt}.

Se não fez este pedido, ignore este e-mail.${direito ? `\n${direito}` : ""}`;

  return { subject, html, text };
}

/**
 * O prazo do link no fuso da organização, com o NOME do fuso escrito. Um fuso
 * que o `Intl` recusa não pode derrubar a entrega ao titular: cai em UTC, que
 * continua verdadeiro porque o nome do fuso vai junto.
 */
function expiraEm(quando: Date, fuso: string | undefined): string {
  const formato = (timeZone: string) =>
    quando.toLocaleString("pt-PT", { timeZone, timeZoneName: "short" });
  try {
    return formato(fuso ?? "UTC");
  } catch {
    return formato("UTC");
  }
}

/**
 * A marca deixou de ser constante e passou a vir de um campo que o operador
 * digita numa tela — então ela entra no HTML escapada. Antes desta fase o valor
 * era o literal `"DeskcommCRM"` e a questão não existia.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

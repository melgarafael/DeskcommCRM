/**
 * Plain (no React Email) PT-BR invite email. Returns subject/html/text.
 * Inline styles only (email client compat). No external assets.
 */
export interface InviteEmailOptions {
  inviterName: string;
  orgName: string;
  acceptUrl: string;
  role: string;
  expiresAt: Date;
}

export function buildInviteEmail(opts: InviteEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const expiresStr = opts.expiresAt.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
  const subject = `${opts.inviterName} convidou você para a ${opts.orgName} no Deskcomm`;

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1917">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:#0c0a09">
      Você foi convidado para a ${escapeHtml(opts.orgName)}
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      ${escapeHtml(opts.inviterName)} convidou você como
      <strong>${escapeHtml(opts.role)}</strong> no DeskcommCRM.
    </p>
    <p style="margin:24px 0">
      <a href="${opts.acceptUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">
        Aceitar convite
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#57534e">
      Ou copie e cole este link no navegador:<br>
      <span style="word-break:break-all;color:#0ea5e9">${opts.acceptUrl}</span>
    </p>
    <p style="margin:24px 0 0;font-size:13px;color:#78716c">
      Este link expira em <strong>${expiresStr}</strong>. Se você não esperava este convite, pode ignorá-lo.
    </p>
  </div>
</body>
</html>`;

  const text = [
    `Você foi convidado para a ${opts.orgName} como ${opts.role}.`,
    "",
    `Aceitar: ${opts.acceptUrl}`,
    "",
    `Expira em ${expiresStr}.`,
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

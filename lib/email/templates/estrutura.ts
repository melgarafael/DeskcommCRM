import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";

export function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Corpo já escapado pelo template; tabela e estilos inline funcionam sem CSS externo. */
export function estruturaDeEmail(marca: MarcaDeSaida, conteudo: string): string {
  const nome = escaparHtml(marca.nome);
  const logo =
    marca.logoUrl && /^https?:\/\//i.test(marca.logoUrl)
      ? `<img src="${escaparHtml(marca.logoUrl)}" alt="${nome}" height="40" style="height:40px;width:auto;max-width:200px;border:0;display:block;margin-bottom:16px">`
      : "";
  return `<!doctype html>
<html lang="pt-BR"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};color:${NEUTROS_DE_SAIDA.texto};font-family:Arial,Helvetica,sans-serif;line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NEUTROS_DE_SAIDA.fundo}"><tr><td align="center" style="padding:24px 12px">
<!--[if mso]><table role="presentation" width="560"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr><td style="padding:24px;border-top:4px solid ${marca.accent};color:${NEUTROS_DE_SAIDA.texto}">
${logo}<p style="margin:0 0 24px;font-size:16px;font-weight:bold;color:${NEUTROS_DE_SAIDA.texto}">${nome}</p>
${conteudo}
</td></tr></table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

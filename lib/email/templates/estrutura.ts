import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Casca já distribuída de convite e acesso: extrair não muda sua identidade.
 * O corpo vem escapado pelo chamador; a marca e o logo são dados, não HTML.
 * Dimensão no atributo mantém o logo contido também no Outlook.
 *
 * `idioma` existe para o `lang` do documento dizer a verdade (#4302): um e-mail
 * escrito em espanhol com `<html lang="pt-BR">` faz o cliente de e-mail escolher
 * hifenização e leitor de tela em português. Sem argumento continua `pt-BR` —
 * é o que garante que nenhum molde antigo mude um byte.
 */
export function estruturaDeEmail(
  marca: MarcaDeSaida,
  conteudo: string,
  idioma: Idioma = IDIOMA_PADRAO,
): string {
  const logo = marca.logoUrl
    ? `<p style="margin:0 0 24px"><img src="${escaparHtml(marca.logoUrl)}" alt="${escaparHtml(marca.nome)}" height="40" style="height:40px;width:auto;max-width:200px;border:0;display:block"></p>`
    : "";
  return `<!doctype html>
<html lang="${idioma}">
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${NEUTROS_DE_SAIDA.texto}">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    ${logo}
${conteudo}
  </div>
</body>
</html>`;
}

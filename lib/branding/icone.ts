/**
 * A letra que vai no ícone da aba — e o caso em que NÃO vai letra nenhuma.
 *
 * Mora fora de `app/icon.tsx` de propósito. O loader de metadata do Next
 * re-exporta TODO named export do arquivo do usuário para o módulo de rota
 * gerado (`next-metadata-route-loader.js:43`, exceto `default`,
 * `generateSitemaps` e `dynamicParams`), então uma função auxiliar exportada
 * de lá viraria export de rota — e export desconhecido em módulo de rota é
 * justamente o que o Next reprova no build. Aqui ela é uma função pura,
 * testável sem subir renderizador de imagem nenhum.
 *
 * ─── Por que não dá para reusar `resolveBranding().initial` direto ──────────
 *
 * `resolveBranding` (`lib/branding.ts:47-50`) usa spread em vez de `[0]` para
 * não partir code point — e por isso devolve o EMOJI quando a marca começa com
 * um ("🚀 Foguete" → "🚀"). Na sidebar isso é o comportamento certo: o browser
 * tem as fontes de emoji. No ícone não: quem desenha é o satori (`next/og`),
 * que só carrega a fonte embutida `Geist-Regular.ttf` e renderiza QUALQUER
 * glifo ausente como tofu (▯). Buscar uma fonte de emoji resolveria — e faria
 * o `<head>` de toda página depender de uma requisição de rede, que é
 * exatamente o que o ícone gerado existe para evitar.
 *
 * Então a regra é: a primeira LETRA OU DÍGITO do nome. Não havendo nenhuma
 * (marca só de emoji, ou só de pontuação), devolve `null` — e quem chama
 * desenha o ladrilho do accent SEM letra. Cair na inicial do produto seria
 * pior que não ter letra: a aba do revendedor mostraria a NOSSA letra, que é o
 * defeito de white-label que este épico inteiro existe para fechar.
 */

import { baseDoStorage, urlPublicaDoLogo } from "./logo";

/**
 * A primeira letra ou dígito de `nome`, em caixa alta. `null` quando o nome não
 * tem nenhum — aí o ícone é só a cor da marca.
 *
 * `\p{L}` e `\p{N}` com a flag `u`, não `[A-Za-z0-9]`: "Ótimo CRM" tem de
 * render "Ó", e "Ácaro" tem de render "Á". Restringir ao ASCII descartaria a
 * primeira letra de boa parte dos nomes em português e devolveria a segunda.
 */
export function letraDoIcone(nome: string): string | null {
  for (const caractere of nome.trim()) {
    if (/\p{L}|\p{N}/u.test(caractere)) return caractere.toUpperCase();
  }
  return null;
}

/** A rota que desenha o ícone (cor + inicial) — o padrão sem arquivo subido. */
export const ICONE_DESENHADO = "/icon";

/**
 * Para onde o `<link rel="icon">` aponta.
 *
 * Com `favicon_path` gravado (migration 0443), é a URL pública do ARQUIVO que o
 * operador subiu em `/admin/marca`. O `<head>` não baixa nada: quem pede a
 * imagem é o navegador, do mesmo storage de onde o logo já é servido. Isso
 * preserva o motivo de `app/icon.tsx` não buscar `logo_url` — nenhuma
 * requisição de saída do servidor, e o caminho é validado por CHECK no banco
 * (prefixo `platform/`, uuid, png|jpg), nunca uma URL digitada.
 *
 * Sem arquivo, ou sem base de storage conhecida, cai no ícone desenhado.
 * `base` explícito pelo mesmo motivo de `logoDaCamada`: testar sem `process.env`.
 */
export function iconeDaAba(
  faviconPath: string | null | undefined,
  base: string = baseDoStorage(),
): string {
  const caminho = (faviconPath ?? "").trim();
  if (caminho.length === 0 || base.length === 0) return ICONE_DESENHADO;
  return urlPublicaDoLogo(caminho, base);
}

/**
 * O `?v=` dos ícones do app instalado: muda quando o operador troca o arquivo,
 * para o navegador não ficar com o PNG antigo. Manifest e `<head>` usam o
 * mesmo sufixo, senão o cache de um diverge do outro.
 */
export function sufixoDoIcone(faviconPath: string | null | undefined): string {
  return faviconPath ? `?v=${encodeURIComponent(faviconPath)}` : "";
}

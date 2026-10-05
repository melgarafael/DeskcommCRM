/**
 * Saída de emergência do CSS personalizado da instalação.
 *
 * Uma folha salva pode deixar o login ou `/admin/marca` ilegíveis (texto
 * transparente, `font-size: 0`, sombra cobrindo a tela) — e a tela que desfaz o
 * estrago é uma das que ficaram ilegíveis. Abrir qualquer página com `?sem_css=1`
 * a renderiza sem a folha, só para quem pediu: o `proxy.ts` traduz o parâmetro
 * neste cabeçalho, e o layout raiz o lê. Documentado em `docs/white-label.md`.
 *
 * Arquivo à parte, e sem importar nada, porque o `proxy.ts` o importa: puxar
 * daqui o validador puxaria o PostCSS para dentro do proxy.
 */
export const PARAMETRO_SEM_CSS = "sem_css";
export const CABECALHO_SEM_CSS = "x-sem-css-personalizado";

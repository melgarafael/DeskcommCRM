/**
 * O `<style>` do template e da segunda cor da organização (tela Aparência).
 *
 * `null` é o caso comum: quem nunca escolheu template não ganha elemento
 * nenhum. O texto vem de `cssDaAparenciaDaOrganizacao` — valores de um catálogo
 * fechado, com nome e valor de cada token conferidos (`lib/aparencia/css.ts`) e
 * a segunda cor só como hex.
 *
 * Vem ANTES de `EstiloDaMarcaDaOrganizacao` no documento, de propósito: os dois
 * escopos têm a mesma especificidade, e a cor que a empresa definiu na tela
 * Marca tem de vencer a do template.
 */
export function EstiloDaAparencia({ css }: { css: string | null }) {
  if (!css) return null;
  return <style id="aparencia-organizacao" dangerouslySetInnerHTML={{ __html: css }} />;
}

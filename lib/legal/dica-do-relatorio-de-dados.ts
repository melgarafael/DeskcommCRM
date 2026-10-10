/**
 * A dica da tela Marca sobre o relatório de dados do titular (#2503).
 *
 * ─── O defeito que isto conserta ────────────────────────────────────────────
 *
 * A frase nomeia o CAMPO do cadastro e a LEI — e os dois são do PAÍS da
 * organização, não do idioma da interface: no Brasil ela manda conferir a
 * "Razão social" e fala de LGPD; em Portugal, "Denominação social" e RGPD
 * (`lib/legal/perfil-do-pais.ts`, dos #2502/#1946). Enquanto era literal, a
 * organização portuguesa lia uma instrução que apontava para um campo com
 * outro nome.
 *
 * ─── Por que template com placeholder, e não concatenação ───────────────────
 *
 * A chave do dicionário é o texto INTEIRO, com os placeholders; a tradução
 * acontece primeiro (`t`) e o vocabulário do país entra depois — mesmo desenho
 * do `"{n} dias"` das telas de retenção e do `"Dia {n}"` da régua de cobrança.
 * Concatenar pedaços traduzidos quebraria a ordem das palavras em qualquer
 * idioma que não o português, e não teria chave para o espanhol cobrar.
 *
 * Puro de propósito: o teste cobre BR e PT sem montar a tela; o call site (a
 * página lê `country` e passa o vocabulário) é conferido na fonte pelo próprio
 * teste.
 */
export const DICA_DO_RELATORIO =
  'O relatório de {lei} entregue ao cliente traz a {campo_alto} da sua empresa, e não o nome aqui de cima — é ela que responde legalmente pelos dados. Confira o campo "{campo}" em Configurações → Organização.';

/** O vocabulário do país que a frase cita — vem do perfil, nunca do componente. */
export interface VocabularioDaEmpresa {
  /** Nome da lei no país: "LGPD", "RGPD". */
  lei: string;
  /** Rótulo do nome legal no país: "Razão social", "Denominação social". */
  rotuloNomeLegal: string;
}

/**
 * A frase pronta: traduz o template e preenche o vocabulário do país.
 *
 * `{campo_alto}` é a mesma palavra em CAIXA ALTA (a ênfase do texto original);
 * `{campo}` é o rótulo como o operador o lê no formulário. O rótulo passa por
 * `t` como na tela de Organização (`app/app/settings/tenant/_form.tsx`, que
 * mostra `t(perfil.empresa.rotuloNomeLegal)`): sem isso, a organização
 * brasileira com a tela em espanhol leria "Razão social" onde o campo diz
 * "Razón social".
 */
export function dicaDoRelatorio(
  t: (texto: string) => string,
  vocabulario: VocabularioDaEmpresa,
): string {
  const campo = t(vocabulario.rotuloNomeLegal);
  return t(DICA_DO_RELATORIO)
    .replace("{lei}", vocabulario.lei)
    .replace("{campo_alto}", campo.toUpperCase())
    .replace("{campo}", campo);
}

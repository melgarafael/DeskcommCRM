/**
 * O `--to` da FORÇA — a mesma conta que a tela faz ao lado do botão.
 *
 * A tela de atualização tem dois caminhos de saída de um estado de falha, e os
 * dois são o MESMO comando: o `update.sh --to <anterior> --force` que ela
 * renderiza em `<Comando>` (para copiar) e o botão "Forçar atualização" que
 * executa ele sem SSH. Se as duas pontas calculassem por conta própria, elas
 * divergiriam no dia em que uma mudasse — e aí o botão faria uma coisa enquanto
 * a tela prometia outra, que é o defeito que este recurso existe para não
 * ter. `UpdatePanel.comandoDeVolta` é quem monta a frase; este módulo é quem
 * decide a TAG, e `UpdatePanel.test.tsx` costura os dois com um teste de
 * espelho.
 *
 * O cliente não manda nada disto: o POST leva só `{ force: true }`, e o
 * servidor deriva o alvo aqui — ele tem o `from_version` do run de falha do
 * mesmo jeito que a tela.
 */

/** Tira o "v" das versões: a tela fala "1.1.0", não "v1.1.0". */
function semV(versao: string | undefined): string {
  return (versao ?? "").replace(/^v/i, "");
}

/**
 * A tag que uma força deve instalar, espelhando `comandoDeVolta`.
 *
 * `from_version` pode ser uma marca de desenvolvimento (instalação fora de
 * release) — nesse caso não existe imagem publicada com esse nome para puxar,
 * e a resposta é `""`: o host roda `update.sh --force` sem `--to` e o próprio
 * script resolve o alvo (e recusa em português o que não puder instalar).
 *
 * Devolve `"vX.Y.Z…"` (com o `v`, que é como o git conhece a tag) ou `""`.
 */
export function alvoDeVolta(fromVersion: string | undefined): string {
  const anterior = semV(fromVersion);
  return /^\d+\.\d+\.\d+/.test(anterior) ? `v${anterior}` : "";
}

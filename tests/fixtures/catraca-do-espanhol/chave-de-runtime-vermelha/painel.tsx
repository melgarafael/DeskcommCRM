/**
 * Fixture VERMELHA da chave construída em runtime (#603) — as DUAS formas que
 * o guardião tem de reprovar, cada uma na sua linha:
 *
 *   1. `t(rotulo)` — variável declarada DENTRO do componente, inicializada com
 *      `ROTULOS[indicador] ?? indicador`. Não é parâmetro (o cego C do #1867
 *      não entra aqui) e o resolvedor do passo 1 indexa só `const` de topo,
 *      então ninguém enxerga o valor: o gate ficava verde sobre a ausência.
 *
 *   2. ``t(`Meta de ${indicador} batida`)`` — a chave é MONTADA em runtime.
 *      Não existe literal no dicionário para aquela frase, e `traduzir()`
 *      devolve a própria chave quando ela falta (lib/i18n/dicionario.ts:14271),
 *      então quem escolheu espanhol lê português.
 *
 * O guardião tem de reprovar ESTAS duas linhas, apontando arquivo:linha de
 * cada uma. O `t` local é de mentira de propósito: a fixture prova o
 * ANALISADOR, não o runtime da tradução.
 */
const t = (texto: string) => texto;

const ROTULOS: Record<string, string> = { receita: "Receita do mês" };

export function PainelDoIndicador({ indicador }: { indicador: string }) {
  const rotulo = ROTULOS[indicador] ?? indicador;
  return (
    <div>
      <p>{t(rotulo)}</p>
      <p>{t(`Meta de ${indicador} batida`)}</p>
    </div>
  );
}

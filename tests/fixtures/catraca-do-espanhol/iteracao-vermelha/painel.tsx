/**
 * Fixture VERMELHA da catraca — `t(r)` dentro de `Object.entries()/values().map`,
 * com UM valor da tabela sem espanhol no dicionário.
 *
 * A catraca tem de REPROVAR apontando `painel.tsx:<linha>` de CADA `t(...)` que
 * passa o valor que falta (aqui, os dois sítios).
 *
 * O `t` local é de mentira de propósito: a fixture prova o ANALISADOR, não o
 * runtime da tradução.
 */
const t = (texto: string) => texto;

const TIPO_DA_ETAPA: Record<string, string> = {
  concluida: "Concluída",
  semTraducao: "Rótulo que a fixture vermelha deixou sem tradução",
};

export function SeletorPorEntries() {
  return (
    <select>
      {Object.entries(TIPO_DA_ETAPA).map(([valor, rotulo]) => (
        <option key={valor} value={valor}>
          {t(rotulo)}
        </option>
      ))}
    </select>
  );
}

export function ListaPorValues() {
  return <ul>{Object.values(TIPO_DA_ETAPA).map((rotulo) => <li key={rotulo}>{t(rotulo)}</li>)}</ul>;
}

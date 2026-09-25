/**
 * Fixture VERDE da catraca — `t(r)` dentro de `Object.entries()/values().map`.
 *
 * O caso real é o seletor "Tipo da conta" de Configurações › Financeiro: a tabela
 * de rótulos é do módulo e o `t()` só vê o parâmetro do `.map`. A catraca antiga
 * não ligava um ao outro, e três valores (`Caixa`, `Banco`, `Outra`) ficaram sem
 * espanhol com o teste verde.
 *
 * Todo valor da tabela tem espanhol no dicionário, então a catraca tem de PASSAR.
 * O terceiro sítio (`itens.map`) vem de dado de runtime e NÃO pode ser resolvido:
 * a varredura conta esse sítio à parte em vez de chutar valores.
 *
 * O `t` local é de mentira de propósito: a fixture prova o ANALISADOR, não o
 * runtime da tradução.
 */
const t = (texto: string) => texto;

const TIPO_DA_ETAPA: Record<string, string> = {
  concluida: "Concluída",
  etapas: "Etapas do funil",
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

export function ListaDeRuntime({ itens }: { itens: string[] }) {
  return <ul>{itens.map((item) => <li key={item}>{t(item)}</li>)}</ul>;
}

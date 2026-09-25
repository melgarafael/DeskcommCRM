/**
 * Nome da cópia de um fluxo. `followup_flow_pointers` tem
 * `unique (organization_id, name)` — duplicar "Foo" duas vezes não pode
 * tentar gravar "Foo (cópia)" de novo.
 *
 * Teto: 80 caracteres (o mesmo do `createFollowupFlowSchema`). Se o original
 * já está no limite, o sufixo come o final do nome, não estoura a coluna.
 */
export const MAX_FOLLOWUP_FLOW_NAME = 80;

export function nomeDaCopia(original: string, ocupados: Iterable<string>): string {
  const taken = new Set(ocupados);
  const raiz = original.trim() || "Fluxo";
  for (let n = 1; n < 1000; n++) {
    const sufixo = n === 1 ? " (cópia)" : ` (cópia ${n})`;
    const nome =
      raiz.length + sufixo.length <= MAX_FOLLOWUP_FLOW_NAME
        ? raiz + sufixo
        : raiz.slice(0, MAX_FOLLOWUP_FLOW_NAME - sufixo.length) + sufixo;
    if (!taken.has(nome)) return nome;
  }
  // ponytail: 1000 cópias do mesmo fluxo é o teto; UUID no sufixo é o upgrade.
  return `${raiz.slice(0, 71)} ${crypto.randomUUID().slice(0, 8)}`.slice(
    0,
    MAX_FOLLOWUP_FLOW_NAME,
  );
}

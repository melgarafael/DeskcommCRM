/**
 * O que o seed de demonstração imprime no fim — o ESTADO depois da rodada, com os
 * nomes que a tela usa.
 *
 * ⚠️ VIVE FORA DO SEEDER pelo motivo de sempre (ele roda `main()` ao ser
 * importado), e aqui dá para testar: `tests/unit/resumo-do-seed-diz-o-que-existe.test.ts`.
 *
 * A primeira versão contava o que a RODADA gravou e o apresentava como estado: na
 * segunda rodada, com 3 execuções e 4 inscrições no banco, dizia "0 execuções no
 * histórico" e "0 inscrições" — quem roda de novo para conferir lê que a
 * demonstração sumiu. E mandava olhar "as abas Regras e Atividade", mas a aba se
 * chama "Automações": quem procura "Regras" na tela não acha.
 */

export interface ContagemDaRodada {
  /** Quantas existem depois da rodada. */
  existem: number;
  /** Quantas esta rodada criou (0 numa rodada repetida). */
  criadasAgora: number;
}

export interface EstadoDaDemonstracao {
  regras: ContagemDaRodada & { ligadas: number };
  execucoes: ContagemDaRodada;
  fluxo: { nome: string; ativo: boolean };
  inscricoes: ContagemDaRodada;
}

/** Onde a pessoa vê o que o seed criou: o nome no menu, a rota e as abas, como a tela os escreve. */
export const TELAS_DA_DEMONSTRACAO = [
  { tela: "Webhooks", rota: "/app/webhooks", abas: ["Automações", "Atividade"] },
  { tela: "Follow-ups", rota: "/app/ai/followups", abas: ["Fluxos", "Fila"] },
] as const;

function quantos(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function nestaRodada(c: ContagemDaRodada, singular: string, plural: string): string {
  return `${quantos(c.criadasAgora, singular, plural)} nesta rodada`;
}

export function textoDoResumo(estado: EstadoDaDemonstracao): string {
  const { regras, execucoes, fluxo, inscricoes } = estado;
  const telas = TELAS_DA_DEMONSTRACAO.map(
    ({ tela, rota, abas }) => `${tela} › abas ${abas.join(" e ")} (${rota})`,
  ).join("; ");
  return (
    `\n✅ Seed de automações e follow-ups completo. O que existe agora na organização de teste:` +
    `\n   Automações: ${quantos(regras.existem, "regra", "regras")} de demonstração, ` +
    `${quantos(regras.ligadas, "ligada", "ligadas")} (${nestaRodada(regras, "criada", "criadas")})` +
    `\n   Atividade:  ${quantos(execucoes.existem, "execução", "execuções")} no histórico ` +
    `(${nestaRodada(execucoes, "criada", "criadas")})` +
    `\n   Follow-ups: fluxo "${fluxo.nome}" ${fluxo.ativo ? "ativo" : "NÃO ativo"}, ` +
    `${quantos(inscricoes.existem, "inscrição", "inscrições")} (${nestaRodada(inscricoes, "criada", "criadas")})` +
    `\n   Onde ver: ${telas}`
  );
}

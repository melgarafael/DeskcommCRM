/** A grade do serviço não prova quando o estabelecimento abre ou fecha. */
export const ORIENTACAO_FUNCIONAMENTO =
  'Compare o dia e horário solicitado com as fontes de funcionamento presencial consultadas abaixo. ' +
  'Se a fonte comprovar que estará fechado, explique isso e informe a abertura ou o fechamento daquele dia. ' +
  'Depois ofereça até duas alternativas disponíveis da consulta atual, próximas do horário pedido, ' +
  'e pergunte qual a pessoa prefere ou se quer outro horário. Não confunda falta de vaga com estabelecimento fechado. ' +
  'Antes da abertura, prefira as primeiras opções; depois do fechamento, as últimas opções válidas. ' +
  'Respeite antecedência e duração da aula/serviço, sem oferecer horário já passado. ' +
  'Sem fonte pertinente ou com exceção não confirmada, informe apenas a indisponibilidade, sem inventar funcionamento. ' +
  'Esta consulta não reserva e não comprova execução; após a escolha revalide pela ferramenta nativa.';

/** Uma busca nativa por turno, com o mesmo escopo/material permitido ao agente. */
export function criarConsultaDeFuncionamento(buscar: () => Promise<unknown>) {
  let consulta: Promise<unknown> | undefined;
  return {
    async anexar<T>(resultado: T): Promise<T | (T & { funcionamento_presencial: unknown })> {
      if (!resultado || typeof resultado !== 'object' || Array.isArray(resultado)) return resultado;
      consulta ??= buscar();
      return { ...resultado, funcionamento_presencial: {
        origem: 'materiais_habilitados_do_agente', consulta: await consulta,
        orientacao: ORIENTACAO_FUNCIONAMENTO,
      } };
    },
  };
}

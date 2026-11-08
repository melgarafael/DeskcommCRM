/**
 * Avaliação veicular — módulo opcional via ADR-0002 (migration 0674).
 *
 * O molde cobre forma (D4) e efeito (provisionar cria as duas tabelas,
 * protegidas, e o núcleo fica intocado). `protecaoPropria` porque a RLS é por
 * papel (leitura da org, escrita em agendamentos a partir de agent, unidades e
 * delete só manager), ligada dentro da própria função.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "avaliacao",
  tabelas: ["avaliacao_unidades", "avaliacao_agendamentos"],
  protecaoPropria: ["avaliacao_unidades", "avaliacao_agendamentos"],
});

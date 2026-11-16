/**
 * A provisionadora do módulo de lista de espera (ADR-0002, D2/D4/D5).
 *
 * RLS própria: leitura da organização e nenhuma escrita de sessão. A rotina
 * automática só enxerga tabela com RLS desligada, então a decisão do módulo fica.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "lista_de_espera",
  tabelas: ["calendar_waitlist"],
  protecaoPropria: ["calendar_waitlist"],
});

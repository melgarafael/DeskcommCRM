/**
 * Honorários — primeiro módulo oficial via ADR-0002 (migration 0398).
 *
 * O molde já cobre forma (D4) e efeito (provisionar cria exatamente as duas
 * tabelas, protegidas, e o núcleo fica intocado). `protecaoPropria` porque a
 * RLS aqui é por PAPEL (leitura da org, escrita manager+ — mesmo padrão do
 * caixa núcleo), ligada dentro da própria função: `fn_proteger_tabelas_de_
 * organizacao()` só enxerga tabela com RLS desligada, então a nossa não
 * ganha a policy ampla — nem deveria.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "honorarios",
  tabelas: ["honorarios_contratos", "honorarios_parcelas"],
  protecaoPropria: ["honorarios_contratos", "honorarios_parcelas"],
});

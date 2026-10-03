/**
 * A PROVISIONADORA DO FINANCEIRO — a comanda nasce na instalação do módulo
 * (ADR-0002, D2/D3/D4/D5).
 *
 * Este arquivo é o molde que o cabeçalho de `./molde-de-provisionadora` já traz
 * pronto, com as tabelas nomeadas. Ele registra a suíte INTEIRA de um módulo: as
 * três regras de forma da D4 e o EFEITO de provisionar de verdade.
 *
 * ## O que este arquivo mede que a varredura genérica não mede
 *
 * `./provisionadora-de-modulo.test.ts` varre o catálogo e reprova qualquer
 * `fn_%_provisionar` malformada. Mas ela roda num banco onde módulo nenhum está
 * instalado, então o conjunto que ela mede é vazio e ela só alcança a FORMA. O
 * EFEITO — a tabela nasceu? nasceu protegida? o núcleo ficou intocado? — só é
 * observável depois de CHAMAR a provisionadora, e isso pede o vocabulário do
 * módulo: quais tabelas ele promete criar. É o que os cinco casos aqui medem.
 *
 * ## Por que o banco tem que vir SEM o módulo
 *
 * `tests/db/banco-limpo-por-arquivo.ts` dá a cada arquivo um banco recién
 * clonado do MOLDE, que é o `baseline.sql` aplicado. Como as cinco tabelas da
 * comanda saíram do baseline (migration 0487), o molde nasce com elas AUSENTES
 * — que é a pré-condição do terceiro caso. Se alguém as puser de volta no
 * baseline, este arquivo reprova com a mensagem "as tabelas já existem antes de
 * provisionar", e a mensagem diz exatamente o conserto.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "financeiro",
  tabelas: ["sales", "sale_items", "commission_rules", "commissions", "loyalty_ledger"],
});

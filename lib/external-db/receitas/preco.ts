/**
 * Conversão robusta de meta_value / coluna (texto) para número no MySQL, sem
 * novo `?`. Aceita:
 *  - "650.000,00" (ponto = milhar, vírgula = decimal, formato brasileiro)
 *  - "650,000.00" (vírgula = milhar, ponto = decimal, formato americano)
 *  - "480000" (número puro)
 *  - "650000.50" (ponto = decimal, 1-2 dígitos no fim)
 *  - "1.200.000" (pontos = milhar, sem vírgula)
 *  - "R$ 650.000,00" / "650.000 reais" (símbolo e texto são descartados)
 *
 * Regras (sem novo `?`), aplicadas na ORDEM abaixo:
 *  - (a) SEM nenhum dígito → NULL (nunca 0).
 *  - (b) vírgula seguida de 1-2 dígitos no FIM → a vírgula é o decimal: o
 *      ponto é milhar e sai, a vírgula vira ponto ("650.000,00" → 650000.00).
 *  - (c) ponto seguido de 1-2 dígitos no FIM → o ponto é o decimal: a vírgula
 *      é milhar e sai ("650,000.00" → 650000.00).
 *  - (d) senão → só separadores de milhar: pontos e vírgulas saem
 *      ("1.200.000" → 1200000.00, "650,000" → 650000.00).
 *
 * **Por que (b) vem antes de (c).** A régua do formato americano é o que faz
 * o preço ser lido pelo valor certo: "650,000.00" é 650 mil, e não 650. A
 * ordem dos ramos é fixa por essa régua e vigiada em `preco.unit.test.ts`.
 * (b) e (c) não se sobrepõem na prática — o fim do número não pode ser
 * precedido de vírgula e de ponto ao mesmo tempo —, mas a ordem fica escrita
 * para que ninguém a troque por engano.
 *
 * ANTES do CASE, tudo que não é dígito, ponto ou vírgula sai (`REGEXP_REPLACE`).
 * Sem isso o CAST de "R$ 650.000,00" dava 0 e o imóvel passava em todo `preco_max`.
 *
 * Preço SEM nenhum dígito ("", "Consulte", "R$") vira NULL, nunca 0: NULL não passa em
 * `<= teto` (o item some do filtro de preço em vez de aparecer "de graça") e sai como
 * preço ausente na listagem. Zero real ("0", "0,00") continua 0.
 *
 * Requer `REGEXP_REPLACE`: MySQL 8.0.4+ (o piso medido da Spec 23) ou MariaDB 10.0.5+.
 * No MySQL 5.7 a consulta falha com erro legível de leitura, não com dado errado.
 *
 * `colunaReferencia` é a expressão já quotada da coluna de preço
 * (ex.: `mpreco.meta_value` na receita do ACF).
 */
export function precoNumero(colunaReferencia: string): string {
  const limpo = `REGEXP_REPLACE(${colunaReferencia}, '[^0-9.,]', '')`;
  return `
    CASE
      WHEN ${limpo} NOT REGEXP '[0-9]' THEN NULL
      WHEN ${limpo} REGEXP ',[0-9]{1,2}$' THEN CAST(REPLACE(REPLACE(${limpo}, '.', ''), ',', '.') AS DECIMAL(10,2))
      WHEN ${limpo} REGEXP '[.][0-9]{1,2}$' THEN CAST(REPLACE(${limpo}, ',', '') AS DECIMAL(10,2))
      ELSE CAST(REPLACE(REPLACE(${limpo}, '.', ''), ',', '') AS DECIMAL(10,2))
    END`;
}

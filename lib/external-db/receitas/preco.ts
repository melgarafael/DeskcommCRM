/**
 * Conversão robusta de meta_value / coluna (texto) para número no MySQL, sem
 * novo `?`. Aceita:
 *  - "650.000,00" (ponto = milhar, vírgula = decimal, formato brasileiro)
 *  - "480000" (número puro)
 *  - "650000.50" (ponto = decimal, 1-2 dígitos no fim)
 *  - "1.200.000" (pontos = milhar, sem vírgula)
 *
 * Regras (sem novo `?`):
 *  - (a) se há vírgula: ponto é milhar (tira), vírgula vira ponto decimal.
 *  - (b) senão, se há exatamente um ponto seguido de 1 ou 2 dígitos no fim:
 *      ponto é decimal.
 *  - (c) senão: tira todos os pontos (são milhar).
 *
 * `colunaReferencia` é a expressão já quotada da coluna de preço
 * (ex.: `mpreco.meta_value` no ACF, `carros`.`preco` na tabela-direta).
 */
export function precoNumero(colunaReferencia: string): string {
  return `
    CASE
      WHEN ${colunaReferencia} LIKE '%,%' THEN CAST(REPLACE(REPLACE(${colunaReferencia}, '.', ''), ',', '.') AS DECIMAL(10,2))
      WHEN ${colunaReferencia} REGEXP '[.][0-9]{1,2}$' THEN CAST(REPLACE(${colunaReferencia}, ',', '') AS DECIMAL(10,2))
      ELSE CAST(REPLACE(${colunaReferencia}, '.', '') AS DECIMAL(10,2))
    END`;
}

/**
 * Conversão robusta de meta_value / coluna (texto) para número no MySQL, sem
 * novo `?`. Aceita:
 *  - "650.000,00" (ponto = milhar, vírgula = decimal, formato brasileiro)
 *  - "480000" (número puro)
 *  - "650000.50" (ponto = decimal, 1-2 dígitos no fim)
 *  - "1.200.000" (pontos = milhar, sem vírgula)
 *  - "R$ 650.000,00" / "650.000 reais" (símbolo e texto são descartados)
 *
 * Regras (sem novo `?`):
 *  - (a) se há vírgula: ponto é milhar (tira), vírgula vira ponto decimal.
 *  - (b) senão, se há exatamente um ponto seguido de 1 ou 2 dígitos no fim:
 *      ponto é decimal.
 *  - (c) senão: tira todos os pontos (são milhar).
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
 * (ex.: `mpreco.meta_value` no ACF, `carros`.`preco` na tabela-direta).
 */
export function precoNumero(colunaReferencia: string): string {
  const limpo = `REGEXP_REPLACE(${colunaReferencia}, '[^0-9.,]', '')`;
  return `
    CASE
      WHEN ${limpo} NOT REGEXP '[0-9]' THEN NULL
      WHEN ${limpo} LIKE '%,%' THEN CAST(REPLACE(REPLACE(${limpo}, '.', ''), ',', '.') AS DECIMAL(10,2))
      WHEN ${limpo} REGEXP '[.][0-9]{1,2}$' THEN CAST(REPLACE(${limpo}, ',', '') AS DECIMAL(10,2))
      ELSE CAST(REPLACE(${limpo}, '.', '') AS DECIMAL(10,2))
    END`;
}

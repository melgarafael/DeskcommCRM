/**
 * O INTERVALO MÍNIMO POR CONTATO (#2974, fatia 2) — a leitura da chave
 * `repetir_apos_horas`, num lugar só.
 *
 * O motor decide a barreira com ela, e a tela mostra o que ela reconhece. É o
 * mesmo desenho de `config-do-silencio`/`config-ao-salvar`: duas cópias da mesma
 * régua divergem no primeiro conserto que só um lado recebe — e aqui a
 * divergência seria caríssima, porque a tela diria "24 h" para uma regra que o
 * motor lê como "sem intervalo" (ou o contrário).
 *
 * Módulo PURO de propósito: `engine.ts` é do servidor e `desenho-da-regra.ts`
 * entra no bundle do cliente. Um import do motor na tela arrastaria logger,
 * audit e cliente Supabase para o browser.
 */

/**
 * O TETO — 30 dias, em horas.
 *
 * Existe pelo mesmo motivo do teto de dias dos outros gatilhos: uma janela de
 * "8760 horas" é indistinguível de "nunca mais" para quem configurou, e a
 * diferença entre as duas fatias da issue precisa continuar visível na tela.
 */
export const HORAS_MAXIMAS_DO_INTERVALO = 720;

/** O `trigger_config` cru, como veio do banco (ou do formulário). */
type ComConfigDoGatilho = { trigger_config?: Record<string, unknown> | null };

/**
 * QUANTAS HORAS ESTA REGRA EXIGE ENTRE DUAS PASSAGENS DO MESMO CONTATO?
 *
 * `null` = sem intervalo, e é o desfecho de TUDO o que não seja um inteiro de 1
 * a 720: ausente, `null`, `"24"`, `0`, `-5`, `1.5`, `1000`.
 *
 * FAIL-OPEN do lado do MOTOR, ao contrário do `=== true` da opção de uma vez:
 * lá o valor torto DESLIGA uma opção que o operador ligou (por isso a API o
 * recusa na porta); aqui ele LIGARIA uma barreira que ninguém pediu, e uma
 * janela inventada calaria a regra para sempre sem deixar rastro. Quem gravou
 * torto (SQL, import, versão futura) continua com a automação rodando, e o
 * motor registra no log que a chave foi ignorada.
 *
 * Do lado da TELA, `null` vira campo vazio: o formulário não inventa um número
 * que ninguém digitou.
 */
export function horasDoIntervalo(rule: ComConfigDoGatilho): number | null {
  const bruto = rule.trigger_config?.repetir_apos_horas;
  if (typeof bruto !== "number" || !Number.isInteger(bruto)) return null;
  if (bruto < 1 || bruto > HORAS_MAXIMAS_DO_INTERVALO) return null;
  return bruto;
}

/**
 * A chave está lá, ainda que torta?
 *
 * Separa "não configurou" de "configurou errado": o motor só grita no log no
 * segundo caso, e o campo vazio da tela não faz barulho nenhum.
 */
export function intervaloConfigurado(rule: ComConfigDoGatilho): boolean {
  const bruto = rule.trigger_config?.repetir_apos_horas;
  return bruto !== undefined && bruto !== null;
}

/**
 * O CAMPO DA TELA → A CHAVE (`""` = sem intervalo), sem inventar `null`.
 *
 * Existe porque DOIS escritores montam o `trigger_config` do gatilho de contato
 * novo (o editor de hoje e o desenho novo): a regra de "vazio apaga, número
 * grava" tem de ser uma só, ou os dois caminhos divergem no primeiro conserto.
 *
 * Valor fora de 1..720 (ou não numérico) APAGA: gravar `1000` seria guardar uma
 * janela que o motor ignora, e o campo voltaria vazio ao reabrir — mentira com
 * atraso. O `input` da tela já limita a faixa; quem digitar por fora perde o
 * valor no salvar, e o PR declara essa lacuna.
 */
export function aplicarIntervaloNoConfig(
  config: Record<string, unknown>,
  texto: string,
): Record<string, unknown> {
  const horas = texto.trim() === "" ? Number.NaN : Number(texto);
  if (Number.isInteger(horas) && horas >= 1 && horas <= HORAS_MAXIMAS_DO_INTERVALO) {
    config.repetir_apos_horas = horas;
  } else {
    delete config.repetir_apos_horas;
  }
  return config;
}

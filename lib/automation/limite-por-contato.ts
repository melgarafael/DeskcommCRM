/**
 * AS DUAS RÉGUAS DO LIMITE POR CONTATO (#2974) — em UM lugar só.
 *
 * A issue pede duas coisas que hoje convivem no mesmo campo do `trigger_config`:
 *
 *   - `uma_vez_por_contato: true` — no máximo UMA execução por contato, para
 *     sempre (entregue na primeira fatia);
 *   - `repetir_apos_horas: N` — não repetir para o mesmo contato antes de N
 *     horas (1..720 = 30 dias). Esta fatia.
 *
 * Este módulo é PURO de propósito: o motor (`lib/automation/engine.ts`), o
 * desenho da regra (`lib/automation/desenho-da-regra.ts`) e a tela
 * (`RuleEditor.tsx`) leem a chave por AQUI. Duas leituras da mesma chave
 * divergem no primeiro conserto que só um lado recebe — foi assim que a tela
 * passou a dizer "ligado" enquanto o motor lia outra coisa.
 *
 * ─── A chave não é recusada pelo schema da API, é lida com cuidado ──────────
 * `trigger_config` é `z.record(z.string(), z.unknown())`: a chave nova entra
 * sem tocar no schema. O preço é que um valor torto (`"sim"`, `0`, `-5`,
 * `1.5`, `721`) pode chegar ao banco por SQL, import ou versão antiga. Nesse
 * caso a resposta é `null` — SEM intervalo, ou seja, FAIL-OPEN: a regra roda
 * como sempre rodou. Configuração quebrada não pode CALAR uma automação; o
 * mesmo veredito de `regraJaRodouParaOCntato` quando a consulta falha.
 */

/** O teto do intervalo: 30 dias. Acima disso a opção já é "quase nunca". */
export const INTERVALO_POR_CONTATO_MAX_HORAS = 720;

/** O piso: menos de uma hora é pacing de envio, não intervalo por contato. */
export const INTERVALO_POR_CONTATO_MIN_HORAS = 1;

/**
 * O intervalo, em horas, a partir do valor CRU da chave.
 *
 * `null` = não há intervalo configurado — ausente, `null`, ou valor que não
 * passa na régua (inteiro entre 1 e 720). Quem chama trata os dois casos
 * igual, e é isso que faz um valor torto falhar ABERTO.
 */
export function horasDoIntervalo(valor: unknown): number | null {
  if (typeof valor !== "number" || !Number.isInteger(valor)) return null;
  if (valor < INTERVALO_POR_CONTATO_MIN_HORAS || valor > INTERVALO_POR_CONTATO_MAX_HORAS) {
    return null;
  }
  return valor;
}

/**
 * O intervalo de um `trigger_config` inteiro.
 *
 * Existe para quem tem a configuração na mão (motor e tela) não precisar
 * repetir o `typeof`/array check da forma gravada.
 */
export function horasDoIntervaloNaConfig(config: unknown): number | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  return horasDoIntervalo((config as Record<string, unknown>).repetir_apos_horas);
}

/**
 * O N a GRAVAR, a partir do que a tela tem: o texto do campo e o checkbox.
 *
 * `null` = sem intervalo, e há três caminhos para chegar nele:
 *
 *   - campo vazio (o caso comum de quem não quer a opção);
 *   - texto que não é inteiro de 1 a 720 (`"1o"`, `"0"`, `"-5"`) — sai como
 *     ausência em vez de virar `NaN`/`null` no `trigger_config`, a mesma
 *     resposta FAIL-OPEN do motor;
 *   - "uma vez por contato" ligado: a tela não configura as duas, e é aqui que
 *     o intervalo deixa de ser gravado (o campo fica desabilitado, mas um valor
 *     guardado pela API poderia sobreviver por baixo do checkbox).
 *
 * A tela da gaveta (`RuleEditor`) e o desenho (`triggerConfigDaTela`) chamam
 * ESTA função: eram dois `Number(...)` iguais esperando para divergir.
 */
export function horasDoIntervaloDaTela(
  texto: string,
  umaVezPorContato: boolean,
): number | null {
  if (umaVezPorContato) return null;
  const limpo = texto.trim();
  if (!/^\d+$/.test(limpo)) return null;
  return horasDoIntervalo(Number(limpo));
}

/**
 * O `trigger_config` que a TELA grava ao salvar (issue #2483).
 *
 * ─── O defeito que isto conserta ─────────────────────────────────────────────
 *
 * O editor de regras reconstruía o objeto só com o que ele desenha — `dias`,
 * `direcao` e `proteger_pela_agenda`. As chaves que o MOTOR usa para recortar a
 * varredura (`pipeline_id` e `stage_id`, aceitas pela API e lidas pelo cron
 * `lead-time-triggers`) sumiam no primeiro "salvar" dado pela tela: a regra
 * deixava de valer para um funil e passava a valer para a organização inteira,
 * em silêncio — quem olha a tela não vê diferença, porque a tela não desenha
 * essas chaves.
 *
 * ─── Por que a herança é presa ao MESMO gatilho ──────────────────────────────
 *
 * Trocar o gatilho na tela troca o SIGNIFICADO das chaves (`dias` do silêncio
 * não é `dias` da data). Herdar o objeto de um gatilho para outro seria
 * inventar configuração que ninguém escolheu — por isso a guarda entrega só o
 * que a tela escolheu quando o gatilho mudou.
 *
 * Puro de propósito: a tela usa esta função e os testes batem nos casos de
 * borda sem renderizar React. O call site (o `onSubmit` do editor) é medido
 * pelo teste de componente irmão.
 */
export function configAoSalvarDaTela(entrada: {
  /** O `trigger_event` da regra carregada. Vazio/null em regra nova. */
  gatilhoDaRegra: string | null | undefined;
  /** O `trigger_config` cru da regra carregada, como veio do banco. */
  configDaRegra: unknown;
  /** O gatilho escolhido na tela agora. */
  gatilhoDaTela: string;
  /** O que a tela edita, com os valores atuais do formulário. */
  configDaTela: Record<string, unknown>;
}): Record<string, unknown> {
  const mesmoGatilho = !!entrada.gatilhoDaRegra && entrada.gatilhoDaRegra === entrada.gatilhoDaTela;
  const guardada = mesmoGatilho ? entrada.configDaRegra : null;
  // Configuração torta (string, lista, `null`) não derruba o salvar: a tela
  // grava o que ela conhece, e o defeito de origem segue visível na leitura.
  const base =
    guardada && typeof guardada === "object" && !Array.isArray(guardada)
      ? (guardada as Record<string, unknown>)
      : {};
  return { ...base, ...entrada.configDaTela };
}

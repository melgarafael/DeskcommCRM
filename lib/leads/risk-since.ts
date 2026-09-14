import { type RiskBucket, type StageWindow } from "@/lib/leads/risk-radar";

/**
 * DESDE QUANDO o negócio está NESTE estado — que não é "desde quando está em
 * silêncio", e a diferença decide se a coluna responde a alguma pergunta.
 *
 * O acervo entra com `since` no passado e `detected_at` em now (ver 0078). Se
 * `since` fosse `now`, o histórico diria para sempre que cinquenta negócios
 * esfriaram no mesmo minuto — dado falso nascendo junto com o mecanismo que
 * existe para não mentir.
 *
 * ⚠️ REFINO SOBRE O QUE FOI COMBINADO: o contrato dizia `since = last_activity_at`.
 * Isso responde "há quanto tempo está em SILÊNCIO"; a coluna promete "há quanto
 * tempo está NESTE ESTADO". Um negócio com janela de 72h e 100h de silêncio está
 * em risco há 28h, não há 100h — e é a primeira resposta que alguém quer ao
 * triar. Por isso o instante gravado é o do CRUZAMENTO do limiar. Reverter para
 * `last_activity_at` é uma linha, se o refino for recusado.
 *
 * O silêncio não se perde: `last_activity_at` continua no lead, e a diferença
 * entre as duas grandezas fica calculável. O contrário não valeria — de
 * `last_activity_at` sozinho não dá para reconstruir quando a janela mudou.
 */
export function sinceDoBucket(
  bucket: RiskBucket,
  lastActivityAt: Date,
  window: StageWindow,
  /**
   * O relógio da passada. OBRIGATÓRIO de propósito: opcional deixaria todo
   * chamador antigo no comportamento defeituoso, em silêncio.
   */
  agora: Date,
): Date {
  const h = (horas: number): Date =>
    new Date(lastActivityAt.getTime() + horas * 3_600_000);
  // ⛔ NUNCA NO FUTURO — e isto não escolhe um significado novo, escreve o que
  // já é verdade.
  //
  // `classifyRisk` tem dois atalhos da agenda (`adiar` e `presenca_vencida`)
  // que atribuem balde SEM limiar cruzado. Para esses, o instante do cruzamento
  // ainda não chegou, e gravá-lo violava `check (since <= detected_at)` — o que
  // derrubava o observador INTEIRO da organização, porque a gravação lançava
  // dentro do laço.
  //
  // E o upsert só roda quando o balde MUDOU (`risk-worker.ts`, `if (de ===
  // e.bucket) continue`). Uma travessia percebida agora começou, no mais
  // tardar, agora.
  const teto = (d: Date): Date => (d.getTime() > agora.getTime() ? agora : d);
  switch (bucket) {
    case "critico":
      return teto(h(window.criticalHours));
    case "em_risco":
    // `em_voo` é "esfriou, mas a IA prometeu voltar": ele CRUZOU o limiar de
    // frio como qualquer outro, e o que muda é haver follow-up agendado — não
    // o instante da travessia.
    case "em_voo":
      return teto(h(window.coldHours));
    case "em_dia":
      // Ainda não cruzou nada. O estado começou na última interação.
      return teto(lastActivityAt);
  }
}

/**
 * A hora local do envio — ARITMÉTICA, não texto de tela.
 *
 * A janela de envio e a saudação dependem de que horas são no fuso do NÚMERO, e
 * isso é um número de 0 a 23, não uma data que alguém lê. Por isso o idioma aqui
 * é `en-US` fixo: ele nunca aparece para ninguém, e usar o idioma de quem está
 * olhando faria a mesma campanha decidir diferente conforme quem abriu a tela.
 * (É também o que `lib/agent-engine/pacing/engine.ts` faz no `wallClock`.)
 *
 * `hourCycle: "h23"` e não `hour12: false`: os dois parecem iguais e não são —
 * `hour12: false` devolve "24" à meia-noite em várias versões do ICU, e "24 < 8"
 * é falso, então uma janela que começa às 8h deixaria passar envio à meia-noite.
 */
export function horaNoFuso(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: fuso,
  }).formatToParts(instante);
  return Number(partes.find((p) => p.type === "hour")?.value ?? "0");
}

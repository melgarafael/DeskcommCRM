/**
 * O FORMATO de um `voice_id` — e só o formato.
 *
 * A regra que este módulo NÃO implementa: "a voz existe". Um id fora do
 * catálogo é o caso normal de quem tem vozes próprias na conta ElevenLabs
 * (#4260, item 2) e o catálogo só lista o que a última validação da credencial
 * viu; recusar por não estar na lista é exatamente o defeito que esta entrega
 * conserta. Aqui só se separa um id de um texto colado errado ("minha voz",
 * dois ids, espaço no meio) — o bastante para a tela avisar antes de gastar
 * uma síntese, sem transformar lista em permissão.
 *
 * O alfabeto é o que a ElevenLabs usa de fato: base62 (`A-Za-z0-9`) e nada mais
 * nos ids atuais. `_`/`-` entram porque ids antigos e de vozes comunitárias não
 * têm garantia documentada, e recusar um id válido do cliente seria pior do que
 * aceitar um que o provedor vai recusar (e aí a mensagem dele chega à tela).
 */
export const PADRAO_VOICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** O que impede este valor de ser um `voice_id` — `null` quando o formato serve. */
export type ProblemaDoVoiceId = "vazio" | "formato";

export function problemaNoVoiceId(valor: string): ProblemaDoVoiceId | null {
  const id = valor.trim();
  if (id === "") return "vazio";
  return PADRAO_VOICE_ID.test(id) ? null : "formato";
}

/** O id como ele deve ser gravado: sem espaço acidental nas pontas. */
export function normalizarVoiceId(valor: string): string {
  return valor.trim();
}

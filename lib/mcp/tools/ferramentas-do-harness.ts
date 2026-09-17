/**
 * As capacidades do catálogo que o MOTOR do agente nunca monta num turno.
 *
 * Elas existem no catálogo — e continuam existindo, porque são contrato de wire
 * para quem integra por fora — mas quem as executa no atendimento automático é o
 * harness, não uma ferramenta do modelo:
 *
 *  - enviar é SEMPRE a tool `send_message` do engine, atrás da cadeia
 *    runBeforeSend (anti-ban, opt-out, disclosure — CLAUDE.md princípio 2);
 *  - escalar é SEMPRE a `request_human_handoff` do engine, com silêncio durável
 *    e cancelamento de follow-ups.
 *
 * Por que esta lista mora AQUI, e não dentro do engine: ela é DADO, não lógica
 * de motor. Enquanto viveu só em `lib/agent-engine/edge/crm/mcp-tools.ts`, a tela
 * não tinha como saber — e oferecia as duas como checkbox marcável no pacote
 * "Atender e responder". O dono marcava, salvava, via o agente publicado com a
 * capacidade ligada, e o engine a descartava: o único sinal era uma linha de
 * `log.warn` no log do worker, que ninguém abre. Capacidade marcada na tela e
 * descartada no turno é o modo de falha que este repo inteiro combate.
 *
 * Agora os dois lados leem esta lista: o engine (`BLOCKED_TOOL_IDS`) descarta, e
 * a tela (via `catalogo-servido.ts`) mostra sem deixar marcar, com o motivo
 * escrito. Uma segunda lista com um id digitado errado passaria no typecheck —
 * a mesma armadilha que `BUMP_DO_IMPACTO` já documentou no versionamento.
 *
 * CLIENT-SAFE: zero import de zod, supabase ou next/headers. A tela importa daqui.
 */

export interface FerramentaDoHarness {
  /** `name` da capacidade em `lib/mcp/tools/catalogo/`. */
  id: string;
  /** Por que o modelo não pode ter uma tool para isso — texto que vai à TELA. */
  motivo: string;
}

export const FERRAMENTAS_DO_HARNESS: ReadonlyArray<FerramentaDoHarness> = [
  {
    id: 'crm_send_whatsapp_message',
    motivo:
      'O agente já envia por conta própria, pelo caminho seguro do sistema — com opt-out e regra anti-ban aplicados. Não há nada a ligar aqui.',
  },
  {
    id: 'crm_request_human_handoff',
    motivo:
      'O agente já passa a conversa para uma pessoa pelo caminho seguro do sistema, que silencia o automático na hora. Não há nada a ligar aqui.',
  },
];

/**
 * Os ids, para quem só precisa recusar.
 *
 * `ReadonlySet` de propósito: o engine faz `has()` por turno, e um array aqui
 * seria uma varredura por tool montada, todo turno, para sempre.
 */
export const IDS_DO_HARNESS: ReadonlySet<string> = new Set(
  FERRAMENTAS_DO_HARNESS.map((f) => f.id),
);

/** O motivo que a tela mostra, ou `null` quando a capacidade é oferecível. */
export function motivoDoHarness(id: string): string | null {
  return FERRAMENTAS_DO_HARNESS.find((f) => f.id === id)?.motivo ?? null;
}

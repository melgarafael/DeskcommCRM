/**
 * A régua de "quem falou por último" do retomar ao devolver, PURA e sem
 * dependência de servidor: o consumidor do evento (`retomada-ao-devolver.ts`)
 * decide com ela, e o worker do agente (`followup-turn.ts`, modo `retomada`)
 * confere de novo com ELA MESMA na hora de rodar. Duas réguas viram, com o
 * tempo, duas respostas.
 *
 * "Humana" no vocabulário que o resto do produto já usa para separar gente de
 * máquina (o gatilho de `last_activity_at` no baseline): o Inbox do CRM e o
 * aparelho conectado. `ai`, `automation` e `system` não são a equipe falando.
 */
export const ENVIOS_DA_EQUIPE: ReadonlySet<string> = new Set(["user", "crm", "external_device"]);

export interface MensagemParaRegua {
  direction: string;
  sent_via: string | null;
}

export function eFalaDaEquipe(m: MensagemParaRegua): boolean {
  return m.direction === "outbound" && ENVIOS_DA_EQUIPE.has(m.sent_via ?? "");
}

/** A última mensagem da conversa é da equipe? `null` = conversa sem mensagem. */
export function ultimaFalaEDaEquipe(ultima: MensagemParaRegua | null | undefined): boolean {
  return ultima != null && eFalaDaEquipe(ultima);
}

/**
 * As falas da equipe desde a última mensagem que NÃO é dela, em ordem
 * cronológica. Recebe o histórico do MAIS NOVO para o mais antigo (a ordem da
 * consulta) e para no primeiro que não é da equipe.
 */
export function falasDaEquipeNoFim<T extends MensagemParaRegua>(maisNovaPrimeiro: readonly T[]): T[] {
  const falas: T[] = [];
  for (const m of maisNovaPrimeiro) {
    if (!eFalaDaEquipe(m)) break;
    falas.push(m);
  }
  return falas.reverse();
}

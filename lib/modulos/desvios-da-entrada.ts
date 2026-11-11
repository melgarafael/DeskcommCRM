/**
 * OS MÓDULOS OPCIONAIS QUE PODEM ASSUMIR UMA MENSAGEM DE ENTRADA.
 *
 * `aplicarEfeitosPosEntrada` (lib/channels/pos-entrada.ts) pergunta aqui, ANTES de
 * a conversa virar demanda no funil, se algum módulo toma a mensagem para si. O
 * núcleo não conhece módulo nenhum: conhece só esta lista. Módulo novo que precise
 * tirar mensagem do caminho comercial entra AQUI, nunca com um `if` lá.
 *
 * Cada desvio só roda com o módulo LIGADO na instalação, pelo mesmo memo de 30 s
 * do turno do agente (`moduloLigadoComMemo`): a instalação sem o módulo paga uma
 * leitura de memo por mensagem e segue o caminho de sempre.
 *
 * Contrato de cada `atender`: NUNCA lança (a mensagem já está gravada e a ingestão
 * não pode cair) e devolve `tratado: true` só quando a mensagem é do módulo — aí a
 * ingestão para: sem demanda, sem campanha, sem follow-up, sem despacho do agente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moduloLigadoComMemo, type ModuloOpcional } from "@/lib/instalacao/modulos";
import { atenderOuvidoriaNoWhatsApp, portasDaOuvidoria } from "@/lib/ouvidoria/whatsapp";

export interface MensagemDeEntrada {
  organizationId: string;
  conversationId: string;
  contactId: string;
  messageId: string | null;
  texto: string | null;
}

export interface DesvioDaEntrada {
  modulo: ModuloOpcional;
  atender(admin: SupabaseClient, mensagem: MensagemDeEntrada): Promise<{ tratado: boolean; motivo: string }>;
}

export const DESVIOS_DA_ENTRADA: readonly DesvioDaEntrada[] = [
  // #3611 (fatia 2): o relato da Ouvidoria pelo WhatsApp não vira card no funil.
  {
    modulo: "ouvidoria",
    atender: (admin, mensagem) =>
      atenderOuvidoriaNoWhatsApp(admin, mensagem, portasDaOuvidoria(admin, mensagem)),
  },
];

/** O módulo que assumiu a mensagem, ou `null` (o caminho de sempre segue). */
export async function moduloQueAssumeAEntrada(
  admin: SupabaseClient,
  mensagem: MensagemDeEntrada,
  desvios: readonly DesvioDaEntrada[] = DESVIOS_DA_ENTRADA,
): Promise<{ modulo: ModuloOpcional; motivo: string } | null> {
  for (const desvio of desvios) {
    if (!(await moduloLigadoComMemo(admin, desvio.modulo))) continue;
    const { tratado, motivo } = await desvio.atender(admin, mensagem);
    if (tratado) return { modulo: desvio.modulo, motivo };
  }
  return null;
}

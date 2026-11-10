/**
 * UM MODELO APROVADO, FORA DE QUALQUER CONVERSA — o envio de quem avisa a equipe.
 *
 * O caminho de modelo do produto é o do `sendMessageHandler`
 * (`app/api/v1/messages/_handler.ts`): ele confere a definição, escolhe o
 * transporte e grava a linha em `messages`. O aviso à equipe não pode gravar
 * linha nenhuma — ele não é atendimento, e uma conversa com o número da própria
 * equipe é exatamente o que o corte da ingestão existe para impedir
 * (`lib/escalacao/numero-interno-de-aviso.ts`). Por isso este módulo repete só
 * as DUAS primeiras metades daquele caminho, e na mesma ordem:
 *
 *   1. o pré-voo (`conferirDefinicao`): a definição desta conexão, aprovada, com
 *      os valores completos — um parâmetro faltando vira erro nosso com o nome
 *      dele, e não um `400` cru da plataforma;
 *   2. o transporte: o do adapter quando ele sabe falar modelo; senão, o do
 *      número oficial direto (`sendTemplateForSession`), com a credencial DA
 *      SESSÃO.
 *
 * Mora em `lib/channels/` porque escolher o transporte é pergunta sobre
 * provedor, e nenhuma feature pode fazê-la (`pnpm lint:channels`).
 *
 * **Lança** em qualquer desfecho que não seja sucesso — o mesmo contrato do
 * `envia` do transporte do aviso, onde falha é exceção e sucesso é não lançar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { conferirDefinicao } from "./conferir-definicao";
import { getAdapter } from "./index";
import { sendTemplateForSession } from "./meta/send-template-for-session";

export interface EnvioDeModeloDireto {
  organizationId: string;
  /** A conexão que envia — dona da definição e da credencial. */
  channelSessionId: string;
  provider: string;
  /** O identificador da conexão no provedor (`resolveSessionRef`). */
  sessionRef: string;
  /** O destinatário já resolvido pelo adapter (`resolveRecipient`). */
  to: string;
  name: string;
  language: string;
  values: Record<string, string>;
}

export async function enviarModeloDireto(
  db: SupabaseClient,
  envio: EnvioDeModeloDireto,
): Promise<{ externalId: string | null }> {
  const contrato = await conferirDefinicao(db, {
    organizationId: envio.organizationId,
    channelSessionId: envio.channelSessionId,
    name: envio.name,
    language: envio.language,
    values: envio.values,
  });

  const adapter = getAdapter(envio.provider as never);
  if (adapter.sendTemplate) {
    return adapter.sendTemplate({
      organizationId: envio.organizationId,
      sessionRef: envio.sessionRef,
      to: envio.to,
      name: envio.name,
      language: envio.language,
      values: envio.values,
      contrato,
    });
  }
  const externalId = await sendTemplateForSession(db, {
    organizationId: envio.organizationId,
    channelSessionId: envio.channelSessionId,
    sessionRef: envio.sessionRef,
    to: envio.to,
    name: envio.name,
    language: envio.language,
    values: envio.values,
  });
  return { externalId };
}

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * `contact.phone_added` — "o contato ganhou telefone" (#2812), para os caminhos
 * que NÃO passam pelo PATCH de contatos.
 *
 * ─── Por que existe (#3315) ─────────────────────────────────────────────────
 *
 * O gatilho nasceu no PATCH de contatos e, até aqui, só ele e a captura
 * automática (`lib/contacts/proposta-de-dado.ts`, #3283) emitiam. Os outros
 * quatro caminhos que preenchem o número de uma ficha VAZIA gravavam em
 * silêncio — e a regra "Quando um contato ganhar um telefone" simplesmente não
 * rodava por eles. O defeito é mudo: nenhuma tela mostra a regra que não rodou.
 *
 * ─── O contrato, que é o mesmo do handler de contatos ───────────────────────
 *
 * 1. DEPOIS da gravação, nunca antes: a regra que este evento dispara lê a ficha
 *    para decidir, e `checarGuardasDeContato` mata com `no_phone` (sem nova
 *    tentativa) quem chega sem número. Emitir antes entrega à regra um contato
 *    ainda vazio e o evento se perde sem erro, sem log e sem run.
 * 2. SÓ na transição de vazio para preenchido — quem já tinha número não
 *    "ganhou" nenhum. Quem decide isso é quem chama, e o critério é o UPDATE ter
 *    casado linha com `.is("phone_number", null)` no filtro.
 *
 * A grafia do payload é a MESMA de `app/api/v1/contacts/_handler.ts`
 * (`{ phone_number }`) — é o que a regra lê.
 */
export async function emitirTelefoneGanho(
  admin: SupabaseClient,
  p: {
    organizationId: string;
    contactId: string;
    /** O MESMO valor que a linha acabou de receber. */
    telefone: string;
    /** Qual caminho preencheu — vai em `metadata`, para o rastro dizer de onde veio. */
    origem: string;
  },
): Promise<void> {
  const { error } = await admin.rpc("emit_event", {
    p_event_type: "contact.phone_added",
    p_entity_kind: "contact",
    p_entity_id: p.contactId,
    p_payload: { phone_number: p.telefone },
    p_metadata: { origem: p.origem },
    p_organization_id: p.organizationId,
  });
  if (error) {
    // O número JÁ está na ficha: falhar aqui não desfaz a gravação que o evento
    // descreve, e derrubar uma ingestão de webhook por causa do rastro perderia
    // a MENSAGEM (o provider reentrega e o laço é do cliente). Rastro que falha
    // se registra no log; o defeito que este arquivo fecha é o SILÊNCIO.
    logger.error("[contact.phone_added] a emissão do telefone ganho falhou", {
      contact_id: p.contactId,
      origem: p.origem,
      detail: error.message,
    });
  }
}

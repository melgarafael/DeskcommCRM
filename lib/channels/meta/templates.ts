/**
 * Gestão das definições aprovadas no canal OFICIAL DIRETO — listar, criar,
 * editar e apagar pela tela (#3635 fatia 1).
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * O cliente da Cloud API sempre soube criar e editar modelo; a tela não
 * oferecia, e quem opera o canal oficial direto saía do CRM, criava no
 * Gerenciador do WhatsApp, esperava a aprovação e voltava para "Sincronizar".
 * Quem usa o canal de PARCEIRO já fazia tudo pela tela.
 *
 * O modelo pertence à CONTA (WABA), não ao tipo de conexão: por isso o caminho
 * é o mesmo `/{waba_id}/message_templates`, com o host da Meta e o token DESTA
 * sessão. A implementação das chamadas é a mesma do parceiro
 * (`lib/channels/templates-graph.ts`) — o que muda aqui é só a ponta.
 *
 * ─── A credencial é a da SESSÃO, e isso é o conserto ───────────────────────
 *
 * `resolveMetaCreds` resolve `(organization_id, meta_phone_number_id)` primeiro
 * e só cai no ambiente como piso de instalação de número único. Era esse o
 * caminho que já valia para `send`, `checkHealth` e para o "Sincronizar"; usá-lo
 * aqui é o que faz a tela de um número oficial gerenciar a conta DAQUELE número,
 * inclusive em coexistência, e não a do `.env`.
 *
 * ─── A WABA vem da MESMA sessão (isolamento) ───────────────────────────────
 *
 * `metaWabaDoNumero` lê `meta_waba_id` da linha da conexão, com o
 * `organization_id` no filtro. Sem isso, o id da conta viria de qualquer lugar —
 * corpo do pedido, ambiente — e uma organização alcançaria o modelo de outra.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { operacoesDeModelos, type CredencialDosModelos } from "../templates-graph";
import type { ChannelTenantScope } from "../types";
import { resolveMetaCreds } from "./credentials";
import { graphBaseUrl } from "./graph-base";
import { metaWabaDoNumero } from "./session";

type Escopo = ChannelTenantScope & { sessionRef: string };

/**
 * Organização + `sessionRef` (o `phone_number_id` deste canal) → conta e token.
 *
 * Os dois erros são nomeados e distintos porque a ação a tomar é diferente: sem
 * credencial é "reconecte o número"; sem WABA é "esta conexão não tem conta
 * gravada" (base anterior à 0144). Virar um "não deu" só faria o operador tentar
 * de novo.
 */
async function credencial(escopo: Escopo): Promise<CredencialDosModelos> {
  const admin = createAdminClient();
  const c = await resolveMetaCreds(admin, {
    organizationId: escopo.organizationId,
    phoneNumberId: escopo.sessionRef,
  });
  if (!c) {
    throw new Error("meta_modelo_sem_credencial: a conexão não tem token para gerenciar modelos.");
  }
  const wabaId = await metaWabaDoNumero(escopo.organizationId, escopo.sessionRef);
  if (!wabaId) {
    throw new Error("meta_modelo_sem_waba: a conexão não tem conta (WABA) gravada.");
  }
  return { wabaId, token: c.token };
}

export const metaCloudTemplateOps = operacoesDeModelos({
  // A base da Graph DESTA instalação, com a versão — o mesmo `graphBaseUrl()` que
  // `send`, `checkHealth` e o sync de modelos usam (#817).
  base: () => graphBaseUrl(),
  credencial,
  rotulo: "meta_template",
});

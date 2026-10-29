"use client";
/**
 * ABRIR UMA CONVERSA E ASSUMI-LA — um pedido só, numa implementação só (#3483).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * O painel "Iniciar conversa" do Inbox abre a conversa e pede o `claim` logo
 * depois: `expected_assignee: null` é o contrato de "assuma se estiver livre" —
 * o dono passa a ser quem clicou e o bot é silenciado na MESMA transação
 * (`fn_conversation_assign`, reason `claim`). Esse bloco morava inline no painel,
 * e quem quisesse a mesma coisa noutra tela teria de copiá-lo. Copiar garantiria
 * que, no dia em que a regra ganhasse um detalhe (o silêncio do bot e o dono
 * nascem juntos), uma das cópias ficasse velha em silêncio.
 *
 * O primeiro segundo consumidor é o "Salvar e iniciar conversa" do cadastro de
 * contato e de negócio (`components/contacts/NewContactDialog`,
 * `components/kanban/NewLeadDialog`), que o #3483 pede: quem cadastra e atende
 * não devia ter de sair para o Inbox, achar o contato de novo e clicar em
 * "Iniciar conversa".
 *
 * ─── Isto NÃO reimplementa permissão ───────────────────────────────────────
 *
 * O claim é o MESMO `POST /api/v1/conversations/[id]/claim` que o painel do
 * Inbox faz, e a rota que abre a conversa é a MESMA
 * `POST /api/v1/conversations/open-with-contact` que a tabela de Contatos, o
 * cartão do funil e o painel usam. Quem decide quem pode é o servidor: as duas
 * rotas exigem papel `agent` (viewer é leitura, spec 13 §4), e o RPC só assina a
 * conversa SEM dono — conversa de colega devolve zero linhas e ninguém perde
 * atendimento. Nada aqui afrouxa nada: uma tela nova entrando por esta função
 * herda exatamente as recusas que a tela antiga já dava.
 *
 * ─── Os desfechos, e por que nenhum deles esconde a conversa ────────────────
 *
 *  - assumiu: a conversa é sua;
 *  - 409: já tinha dono. O caso comum é a conversa FECHADA daquele número, que
 *    reabre com o dono antigo (fechar não solta o dono) — e o dono antigo pode
 *    ser você mesmo. Relê a conversa para dizer a verdade: se é sua, silêncio;
 *    se é de outra pessoa, nomeia quem;
 *  - outro erro: a conversa JÁ foi aberta, sem dono. Devolve `false` e mostra o
 *    erro — esconder a conversa aberta seria pior que mostrar que não deu para
 *    assumi-la. Quem chama decide o que fazer com o `false` (o painel do Inbox
 *    não manda a primeira mensagem; o cadastro segue para o Inbox).
 */
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

export interface ContextoDoClaim {
  /** Quem clicou — é ele quem vira dono da conversa livre. */
  userId: string;
  /** O `t` da tela: as frases saem no idioma de quem clicou. */
  t: (texto: string) => string;
}

/** O que a releitura precisa: só o dono, para dizer a verdade no 409. */
interface ConversaRelida {
  assigned_to_user_id?: string | null;
  assigned_to_user_name?: string | null;
}

/**
 * Assume a conversa recém-aberta SE ela estiver livre. Devolve `true` quando o
 * dono é (ou passou a ser) quem chamou.
 */
export async function assumirConversaAoAbrir(
  conversationId: string,
  { userId, t }: ContextoDoClaim,
): Promise<boolean> {
  try {
    await apiClient.post(`/api/v1/conversations/${conversationId}/claim`, {
      expected_assignee: null,
    });
    return true;
  } catch (err) {
    // Só o 409 é "já tinha dono" — e o dono pode ser você (a conversa fechada
    // reabre com o dono antigo). Qualquer outra recusa (papel, servidor, rede)
    // deixa a conversa SEM dono e com o bot ligado.
    if (!(err instanceof ApiError && err.status === 409)) {
      showApiError(err);
      return false;
    }
    const conversa = await apiClient
      .get<{ data: ConversaRelida }>(`/api/v1/conversations/${conversationId}`)
      .then((r) => r.data)
      .catch(() => null);
    const assumiu = conversa?.assigned_to_user_id === userId;
    if (!assumiu) {
      toast.info(
        `${t("A conversa neste número está com")} ${
          conversa?.assigned_to_user_name ?? t("outro atendente")
        }.`,
      );
    }
    return assumiu;
  }
}

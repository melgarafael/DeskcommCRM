"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { motivoDaFalhaDaMensagem } from "@/lib/inbox/motivo-da-falha";
import { randomId } from "@/lib/random-id";
import type { Message } from "@/lib/types/messaging";

type Vars = { id: string; conversationIdDestino: string };

/** O corpo de sucesso da rota: `ok(...)` embrulha a mensagem em `{ data }`. */
interface RespostaDoEncaminhamento {
  data: Message;
}

/**
 * A INTENÇÃO de encaminhar: qual mensagem, para qual conversa — e a chave de
 * idempotência que a representa no servidor.
 */
interface Intencao {
  /** `mensagemId:conversaDeDestino`, a identidade da intenção. */
  assinatura: string;
  /** A chave que vai no `Idempotency-Key` desta intenção. */
  chave: string;
  /** Já há um POST desta intenção em voo? Ver o bloqueio do segundo clique. */
  emVoo: boolean;
}

/**
 * Encaminhar uma mensagem para outra conversa (#2835).
 *
 * A tela NÃO manda o conteúdo: manda só `conversation_id` de destino — o texto
 * e/ou a mídia vêm da própria mensagem de origem, lidos no servidor por
 * `lib/inbox/encaminhar-mensagem`, que reusa o mesmo caminho de envio do Inbox.
 * Mandar o corpo daqui duplicaria a fonte da verdade (e deixaria a tela
 * encaminhar qualquer coisa que ela inventasse).
 *
 * ─── A chave de idempotência é ESTÁVEL POR INTENÇÃO (medido na tela) ────────
 *
 * O `apiClient` carimba `Idempotency-Key` em todo POST, mas sorteia uma chave
 * NOVA quando nenhuma vem (`lib/api/client.ts`: `opts.idempotencyKey ??
 * randomId()`). Encaminhar sem passar chave, portanto, entregava ao
 * `comIdempotencia` da rota duas chaves diferentes para o MESMO gesto: o duplo
 * clique virava dois POSTs e nasciam duas linhas com o mesmo
 * `forwarded_from_message_id` e duas bolhas no destino (1º clique e 2º com
 * 10 ms de diferença).
 *
 * O conserto é a chave ser ESTÁVEL enquanto a intenção for a mesma — e trocar
 * quando ela muda (mensagem ou destino novo), porque aí o encaminhamento é
 * outro e a resposta guardada da chave anterior seria a de um gesto que não é
 * este. É o mesmo padrão de `components/connections/ConnectionsClient.tsx`: um
 * `ref` que guarda a chave entre as tentativas.
 *
 * ─── O segundo clique é barrado ANTES do POST ──────────────────────────────
 *
 * `disabled={isPending}` da tela NÃO resolve: o estado de pendência só chega ao
 * botão depois do segundo clique, e os dois já foram disparados. A barreira tem
 * de ser síncrona, no mesmo `ref` que guarda a chave: o primeiro clique marca a
 * intenção como em voo, o segundo é descartado sem chamar `mutate`. Só o
 * `mutate` é barrado — o `mutateAsync` continua cru para quem quiser o
 * resultado na mão, e não é o caminho do diálogo.
 *
 * A intenção é zerada quando o diálogo fecha (`limparIntencao`) e depois de um
 * encaminhamento BEM-SUCEDIDO: um encaminhamento deliberado da mesma mensagem
 * para a mesma conversa, mais tarde, é intenção nova e tem de sair. Depois de
 * uma FALHA, ao contrário, a chave é mantida — repetir o POST depois de um erro
 * de rede é justamente o caso em que o servidor precisa reconhecer a repetição.
 */
export function useEncaminharMensagem() {
  const qc = useQueryClient();
  const t = useT();

  const intencao = useRef<Intencao | null>(null);

  /** A intenção atual — criando-a (com chave nova) quando ela muda. */
  const abrirIntencao = useCallback(({ id, conversationIdDestino }: Vars): Intencao => {
    const assinatura = `${id}:${conversationIdDestino}`;
    if (!intencao.current || intencao.current.assinatura !== assinatura) {
      intencao.current = { assinatura, chave: randomId(), emVoo: false };
    }
    return intencao.current;
  }, []);

  /** Zerar a intenção: o diálogo fechou, o próximo encaminhamento é outro. */
  const limparIntencao = useCallback(() => {
    intencao.current = null;
  }, []);

  const mutation = useMutation({
    mutationFn: (vars: Vars) =>
      apiClient.post<RespostaDoEncaminhamento>(
        `/api/v1/messages/${vars.id}/forward`,
        { conversation_id: vars.conversationIdDestino },
        { idempotencyKey: abrirIntencao(vars).chave },
      ),
    onSuccess: (resposta, vars) => {
      // O fio do DESTINO ganha a mensagem; a conversa de origem não muda. As
      // duas chaves são invalidadas de propósito — a lista precisa refletir o
      // preview novo na conversa que recebeu.
      qc.invalidateQueries({ queryKey: ["messages", vars.conversationIdDestino] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      // Encaminhamento concluído: a intenção morre aqui. Sem isto, encaminhar
      // DE NOVO a mesma mensagem para a mesma conversa reusaria a chave e o
      // servidor devolveria a resposta guardada — o segundo encaminhamento não
      // sairia.
      intencao.current = null;

      // A rota responde 201 nos DOIS desfechos: entregue e `failed` (canal
      // caído, sessão expirada, número banido — o envio marca a linha e devolve
      // o registro). Um 201 NÃO é sucesso de entrega, e a tela dizia "Mensagem
      // encaminhada." enquanto o destino não recebia nada: quem encaminhou fica
      // na conversa de origem e não vê o selo "Falhou" do fio de destino.
      const linha = resposta?.data;
      if (linha?.status === "failed") {
        toast.error(
          t("Não foi possível encaminhar: {motivo}").replace(
            "{motivo}",
            motivoDaFalhaDaMensagem(linha, t),
          ),
        );
        return;
      }
      toast.success(t("Mensagem encaminhada."));
    },
    onError: showApiError,
    onSettled: () => {
      // A intenção pode ter sido zerada no `onSuccess`; o que sai de voo é a
      // que estiver aqui.
      if (intencao.current) intencao.current.emVoo = false;
    },
  });

  /**
   * O clique de encaminhar, com a barreira do segundo clique.
   *
   * Marcar `emVoo` é SÍNCRONO e vem antes de todo o resto — é esta ordem que
   * faz o segundo clique de um duplo clique não virar um segundo POST.
   */
  const mutate = useCallback<typeof mutation.mutate>(
    (vars, opcoes) => {
      const atual = abrirIntencao(vars as Vars);
      if (atual.emVoo) return;
      atual.emVoo = true;
      mutation.mutate(vars, opcoes);
    },
    [mutation, abrirIntencao],
  );

  return { ...mutation, mutate, limparIntencao };
}

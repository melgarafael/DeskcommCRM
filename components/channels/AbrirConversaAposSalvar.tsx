"use client";
/**
 * ABRIR A CONVERSA DE QUEM ACABOU DE SER CADASTRADO (#3483).
 *
 * ─── Por que é um componente à parte, montado só quando precisa ─────────────
 *
 * O caminho usa três coisas de tela: a lista de canais (`useChannelSessions`,
 * uma leitura de rede), o `router` do Next e o `user` de quem clicou. Se o
 * formulário de cadastro chamasse isso no render, TODA tela que abre "Novo
 * contato" ou "Novo lead" — inclusive as que nunca usam o caminho novo —
 * passaria a pagar a leitura de canais e a exigir router/provider no teste.
 *
 * Montado sob demanda (`{alvo && <AbrirConversaAposSalvar alvo={alvo} />}`), o
 * efeito colateral só existe no clique que pediu a conversa. O formulário fica
 * exatamente o de antes para quem só quer cadastrar.
 *
 * ─── O caminho é o do Inbox, e continua sendo ───────────────────────────────
 *
 * `useConversaNovaComEscolhaDeCanal` (#2382) pergunta o canal quando a
 * organização tem mais de um número e faz o `POST open-with-contact`; depois
 * `assumirConversaAoAbrir` pede o MESMO claim do painel "Iniciar conversa"
 * (`expected_assignee: null` = "assuma se estiver livre"), o Inbox é
 * invalidado e a pessoa cai na conversa. Nenhuma permissão é decidida aqui: as
 * duas rotas exigem papel `agent` no servidor, e a recusa aparece na tela sem
 * navegar.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import {
  type AlvoDeConversa,
  useConversaNovaComEscolhaDeCanal,
} from "@/components/channels/SeletorDeCanalParaConversa";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { assumirConversaAoAbrir } from "@/lib/inbox/assumir-conversa-ao-abrir";

export function AbrirConversaAposSalvar({ alvo }: { alvo: AlvoDeConversa }) {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  /**
   * Um pedido por ALVO: re-render com o mesmo objeto não abre (nem reabre)
   * conversa, mas um alvo novo — outro contato cadastrado depois — abre. Um
   * `boolean` de "já disparei" perderia o segundo cadastro, porque o componente
   * continua montado entre um salvamento e outro.
   */
  const ultimoAlvo = useRef<AlvoDeConversa | null>(null);

  const { iniciarConversa, seletor } = useConversaNovaComEscolhaDeCanal({
    aoAbrir: async (conversationId) => {
      await assumirConversaAoAbrir(conversationId, { userId: user.id, t });
      // A lista do Inbox é o destino: sem invalidar, a conversa recém-nascida
      // não está nela quando a navegação chega.
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      router.push(`/app/inbox?id=${conversationId}`);
    },
  });

  useEffect(() => {
    if (ultimoAlvo.current === alvo) return;
    ultimoAlvo.current = alvo;
    void iniciarConversa(alvo);
  }, [alvo, iniciarConversa]);

  // O seletor de canal é o retorno do hook: fica `null` quando não há escolha,
  // e a conversa segue direto (o mesmo comportamento do painel do Inbox).
  return <>{seletor}</>;
}

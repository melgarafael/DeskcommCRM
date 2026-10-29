"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useAgentInbox, type AgentInboxItem } from "@/hooks/ai/useAgentInbox";
import { useT } from "@/hooks/i18n/useT";
import { destinosDaInterface } from "@/lib/navigation/interface";

const KIND_PROPOSTA_PRONTA = "proposta_pronta_para_revisao";

/**
 * C6 — aviso de proposta que se vê. Quando nasce um
 * `proposta_pronta_para_revisao` com o CRM aberto, um cartão fixo aparece no
 * canto inferior direito. A primeira carga só REGISTRA os ids — sem ela, todo
 * aviso antigo gritaria a cada F5. Mesmo gate de permissão do `AlertsBell`.
 *
 * ⚠️ O CARTÃO É A NOTIFICAÇÃO; o som e o celular são o PLUS, e moram no sino.
 * O som da organização toca por `useSonsDaCentral` (a regra de quais avisos
 * pedem gente é uma só, em `lib/notifications/sons-da-org.ts`) e o push chega
 * pelo `pushDoAvisoDaCentral`. Um sinal próprio aqui tocaria duas vezes para o
 * mesmo aviso, com um som que a organização não escolheu.
 *
 * ⚠️ O CARTÃO VIVE NUM PORTAL, E PORQUE ESTE COMPONENTE ESTÁ NO MEIO DELE.
 * Ele é montado dentro do `<header>` do `TopBar`, e o header tem
 * `backdrop-blur`: filtro, blur, transform, perspective, contain e
 * `will-change` criam BLOCO CONTAINING para os filhos, e a partir daí o
 * `position: fixed` do cartão passou a se posicionar em relação ao HEADER, não
 * à tela. Medido: o balão nascia colado no topo, cortado atrás da barra, e o
 * clique em "Dispensar" caía fora do que a pessoa via — o botão estava no
 * lugar, só não onde o olho estava. Nenhuma classe do cartão resolvia: o
 * problema era a ÁRVORE, e a árvore só se resolve tirando o cartão dela
 * (`createPortal` para `document.body`), como já faz o
 * `OrganizationTransitionProvider`.
 *
 * O portal só é criado DEPOIS de montado no cliente: `document.body` não
 * existe no servidor, e um `createPortal` no SSR derruba a página inteira.
 */
export function AvisoDePropostaEmDestaque() {
  const { user, activeOrg } = useAuth();
  if (
    !destinosDaInterface(
      activeOrg?.interface_settings,
      user.is_platform_admin && !user.support,
      activeOrg?.role ?? null,
    ).some((d) => d.href === "/app/ai/inbox")
  )
    return null;
  return <AvisoVisivel />;
}

function AvisoVisivel() {
  const t = useT();
  const { data } = useAgentInbox("open");
  const vistos = useRef<Set<string> | null>(null);
  const [dispensados, setDispensados] = useState<ReadonlySet<string>>(new Set());
  const [atual, setAtual] = useState<AgentInboxItem | null>(null);
  // `document.body` só existe depois que o componente montou no cliente.
  const [noCliente, setNoCliente] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNoCliente(true);
  }, []);
  const corpo = t("A IA preparou uma proposta. Confira antes de enviar.");

  useEffect(() => {
    const itens = data?.items ?? [];
    if (vistos.current === null) {
      vistos.current = new Set(itens.map((i) => i.id));
      return;
    }
    const registrados = vistos.current;
    const novo = itens.find((i) => i.kind === KIND_PROPOSTA_PRONTA && !registrados.has(i.id));
    for (const i of itens) registrados.add(i.id);
    if (!novo || dispensados.has(novo.id)) return;
    setAtual((anterior) => (anterior?.id === novo.id ? anterior : novo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dispensados]);

  // O aviso saiu da lista de abertos (resolveram ou reabriram em outra aba):
  // o cartão não pode ficar pendurado num aviso que já não está aberto.
  useEffect(() => {
    if (!atual || !data) return;
    if (!data.items.some((i) => i.id === atual.id)) setAtual(null);
  }, [atual, data]);

  if (!noCliente || !atual) return null;
  const destino = atual.destination.estado === "disponivel" ? atual.destination.href : "/app/ai/inbox";

  function dispensar(): void {
    if (!atual) return;
    const id = atual.id;
    setDispensados((antes) => new Set(antes).add(id));
    setAtual(null);
  }

  return createPortal(
    <div
      role="alert"
      data-testid="aviso-proposta-destaque"
      className="fixed right-4 bottom-4 z-50 w-80 max-md:bottom-[calc(var(--rodape-ocupado,0px)+1rem)] rounded-lg border border-border bg-card p-4 shadow-lg"
    >
      {/* O TÍTULO sai como veio — é linha de `agent_inbox_items`, com dado de
          gente (nome da proposta, do cliente). Mesma regra do AgentInboxList:
          nunca por t(). */}
      <p className="text-sm font-medium">{atual.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{corpo}</p>
      <div className="mt-3 flex gap-2">
        {/* Abrir É dispensar: quem atendeu o aviso não pode achá-lo de novo na
            próxima carga do polling, ainda com a proposta aberta na frente. */}
        <Button asChild size="sm">
          <Link href={destino} onClick={dispensar}>
            {t("Abrir proposta")}
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={dispensar} data-testid="aviso-proposta-dispensar">
          {t("Dispensar")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

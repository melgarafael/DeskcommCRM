/**
 * O ÍNDICE DA AJUDA DENTRO DO PRODUTO (issue #3567, fatia F1).
 *
 * ─── Por que é dado, e não JSX ─────────────────────────────────────────────
 *
 * Tudo aqui é verificável sem renderizar React: cada `href` interno tem de
 * existir em `app/app/**` (uma tela renomeada deixaria o link morto em
 * silêncio) e todo texto tem de ter espanhol no dicionário — o teste
 * `tests/unit/ajuda-leva-a-telas-que-existem` cobra os dois. Conteúdo escrito
 * direto no JSX não teria como ser cobrado sem abrir a tela.
 *
 * ─── Por que SEM prosa longa, e por que SEM link externo ───────────────────
 *
 * F1 é o ÍNDICE, não a enciclopédia: cada item responde "onde eu clico" e leva
 * para a tela onde a dúvida acontece. O texto longo — com capturas, passo a
 * passo e versão — é a fatia F3, e vai morar em markdown versionado.
 *
 * Link para os guias públicos ficou de fora de propósito, por duas razões
 * medidas: `deskcomm.com.br/en/guias` responde 404 hoje (o guia em inglês não
 * existe), e a varredura de marca de `tests/unit/branding.test.ts` cobre
 * `lib/`, então escrever o domínio aqui criaria uma dívida de whitelabel para
 * resolver um link que a F3 vai substituir por conteúdo local.
 *
 * ─── A audiência do instalador é o platform admin ──────────────────────────
 *
 * `/app/settings/atualizacao` está na allowlist de navegação justamente porque
 * o papel que a usa (`is_platform_admin`, o dono do servidor) não é modelado
 * pelo catálogo de menus. Aqui ele é: o bloco inteiro só aparece para quem tem
 * a linha em `platform_admins`.
 */

import type { NavMetadata } from "@/lib/navigation/catalogo";

export interface ItemDeAjuda {
  /** Texto do link. É a CHAVE do dicionário — o português é a chave. */
  texto: string;
  /** Rota interna (`/app/...`). O teste confere que a tela existe. */
  href: string;
  /** Uma linha dizendo QUANDO procurar isto — não o que a tela é. */
  detalhe: string;
}

export interface BlocoDeAjuda {
  titulo: string;
  itens: readonly ItemDeAjuda[];
  /** Só aparece para o dono do servidor (`platform_admins`). */
  soParaQuemInstala?: boolean;
}

export const BLOCOS_DE_AJUDA: readonly BlocoDeAjuda[] = [
  {
    titulo: "Começar a usar",
    itens: [
      {
        texto: "Abrir as conversas",
        href: "/app/inbox",
        detalhe: "As conversas de todos os canais num lugar só, e quem está esperando você.",
      },
      {
        texto: "Mover um negócio no funil",
        href: "/app/kanban",
        detalhe: "Em que etapa cada oportunidade está e o que falta para fechar.",
      },
      {
        texto: "Cadastrar quem fala com você",
        href: "/app/contacts",
        detalhe: "O histórico da pessoa, as etiquetas e o consentimento dela.",
      },
      {
        texto: "Conectar um canal",
        href: "/app/connections",
        detalhe: "Por onde as mensagens entram: WhatsApp, Instagram e os demais canais.",
      },
    ],
  },
  {
    titulo: "Agente de IA",
    itens: [
      {
        texto: "Criar ou ajustar um agente",
        href: "/app/ai/agents",
        detalhe: "O que ele responde, quando passa para uma pessoa e com que informação decide.",
      },
      {
        texto: "Ensinar o que ele deve saber",
        href: "/app/ai/knowledge/sources",
        detalhe: "Os documentos e páginas que alimentam as respostas dele.",
      },
      {
        texto: "Ver onde ele não deu conta",
        href: "/app/ai/cases",
        detalhe: "As conversas em que a IA pediu ajuda — é daí que sai a correção.",
      },
    ],
  },
  {
    titulo: "Sua empresa",
    itens: [
      {
        texto: "Chamar a equipe",
        href: "/app/team",
        detalhe: "Quem trabalha aqui, com qual papel e quanta conversa cada um aguenta.",
      },
      {
        texto: "Renomear as etapas e criar campos",
        href: "/app/settings/tenant/pipelines",
        detalhe: "O vocabulário que a sua operação usa, no lugar do padrão.",
      },
    ],
  },
  {
    titulo: "Para quem instala e mantém",
    soParaQuemInstala: true,
    itens: [
      {
        texto: "Atualizar esta instalação",
        href: "/app/settings/atualizacao",
        detalhe: "A versão que roda aqui, a que já existe e o que muda ao atualizar.",
      },
    ],
  },
];

/** Os atalhos regulares são uma projeção da MESMA interface do menu. A porta
 * de instalação tem o gate próprio da página, fora do catálogo do tenant. */
export function blocosVisiveis(
  ehDonoDoServidor: boolean,
  destinos: readonly Pick<NavMetadata, "href">[],
): readonly BlocoDeAjuda[] {
  const visiveis = new Set(destinos.map((destino) => destino.href));
  return BLOCOS_DE_AJUDA.flatMap((bloco) => {
    if (bloco.soParaQuemInstala) return ehDonoDoServidor ? [bloco] : [];
    const itens = bloco.itens.filter((item) => visiveis.has(item.href));
    return itens.length ? [{ ...bloco, itens }] : [];
  });
}

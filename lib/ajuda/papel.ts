/**
 * A AJUDA DIZ O QUE O PAPEL PODE FAZER (issue #3567, fatia F2).
 *
 * ─── Por que existe, se o índice já filtra por papel ──────────────────────
 *
 * `blocosVisiveis` (lib/ajuda/hub.ts) mostra os atalhos que a PESSOA alcança —
 * bom para "onde eu clico", mudo para "o que eu posso aqui". Quem entra como
 * `viewer` vê o Inbox na lista e não sabe se pode responder, assumir ou só
 * olhar; quem é `agent` não sabe que configurar o agente é do `manager`. A
 * dúvida não é sobre a tela, é sobre o próprio alcance — e ela acontece antes
 * de qualquer clique.
 *
 * ─── Cada frase tem de ser conferível ─────────────────────────────────────
 *
 * Todo poder aponta para a rota do catálogo que o sustenta (`href`). O vínculo
 * é pelo `href`, nunca por número de linha: linha fixa do catálogo envelhece a
 * cada tela nova. O teste `tests/unit/ajuda-diz-o-que-o-papel-pode` cobra duas
 * coisas, e é o que impede esta lista de virar FAQ inventado:
 *
 *   1. `poderes` só citam telas cujo `minRole` o papel REALMENTE alcança;
 *   2. `limites` só citam telas que o papel realmente NÃO alcança — o
 *      contrário seria esconder do usuário algo que ele pode abrir.
 *
 * Na tela, os `poderes` ainda passam pelo MESMO filtro do índice
 * (`destinosDaInterface`): porta que a empresa escondeu do menu não vira
 * atalho aqui.
 *
 * ─── `ai_operator` NÃO aparece ────────────────────────────────────────────
 *
 * Ele é o papel do AGENTE PUBLICADO, não de uma pessoa: existe só no token
 * efêmero e nunca em `user_organizations` (`lib/auth/types.ts:9`). Uma seção
 * "o que o seu papel pode fazer" para ele seria uma tela que ninguém abre.
 *
 * ─── Sem versão aqui, de propósito ────────────────────────────────────────
 *
 * Datar artigo é a fatia F4 e está no PR #3863 (`desde` por item do hub). Esta
 * fatia não duplica aquele campo: aqui o texto descreve o alcance do papel, que
 * muda quando muda o catálogo — e o teste acima reprova a divergência.
 */

import type { Role } from "@/lib/auth/types";

/** Um poder (ou um limite) do papel, preso à tela do catálogo pelo `href`. */
export interface PoderDoPapel {
  /** Texto do item. É a CHAVE do dicionário — o português é a chave. */
  texto: string;
  /** Rota do catálogo que sustenta a frase. O teste confere o `minRole` dela. */
  href: string;
}

export interface AjudaDoPapel {
  papel: Exclude<Role, "ai_operator">;
  /** O alcance do papel em uma linha. */
  resumo: string;
  poderes: readonly PoderDoPapel[];
  /** O que o papel não abre — para a pessoa parar de procurar. */
  limites: readonly PoderDoPapel[];
}

/**
 * Os destinos citados. O `minRole` de cada um mora no catálogo
 * (`lib/navigation/catalogo.ts`), na entrada com o mesmo `href` — é por ele que
 * o teste confere o papel.
 */
const DESTINO = {
  inbox: {
    texto: "Ver as conversas e quem está esperando",
    href: "/app/inbox",
  },
  kanban: {
    texto: "Acompanhar os negócios no quadro",
    href: "/app/kanban",
  },
  contatos: {
    texto: "Consultar contatos e o histórico deles",
    href: "/app/contacts",
  },
  equipe: {
    texto: "Ver a equipe e a disponibilidade",
    href: "/app/team",
  },
  casos: {
    texto: "Ver onde a IA pediu ajuda",
    href: "/app/ai/cases",
  },
  agentes: {
    texto: "Criar ou ajustar o agente de IA",
    href: "/app/ai/agents",
  },
  conhecimento: {
    texto: "Ensinar o que o agente deve saber",
    href: "/app/ai/knowledge/sources",
  },
  etapas: {
    texto: "Renomear etapas e criar campos",
    href: "/app/settings/tenant/pipelines",
  },
  conexoes: {
    texto: "Conectar um canal",
    href: "/app/connections",
  },
} as const satisfies Record<string, PoderDoPapel>;

/** O que TODO papel humano enxerga — por isso é a base, não uma repetição. */
const ACOMPANHA = [DESTINO.inbox, DESTINO.kanban, DESTINO.contatos, DESTINO.equipe];

export const AJUDA_POR_PAPEL: Record<
  Exclude<Role, "ai_operator">,
  AjudaDoPapel
> = {
  // `minRole` do catálogo ausente = `viewer`: a tela abre para qualquer membro.
  viewer: {
    papel: "viewer",
    resumo: "Acompanha o que a equipe já fez. Não configura a operação.",
    poderes: ACOMPANHA,
    limites: [DESTINO.agentes, DESTINO.etapas, DESTINO.conexoes],
  },
  // O Atendente ganha os casos em que a IA passou para uma pessoa.
  agent: {
    papel: "agent",
    resumo: "Atende no Inbox e responde o que está na fila.",
    poderes: [...ACOMPANHA, DESTINO.casos],
    limites: [DESTINO.agentes, DESTINO.etapas, DESTINO.conexoes],
  },
  // O Gerente monta o agente e ajusta o vocabulário da operação.
  manager: {
    papel: "manager",
    resumo: "Além de atender, monta o agente e ajusta o vocabulário da operação.",
    poderes: [
      ...ACOMPANHA,
      DESTINO.casos,
      DESTINO.agentes,
      DESTINO.conhecimento,
      DESTINO.etapas,
    ],
    limites: [DESTINO.conexoes],
  },
  // O Administrador alcança tudo dentro da empresa; os limites dele são de
  // PLATAFORMA (atualizar a instalação), que não é papel de tenant.
  admin: {
    papel: "admin",
    resumo: "Responde pela empresa inteira, inclusive pelos canais de entrada.",
    poderes: [
      ...ACOMPANHA,
      DESTINO.casos,
      DESTINO.agentes,
      DESTINO.conhecimento,
      DESTINO.etapas,
      DESTINO.conexoes,
    ],
    limites: [],
  },
};

/**
 * O bloco do papel de quem está olhando. `null` quando não há papel (instalação
 * sem vínculo), quando o papel é `ai_operator` (papel de máquina) ou quando o
 * banco devolve um papel que este arquivo não conhece — degradar para "nada" é
 * melhor que prometer o que ninguém conferiu.
 */
export function ajudaDoPapel(papel: Role | string | null | undefined): AjudaDoPapel | null {
  if (!papel || papel === "ai_operator") return null;
  return (AJUDA_POR_PAPEL as Record<string, AjudaDoPapel>)[papel] ?? null;
}

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
  /**
   * A versão em que este artigo passou a valer (#3567, F4).
   *
   * Obrigatório de propósito: um artigo novo sem marca é o defeito que esta
   * fatia fecha, e o typecheck reprova antes de alguém escrevê-lo. A catraca de
   * `tests/unit/ajuda-versao-do-artigo` cobra o mesmo em tempo de execução, para
   * o caso que o tipo não alcança (`as ItemDeAjuda[]` num dado montado à mão).
   *
   * O valor é MEDIDO, não escolhido: é a primeira tag do repositório que contém
   * o commit que escreveu este texto (`git tag --contains <sha> | sort -V |
   * head -1`) — conferida para o hub em v1.97.0. A idade da TELA não serve:
   * `/app/kanban` existe desde antes, mas o artigo que ensina a usá-la nasceu
   * depois, e prometê-lo para uma instalação de 1.90 seria a mesma afirmação
   * não conferida que a issue descreve.
   */
  desde: string;
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
        desde: "1.97.0",
      },
      {
        texto: "Mover um negócio no funil",
        href: "/app/kanban",
        detalhe: "Em que etapa cada oportunidade está e o que falta para fechar.",
        desde: "1.97.0",
      },
      {
        texto: "Cadastrar quem fala com você",
        href: "/app/contacts",
        detalhe: "O histórico da pessoa, as etiquetas e o consentimento dela.",
        desde: "1.97.0",
      },
      {
        texto: "Conectar um canal",
        href: "/app/connections",
        detalhe: "Por onde as mensagens entram: WhatsApp, Instagram e os demais canais.",
        desde: "1.97.0",
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
        desde: "1.97.0",
      },
      {
        texto: "Ensinar o que ele deve saber",
        href: "/app/ai/knowledge/sources",
        detalhe: "Os documentos e páginas que alimentam as respostas dele.",
        desde: "1.97.0",
      },
      {
        texto: "Ver onde ele não deu conta",
        href: "/app/ai/cases",
        detalhe: "As conversas em que a IA pediu ajuda — é daí que sai a correção.",
        desde: "1.97.0",
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
        desde: "1.97.0",
      },
      {
        texto: "Renomear as etapas e criar campos",
        href: "/app/settings/tenant/pipelines",
        detalhe: "O vocabulário que a sua operação usa, no lugar do padrão.",
        desde: "1.97.0",
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
        desde: "1.97.0",
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

/** Todos os artigos do hub, sem os blocos no meio. A catraca de versão anda por
 * esta lista: um artigo novo entra nela no dia em que é escrito, sem ninguém
 * lembrar de atualizar o teste. */
export const ARTIGOS_DE_AJUDA: readonly ItemDeAjuda[] = BLOCOS_DE_AJUDA.flatMap(
  (bloco) => bloco.itens,
);

/**
 * ─── COMPARAÇÃO DE VERSÃO: TOLERANTE, E SEM DEPENDÊNCIA NOVA ───────────────
 *
 * A comparação é a MESMA pergunta da tela de atualização ("esta instalação já
 * tem o que o artigo ensina?") e por isso NÃO é semver estrito: as versões que
 * chegam aqui vêm de tags (`v1.97.0`) e de uma instalação que pode estar fora
 * de release (SHA). As tolerâncias, uma a uma, com o que cada uma evita:
 *
 *  - `v` na frente: a tag do repo é `v1.97.0` e a resposta da rota pode vir com
 *    ou sem ele, dependendo de quem a preencheu. Recusar por isso marcaria
 *    nada ou tudo, dependendo do caminho.
 *  - versão incompleta (`1.90`): dizer "1.90" é dizer 1.90.0. A alternativa é
 *    recusar a comparação e a instalação ficar sem aviso — o defeito silencioso.
 *  - sufixo de pré-release/desenvolvimento (`1.93.0-rc.1`, `1.93.0+jmpo.1`): a
 *    POSIÇÃO de release é a do núcleo numérico; comparar o sufixo pediria uma
 *    régua de semver que o projeto não tem, e o repo carrega tags de fork
 *    (`v1.1.1-jmpo.1` — a mesma armadilha documentada em `lib/system/changelog`).
 *  - o que NÃO é versão (SHA, texto): `null`, nunca `0`. Devolver zero faria
 *    "abc1234" empatar com tudo, e a tela marcaria artigo nenhum (ou todos) com
 *    a autoridade de quem conferiu.
 */

/** Os números de uma versão, ou `null` quando o texto não é versão legível. */
export function numerosDaVersao(versao: string | null | undefined): readonly number[] | null {
  const limpa = (versao ?? "").trim().replace(/^v/i, "");
  if (!limpa) return null;
  // `split` no primeiro `-`/`+` e não em regex de semver: o núcleo é o que
  // posiciona a versão, e é o único pedaço que este produto compara.
  const nucleo = limpa.split(/[-+]/)[0] ?? "";
  const partes = nucleo.split(".");
  if (partes.some((parte) => !/^\d+$/.test(parte))) return null;
  return partes.map(Number);
}

/** `-1` se `a` < `b`, `0` se iguais, `1` se `a` > `b`; `null` se ilegível. */
export function compararVersoes(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const na = numerosDaVersao(a);
  const nb = numerosDaVersao(b);
  if (!na || !nb) return null;
  const tamanho = Math.max(na.length, nb.length);
  for (let i = 0; i < tamanho; i++) {
    // Ausente é zero: `1.90` e `1.90.0` são a MESMA versão, e é isso que a
    // instalação de quem nunca atualizou devolve.
    const da = na[i] ?? 0;
    const db = nb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * A instalação é ANTERIOR ao artigo? Só quando as duas versões são legíveis.
 *
 * `false` para versão desconhecida é a decisão que importa: ausência de versão
 * não é prova de atraso. Marcar o artigo nesse caso seria afirmar o que não se
 * conferiu — exatamente o defeito desta fatia, do outro lado da tela.
 */
export function instalacaoAnteriorAoArtigo(
  versaoInstalada: string | null | undefined,
  desde: string,
): boolean {
  return compararVersoes(versaoInstalada, desde) === -1;
}

/** A versão como a tela fala: `v1.97.0` → `1.97.0`. */
export function rotuloDaVersao(versao: string): string {
  return versao.trim().replace(/^v/i, "");
}

/**
 * A CATRACA: artigo sem versão legível. Devolve os textos dos culpados, porque
 * a mensagem de falha precisa nomear o artigo que alguém esqueceu de marcar —
 * "faltou a versão" sem dizer qual é um teste que obriga a abrir o arquivo.
 */
export function artigosSemVersao(itens: readonly ItemDeAjuda[]): string[] {
  return itens
    .filter((item) => !item.desde?.trim() || numerosDaVersao(item.desde) === null)
    .map((item) => item.texto);
}

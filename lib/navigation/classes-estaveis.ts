/**
 * O CONTRATO DE CLASSES ESTÁVEIS DO MENU LATERAL (#4463, item 2).
 *
 * ─── Por que ele existe ─────────────────────────────────────────────────────
 *
 * O CSS personalizado de `/admin/marca` só aceita seletor de CLASSE
 * (`SELETOR_VISUAL` em `lib/branding/css-personalizado.ts`) — e o menu não tinha
 * nenhuma: o grupo era `<div className="space-y-1">` e o item, um `<Link>` sem
 * identidade. O único gancho era `id="nav-grupo-…"`, que o validador recusa de
 * propósito (id é global e colide com o resto da página).
 *
 * ─── O que é contrato, e o que não é ────────────────────────────────────────
 *
 * As classes daqui são API PÚBLICA para quem escreve CSS na tela Marca: mudar
 * um nome quebra a personalização de clientes, então isso é decisão de produto —
 * não refatoração. A lista é FECHADA e derivada do catálogo: grupo sai de
 * `group.id`, item sai de `href`, e `tests/unit/menu-classes-estaveis.test.tsx`
 * reprova grupo ou destino novo que escape dela.
 *
 * O que NÃO entra no contrato: cor, layout e qualquer classe utilitária do
 * Tailwind. Aquelas mudam com o design; estas existem só para dar um alvo
 * estável ao CSS do cliente.
 */
import { NAV_CATALOG, NAV_GROUPS, type NavGroupId } from "./catalogo";
import { classeDaSecaoDoGrupo } from "./secoes-da-tela";

export { CLASSE_DA_SECAO, CLASSES_DE_SECAO } from "./secoes-da-tela";

/** Uma classe por grupo do menu — o alvo de `.nav-grupo-crm .rounded-md:hover`. */
export const CLASSES_DE_GRUPO: Readonly<Record<NavGroupId, string>> = Object.freeze({
  atendimento: "nav-grupo-atendimento",
  crm: "nav-grupo-crm",
  ia: "nav-grupo-ia",
  canais: "nav-grupo-canais",
  analise: "nav-grupo-analise",
  organizacao: "nav-grupo-organizacao",
  // O grupo GERADO "Módulos" (Spec 33, F4): só aparece no menu quando a organização tem módulo
  // conectado ativo, e então leva a mesma convenção dos outros grupos.
  modulos: "nav-grupo-modulos",
});

const PREFIXO_DO_ITEM = "nav-item-";

/**
 * `/app/ai/cases` → `nav-item-ai-cases`.
 *
 * O prefixo `/app/` sai porque é igual em todo destino e só gastaria seletor; o
 * resto vira kebab-case para caber na allowlist do validador
 * (`[A-Za-z_][A-Za-z0-9_-]*`).
 */
export function classeDoItem(href: string): string {
  const caminho = href.replace(/^\/app\/?/, "").replace(/\/+$/, "");
  const slug = caminho
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${PREFIXO_DO_ITEM}${slug}`;
}

/**
 * A classe do ITEM DA TELA ABERTA — `nav-item-ativo`.
 *
 * Ela existe porque o item aberto é o único do menu que já tem fundo na cor de
 * destaque. Quem pinta o menu por `.nav-grupo-crm .rounded-md:hover` acerta nele
 * também, e a cor de texto escolhida para o fundo do menu some sobre o fundo de
 * destaque — é literalmente o "sem quebrar o contraste" do título da #4463.
 *
 * O único marcador que existia era `aria-current="page"`, e atributo é o que o
 * validador de `/admin/marca` recusa de propósito; `:not()` também não está na
 * allowlist de pseudo-classes. Sem uma CLASSE, o dono não tinha como dar cor ao
 * item aberto NEM como tirá-lo de uma regra do grupo — a doc só sabia recomendar
 * `text-muted-foreground`, que é utilitária do Tailwind e muda com o design.
 *
 * O nome NÃO colide com nenhum destino: `classeDoItem` sempre carrega o slug do
 * `href` depois do prefixo, e nenhuma rota se chama "ativo".
 */
export const CLASSE_DO_ITEM_ATIVO = "nav-item-ativo";

export function classeDoGrupo(id: NavGroupId): string {
  return CLASSES_DE_GRUPO[id];
}

/**
 * O mapa href → classe de TODOS os destinos do catálogo E dos hubs dos grupos,
 * montado uma vez.
 *
 * Serve à régua (unicidade e forma) e a quem precisa do nome sem renderizar o
 * menu. O componente deriva a classe de `classeDoItem(item.href)` para valer
 * também para destino que ainda não está no catálogo (item futuro).
 *
 * Os HUBS entram porque são destino como qualquer outro — e são a ÚNICA porta de
 * três grupos (CRM, IA, Análise), então ficar de fora do mapa era a diferença
 * entre "o contrato promete" e "o menu desenha" (#4463). O `Object.fromEntries`
 * deduplica href repetido (o hub de Organização é `/app/settings`, que pode
 * também estar no catálogo) sem mudar o valor: `classeDoItem` é pura.
 */
export const CLASSES_DE_ITEM: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [
      ...NAV_CATALOG.map((destino) => destino.href),
      ...NAV_GROUPS.flatMap((grupo) => (grupo.hub ? [grupo.hub.href] : [])),
    ].map((href) => [href, classeDoItem(href)]),
  ),
);

/**
 * A ROTA ATUAL → a classe da seção dela (#4705) — a única regra, nada por tela.
 *
 * A régua de "em qual destino estou" é a MESMA que o menu usa para pintar o item
 * ativo (`components/shell/Sidebar.tsx`): `caminho === href || caminho.startsWith(href + "/")`.
 * Quando mais de um destino casa, vence o href MAIS LONGO: `/app/ai/cases` é a
 * tela de casos, não o hub `/app/ai`, e `tela-secao-ia` sai igual nos dois porque
 * o grupo é o mesmo.
 *
 * Os HUBS dos grupos (`NAV_GROUPS[].hub`: `/app/crm`, `/app/ai`, `/app/analise`,
 * `/app/settings`) também são candidatos: o menu os pinta como do grupo, e as
 * subtelas de `/app/settings` fora do catálogo (`/app/settings/atualizacao`, etc.) caem no
 * hub pela mesma régua do href mais longo.
 *
 * Rota fora do registro (tela solta, onboarding) devolve `null`:
 * o `<main>` fica só com `tela-secao`, como a issue pede — inventar uma seção a
 * partir do primeiro segmento daria nomes que nenhum cliente conhece.
 */
export function classeDaSecao(pathname: string): string | null {
  const caminho = pathname.replace(/\/+$/, "") || "/";
  const candidatos = [
    ...NAV_CATALOG.map((destino) => ({ href: destino.href, grupo: destino.group })),
    ...NAV_GROUPS.flatMap((grupo) =>
      grupo.hub ? [{ href: grupo.hub.href, grupo: grupo.id }] : [],
    ),
  ];
  let casado: { href: string; grupo: NavGroupId } | null = null;
  for (const candidato of candidatos) {
    if (caminho !== candidato.href && !caminho.startsWith(`${candidato.href}/`)) continue;
    if (casado === null || candidato.href.length > casado.href.length) casado = candidato;
  }
  return casado ? classeDaSecaoDoGrupo(casado.grupo) : null;
}

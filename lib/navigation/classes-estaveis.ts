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
import { NAV_CATALOG, type NavGroupId } from "./catalogo";

/** Uma classe por grupo do menu — o alvo de `.nav-grupo-crm .rounded-md:hover`. */
export const CLASSES_DE_GRUPO: Readonly<Record<NavGroupId, string>> = Object.freeze({
  atendimento: "nav-grupo-atendimento",
  crm: "nav-grupo-crm",
  ia: "nav-grupo-ia",
  canais: "nav-grupo-canais",
  analise: "nav-grupo-analise",
  organizacao: "nav-grupo-organizacao",
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

export function classeDoGrupo(id: NavGroupId): string {
  return CLASSES_DE_GRUPO[id];
}

/**
 * O mapa href → classe de TODOS os destinos do catálogo, montado uma vez.
 *
 * Serve à régua (unicidade e forma) e a quem precisa do nome sem renderizar o
 * menu. O componente deriva a classe de `classeDoItem(item.href)` para valer
 * também para destino que ainda não está no catálogo (hub, item futuro).
 */
export const CLASSES_DE_ITEM: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(NAV_CATALOG.map((destino) => [destino.href, classeDoItem(destino.href)])),
);

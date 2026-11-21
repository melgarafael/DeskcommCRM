/**
 * O CONTRATO DE CLASSES DA SEÇÃO NO CONTEÚDO (#4705).
 *
 * ─── Por que ele existe ─────────────────────────────────────────────────────
 *
 * O #4463 deu ao MENU classes estáveis (`nav-grupo-<id>`, `nav-item-<destino>`) e
 * o CSS personalizado de `/admin/marca` passou a pintar cada seção — mas só a
 * barra lateral. O `<main>` da casca (`app/app/_components/AppShell.tsx`) é um
 * `flex-1 overflow-auto p-4 …` sem identidade: medido em `/app/inbox`, nenhum
 * elemento fora do `<aside>` carregava classe de seção. Resultado: a cor parava
 * no menu, e toda tela de conteúdo caía na mesma cor de destaque.
 *
 * O validador recusa seletor de atributo e `:has()`, então a folha do cliente
 * não tem como inferir a seção a partir do `aria-current` do menu. O único
 * caminho é o DOM dizer em que seção a pessoa está — que é o que este arquivo
 * publica, na MESMA convenção do menu (uma classe comum + uma por seção,
 * derivadas do registro de navegação, não escritas tela a tela).
 *
 * ─── O que é contrato, e o que não é ────────────────────────────────────────
 *
 * Mudar um destes nomes quebra a personalização de clientes, então é decisão de
 * produto — não refatoração. A lista é FECHADA: `tests/unit/tela-classe-de-secao.test.tsx`
 * reprova seção nova que escape dela, e o validador de CSS personalizado recusa
 * `tela-secao-<qualquer-coisa>` que não esteja aqui (a classe que não existe
 * não pinta nada, e sem a recusa o erro do cliente é silencioso).
 *
 * Fica FORA do contrato a classe por DESTINO (`tela-<destino>`, opcional na
 * issue): com ela, a lista fechada passaria a acompanhar cada destino do
 * catálogo e o gancho por seção — que é o pedido — já está resolvido. Se um dia
 * entrar, entra com prefixo próprio e teste de lista literal.
 *
 * ─── Por que o import de `catalogo` é SÓ de tipo ────────────────────────────
 *
 * Este módulo é lido pelo validador (`lib/branding/css-personalizado.ts`), que
 * roda no layout raiz e na action de `/admin/marca`. `catalogo.ts` puxa papéis,
 * módulos e capacidades; `import type` é apagado na compilação e mantém o
 * validador sem essa dependência em runtime. Quem precisa percorrer o registro
 * (`classeDaSecao`, abaixo) mora em `classes-estaveis.ts`, junto do resto.
 */
import type { NavGroupId } from "./catalogo";

/** A classe de TODA tela do app — o análogo de `nav-grupo` no conteúdo. */
export const CLASSE_DA_SECAO = "tela-secao";

/** O prefixo da família: é por ele que o validador reconhece (e confere) a classe. */
export const PREFIXO_DA_SECAO = `${CLASSE_DA_SECAO}-`;

/**
 * As seções do CONTEÚDO são os grupos do catálogo. O grupo gerado "Módulos" (Spec 33, F4) fica de
 * fora: a tela de um módulo (`/app/m/<slug>`) não está no registro de navegação, então, pela regra
 * de cima, fica só com `tela-secao` — como qualquer rota fora do registro.
 */
type SecaoDoConteudo = Exclude<NavGroupId, "modulos">;

/** Uma classe por seção — o alvo de `.tela-secao-crm .rounded-lg { … }`. */
export const CLASSES_DE_SECAO: Readonly<Record<SecaoDoConteudo, string>> = Object.freeze({
  atendimento: "tela-secao-atendimento",
  crm: "tela-secao-crm",
  ia: "tela-secao-ia",
  canais: "tela-secao-canais",
  analise: "tela-secao-analise",
  organizacao: "tela-secao-organizacao",
});

/**
 * A lista FECHADA do que existe: a comum mais uma por seção. É a régua do teste
 * e a allowlist do validador — as duas leem daqui, então não divergem.
 */
export const CLASSES_DE_SECAO_CONHECIDAS: readonly string[] = Object.freeze([
  CLASSE_DA_SECAO,
  ...Object.values(CLASSES_DE_SECAO),
]);

export function classeDaSecaoDoGrupo(id: NavGroupId): string | null {
  return id === "modulos" ? null : CLASSES_DE_SECAO[id];
}

/** `tela-secao-crm` → true; `tela-secao-inbox` → true (e o validador recusa); `.card` → false. */
export function ehClasseDeSecao(classe: string): boolean {
  return classe === CLASSE_DA_SECAO || classe.startsWith(PREFIXO_DA_SECAO);
}

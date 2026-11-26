/**
 * Fork Ânima — TEMA FIXO: a aparência é sempre a do Design System Ânima.
 *
 * Decisão do responsável pelo fork (2026-11-26): organizações não personalizam cor nem tema.
 * Ficam travados:
 *  - a cor da marca da organização (Configurações › Marca) e a da instalação (`/admin/marca` e
 *    `APP_ACCENT_HEX`) — ignoradas na tela, nos e-mails e no ícone;
 *  - a tela Aparência (templates, cor secundária, fonte, ajustes): fora do menu, rota redireciona;
 *  - o tema de extensão por organização.
 * Nome e logo continuam livres.
 *
 * O bloqueio é aplicado nos pontos de CONSUMO (layouts e saídas), e não no resolvedor
 * (`lib/branding/resolve.ts`): o resolvedor é exercitado com cores pelos testes do upstream, e
 * deixá-lo intacto mantém esses testes e o sync limpos. O que já está gravado no banco não é
 * apagado; só deixa de ter efeito. Desligar `TEMA_FIXO` devolve o comportamento do upstream.
 *
 * Pontos de aplicação (`grep -rn "lib/anima/tema-fixo" app lib`):
 * `app/layout.tsx`, `app/app/layout.tsx`, `lib/branding/saida.ts`,
 * `lib/navigation/interface.ts`, `app/app/settings/aparencia/page.tsx` e os formulários de marca.
 */
import { AJUSTES_PADRAO, type Aparencia } from "@/lib/aparencia/ajustes";
import type { MarcaResolvida } from "@/lib/branding/resolve";

export const TEMA_FIXO = true;

/** Telas que saem do menu, do hub e do ⌘K enquanto o tema é fixo. */
const ROTAS_OCULTAS: ReadonlySet<string> = new Set(["/app/settings/aparencia"]);

/** A marca sem a cor: nome e logo seguem como resolvidos, a cor volta ao padrão do produto. */
export function semCorPropria(marca: MarcaResolvida): MarcaResolvida {
  if (!TEMA_FIXO) return marca;
  return {
    ...marca,
    cor: null,
    origens: { ...marca.origens, cor: "padrao", corEscura: undefined },
    motivos: [],
  };
}

/** A aparência da organização: sempre a de fábrica (nenhum atributo, nenhum CSS). */
export function aparenciaFixa(aparencia: Aparencia): Aparencia {
  return TEMA_FIXO ? AJUSTES_PADRAO : aparencia;
}

/** O CSS do tema de extensão da organização: nenhum. */
export function temaDeExtensaoFixo(css: string | null): string | null {
  return TEMA_FIXO ? null : css;
}

export function rotaOcultaPeloTemaFixo(href: string): boolean {
  return TEMA_FIXO && ROTAS_OCULTAS.has(href);
}

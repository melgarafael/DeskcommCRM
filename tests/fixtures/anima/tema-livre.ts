/**
 * Fork Ânima — o `lib/anima/tema-fixo.ts` DESTRAVADO, para os testes do upstream que exercitam
 * cor de marca e a tela Aparência. Uso: `vi.mock("@/lib/anima/tema-fixo", () => import("@/tests/fixtures/anima/tema-livre"));`
 * Mantenha as assinaturas iguais às do módulo real.
 */
import type { Aparencia } from "@/lib/aparencia/ajustes";
import type { MarcaResolvida } from "@/lib/branding/resolve";

export const TEMA_FIXO = false;
export const semCorPropria = (marca: MarcaResolvida): MarcaResolvida => marca;
export const aparenciaFixa = (aparencia: Aparencia): Aparencia => aparencia;
export const temaDeExtensaoFixo = (css: string | null): string | null => css;
export const rotaOcultaPeloTemaFixo = (_href: string): boolean => false;

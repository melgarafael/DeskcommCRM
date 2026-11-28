"use server";
/**
 * O MÓDULO COMPLETO PARA O PAINEL LATERAL (Spec 33, F4, tarefa 5).
 *
 * O navegador só conhece `slug` e `titulo` dos módulos conectados (`activeOrg.modulos_conectados`).
 * O `QuadroDoModulo` precisa do `ModuloNaTela` inteiro (endereço do serviço e id da instalação),
 * que só o servidor sabe. Esta ação é o caminho: ao ABRIR o painel, a pessoa pede o módulo pelo
 * slug e o servidor devolve só aquele, depois de conferir sessão, organização e papel, pela MESMA
 * fonte da rota `/app/m/[modulo]` (`modulosNaTela`). Módulo que não é da organização da sessão (ou
 * que não pode abrir agora) volta `null`, igual ao 404 da rota. Nenhum módulo fechado vaza.
 */
import { requireRole } from "@/lib/auth/require-role";
import { modulosNaTela, type ModuloNaTela } from "@/lib/extensions/modulos-na-tela";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function moduloParaOPainel(slug: string): Promise<ModuloNaTela | null> {
  if (typeof slug !== "string" || slug.length > 128 || !SLUG.test(slug)) return null;
  const authz = await requireRole("viewer", { resource: "organization_extensions" });
  if (!authz.ok) return null;
  try {
    const modulos = await modulosNaTela(authz.org.orgId, {
      ...(authz.user.idioma ? { locale: authz.user.idioma } : {}),
    });
    return modulos.find((m) => m.slug === slug) ?? null;
  } catch {
    return null; // lado seguro: na dúvida o módulo não abre e o CRM segue inteiro
  }
}

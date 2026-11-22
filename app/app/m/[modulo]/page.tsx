import { notFound } from "next/navigation";

import { QuadroDoModulo } from "@/components/modulo/QuadroDoModulo";
import { requireRole } from "@/lib/auth/require-role";
import { modulosNaTela } from "@/lib/extensions/modulos-na-tela";

export const dynamic = "force-dynamic";

/**
 * A TELA DE UM MÓDULO CONECTADO: `/app/m/<slug>` (Spec 33, F4, tarefa 3).
 *
 * Componente de servidor. A sessão e a organização vêm de `requireRole("viewer")` (nunca da URL nem
 * do corpo); o módulo é procurado pelo slug DENTRE os que esta organização pode abrir agora
 * (`modulosNaTela`). Módulo desligado, removido, fora da faixa de compatibilidade ou sem endereço de
 * serviço não está na lista, e a rota responde 404 (lado seguro: na dúvida o módulo não aparece e o
 * resto do CRM segue inteiro).
 */
export default async function ModuloPage({ params }: { params: Promise<{ modulo: string }> }) {
  const { modulo: slug } = await params;

  const authz = await requireRole("viewer", { resource: "organization_extensions" });
  if (!authz.ok) notFound();

  const modulos = await modulosNaTela(authz.org.orgId, {
    ...(authz.user.idioma ? { locale: authz.user.idioma } : {}),
  });
  const modulo = modulos.find((m) => m.slug === slug);
  if (!modulo) notFound();

  return (
    <>
      <title>{modulo.titulo}</title>
      <div className="h-full p-4">
        <QuadroDoModulo modulo={modulo} />
      </div>
    </>
  );
}

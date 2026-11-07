import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { ListaDeEspera } from "./_client";

export const dynamic = "force-dynamic";

/**
 * LISTA DE ESPERA — módulo opcional (ADR-0002, doc 208). Sem o módulo instalado a
 * tela não existe. Quem gerencia escolhe os prazos e liga o recurso aqui; a equipe
 * inscreve quem aceitou ser avisado e registra a resposta à oferta.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!(await moduloLigado(createAdminClient(), "lista_de_espera"))) notFound();

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Lista de espera")}</h1>
        <p className="text-sm text-text-muted">
          {t("Quando um horário abre, a vaga é oferecida a uma pessoa por vez, na ordem da fila.")}
        </p>
      </div>
      <ListaDeEspera
        podeConfigurar={ROLE_RANK[org.role] >= ROLE_RANK.manager}
        podeOperar={ROLE_RANK[org.role] >= ROLE_RANK.agent}
      />
    </div>
  );
}

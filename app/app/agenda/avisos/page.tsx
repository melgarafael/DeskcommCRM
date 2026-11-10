/**
 * Agenda › **Aviso de agendamento** (`/app/agenda/avisos`).
 *
 * O WhatsApp do dono recebe cada horário marcado, remarcado ou cancelado e, às
 * 7h, o resumo do dia (migration 0753). `admin`, como o aviso de caso: a tela
 * escolhe um número conectado e manda nome de cliente para um celular — o mesmo
 * gate da rota e da RLS de `config_aviso_de_agendamento`.
 *
 * O rótulo é "Aviso de agendamento", e não "Aviso no WhatsApp": esse já é o
 * nome da tela do aviso de CASO, e dois destinos com o mesmo nome na busca da
 * navegação não dizem qual é qual.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { AvisoDeAgendamento } from "./_components/AvisoDeAgendamento";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Aviso de agendamento" };

export default async function AvisoDeAgendamentoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Aviso de agendamento", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Receba no WhatsApp cada horário marcado, remarcado ou cancelado, e às 7h o resumo do dia.",
            idioma,
          )}
        </p>
      </header>
      <AvisoDeAgendamento />
    </div>
  );
}

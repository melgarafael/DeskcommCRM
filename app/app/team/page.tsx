import type { Metadata } from "next";
import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TeamMembersClient } from "./_components/TeamMembersClient";
import { TeamInvitesClient } from "./_components/TeamInvitesClient";
import { AttendantsClient } from "./_components/AttendantsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Equipe" };

/**
 * As duas abas são endereçáveis, e isso não é conveniência.
 *
 * O editor de jornada — "meus horários de atendimento" — mora na aba
 * "Atendimento", atrás de um botão só de ícone. Quem abre a Agenda numa
 * instalação nova encontra o aviso "você ainda não publicou seus horários", e
 * antes deste parâmetro esse aviso não tinha para onde apontar: mandar o usuário
 * para `/app/team` o deixaria na aba de Membros, procurando.
 *
 * `aba` em português porque é o que aparece na barra de endereço de quem usa o
 * produto; os valores internos das abas seguem os do componente.
 */
const ABAS: Record<string, string> = { membros: "members", atendimento: "attendants" };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>;
}) {
  const { aba } = await searchParams;
  // Valor desconhecido cai na aba padrão em vez de deixar as duas fechadas —
  // link velho ou digitado errado não pode devolver uma tela sem conteúdo.
  const abaInicial = ABAS[aba ?? ""] ?? "members";
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`).
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  const isAdmin = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const isManager = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Equipe")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Gestão de membros, roles e atendimento do tenant.")}
          </p>
        </div>
        {isAdmin ? (
          <Button asChild className="shrink-0">
            <Link href="/app/team/invite">{t("Convidar membros")}</Link>
          </Button>
        ) : null}
      </header>

      <Tabs defaultValue={abaInicial} className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="members">{t("Membros")}</TabsTrigger>
          <TabsTrigger value="attendants">{t("Atendimento")}</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="mt-4 flex flex-col gap-8">
          <TeamMembersClient currentUserId={user.id} canManage={isAdmin} />
          {/*
            Convites pendentes vivem AQUI, na mesma aba de quem já entrou —
            antes só apareciam numa lista efêmera dentro do modal "Convidar
            membros", que sumia ao fechar. Manager+ vê; só admin reenvia/revoga
            (as rotas são admin-only). Ver `docs/testing/user-journey-map.md`.
          */}
          {isManager ? <TeamInvitesClient canManage={isAdmin} /> : null}
        </TabsContent>
        <TabsContent value="attendants" className="mt-4">
          {isManager ? (
            <AttendantsClient canManage={isManager} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {/*
                A recusa DIZ O QUE FAZER, e isso passou a importar porque a Agenda
                agora manda gente para cá: o aviso "você ainda não publicou seus
                horários" aponta para esta aba. Quem atende sem ser gerente chega
                aqui pelo link e, antes, só lia a regra — um beco novo, criado pelo
                próprio conserto do beco anterior.

                O buraco de VERDADE continua aberto e está escrito de propósito: a
                rota `PATCH /api/v1/attendants/availability/[user_id]` autoriza a
                pessoa a mudar a PRÓPRIA jornada (`isSelf`), e não há tela para
                isso. Enquanto não houver, pedir a um gerente é o caminho real.
              */}
              {t(
                "Só gerentes e administradores editam os horários de atendimento da equipe. Para publicar os seus, peça a um gerente que abra esta aba e use o botão “Editar horário” ao lado do seu nome.",
              )}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

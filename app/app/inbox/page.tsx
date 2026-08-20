import { redirect } from "next/navigation";
import Link from "next/link";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { InboxLayout } from "@/components/inbox/InboxLayout";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>Você não tem nenhuma organização ativa. Configure sua organização ou aceite um convite.</p>
        <div className="flex flex-wrap justify-center gap-4">
          <Link className="text-primary underline underline-offset-4" href="/get-started">
            Configurar minha organização
          </Link>
          <Link className="text-primary underline underline-offset-4" href="/app/settings/api-tokens">
            Ver conexão MCP
          </Link>
        </div>
      </div>
    );
  }
  const { id } = await searchParams;
  return <InboxLayout initialSelectedId={id ?? null} />;
}

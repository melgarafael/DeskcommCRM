import type { ReactNode } from "react";

import { CascaDaAgencia } from "@/components/agencia/CascaDaAgencia";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { entradasPermitidas } from "@/lib/agencia/menu";

export const dynamic = "force-dynamic";

/**
 * A área interna da agência (docs/agencia/SPEC-equipe.md).
 *
 * Fica num grupo `(area)` para que `/agencia/sem-acesso` e o aceite do convite,
 * que moram fora dele, não passem por este guarda — senão quem não tem acesso
 * seria mandado para uma página que o mandaria de volta.
 */
export default async function LayoutDaAgencia({ children }: { children: ReactNode }) {
  const ctx = await requireAreaDaAgencia();
  const nome = (ctx.user.user_metadata?.full_name as string | undefined) ?? ctx.user.email ?? "";

  return (
    <CascaDaAgencia
      entradas={entradasPermitidas(ctx.permissoes)}
      nomeDoUsuario={ctx.membro?.nome ?? nome}
      ehDono={ctx.ehDono}
      membroId={ctx.membro?.id ?? null}
    >
      {children}
    </CascaDaAgencia>
  );
}

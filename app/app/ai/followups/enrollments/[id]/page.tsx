import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { DossieDoFollowup } from "./_components/DossieDoFollowup";

export const dynamic = "force-dynamic";

/**
 * O dossiê de UM follow-up.
 *
 * Rota própria e não painel lateral: é o endereço que se manda para um colega
 * ("olha o que aconteceu com este lead"), e sobrevive ao F5 no meio de uma
 * intervenção. A porta é a linha da fila (`/app/ai/followups`, aba Fila) — como
 * toda tela de detalhe deste app, ela não entra em `lib/navigation/registry.ts`,
 * e `tests/unit/navegacao-completude.test.ts` não a cobra porque o segmento é
 * `[id]`: menu para um enrollment específico não existe.
 *
 * Leitura é de qualquer membro (a fila também é); intervir é `manager+`, e o
 * gate real está em cada rota — o `canWrite` daqui só decide o que aparece.
 */
export default async function DossieDoFollowupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  // O `p-6` que esta pagina sempre teve — ver o comentario em
  // `app/app/ai/followups/[id]/page.tsx`.
  return (
    <div className="p-6">
      <DossieDoFollowup id={id} canWrite={ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager} />
    </div>
  );
}

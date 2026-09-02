import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { UpdatePanel } from "./_components/UpdatePanel";

export const metadata = { title: "Atualização do sistema" };
export const dynamic = "force-dynamic";

/**
 * Só o dono do servidor. Um `notFound()` em vez de uma tela de "sem permissão"
 * porque, para quem não é dono, esta página simplesmente não faz parte do
 * produto.
 */
export default async function Page() {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin) notFound();
  // O `p-6` que esta pagina sempre teve, agora dito por ela.
  //
  // Ele vinha do `<main>` do AppShell. O `layout.tsx` desta pasta cancela o
  // respiro do `<main>` com `-m-6` (para o Paper alcancar a borda) e conta com
  // cada pagina repondo o seu — quinze das dezesseis ja repunham. Sem esta
  // linha, esta seria a unica de Configuracoes com o conteudo colado na borda.
  return (
    <div className="p-6">
      <UpdatePanel />
    </div>
  );
}

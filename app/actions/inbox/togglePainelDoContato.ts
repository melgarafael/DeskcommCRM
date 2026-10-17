"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

/**
 * A preferência do painel do contato recolhido — o MESMO caminho do recolher do
 * menu da esquerda (`app/actions/shell/toggleSidebar.ts`): cookie httpOnly
 * gravado por server action e lido no servidor na montagem da tela.
 *
 * O cookie e não o `localStorage` de propósito: sem a leitura no servidor, o
 * primeiro render do Inbox traz o painel aberto e o `useState` inicial só o
 * recolhe depois da hidratação — a conversa nasce estreita e "pula" para larga,
 * que é o flash que o recolher da esquerda já evita (`app/app/layout.tsx` lê
 * `sidebar_collapsed` no SSR pelo mesmo motivo).
 *
 * Recebe o estado ATUAL, como `toggleSidebar`: quem chama já leu se está
 * recolhido, então não há uma segunda fonte de verdade para discordar.
 */
export async function togglePainelDoContato(currentlyCollapsed: boolean): Promise<void> {
  const store = await cookies();
  store.set("inbox_painel_recolhido", currentlyCollapsed ? "0" : "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/app/inbox");
}

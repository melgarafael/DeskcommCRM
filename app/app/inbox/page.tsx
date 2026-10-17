import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { InboxLayout } from "@/components/inbox/InboxLayout";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { lerRascunho, type AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; rascunho?: string }>;
}) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) {
    const idioma = user.idioma;
    // As duas saídas que a frase anterior oferecia — "aceite um convite" e
    // "contate o admin" — não existem para quem INSTALOU o sistema: não há
    // convite e o admin é ele. Este é o estado terminal do primeiro acesso que
    // falhou, e o link é a única porta para fora dele.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>
          {traduzir(
            "Você não tem nenhuma organização ativa. Configure sua organização ou aceite um convite.",
            idioma,
          )}
        </p>
        <Link className="text-primary underline underline-offset-4" href="/get-started">
          {traduzir("Configurar minha organização", idioma)}
        </Link>
      </div>
    );
  }
  const { id, rascunho } = await searchParams;
  // A preferência do painel do contato recolhido é lida AQUI, no servidor, pelo
  // mesmo motivo do `sidebar_collapsed` (`app/app/layout.tsx`): sem isto o
  // primeiro render traz o painel aberto e a grade só se ajusta depois da
  // hidratação — a conversa nasce estreita e pula para larga.
  const painelRecolhido = (await cookies()).get("inbox_painel_recolhido")?.value === "1";
  // ?rascunho= é a ponta da caixa de entrada da issue #1611: o texto mora no
  // servidor, e a URL só carrega o ID. Aqui a leitura acontece com a SESSÃO do
  // atendente (RLS), então um rascunho de outra organização vira
  // "não encontrado" por construção. Os três recusos (outra conversa, já usado,
  // vencido) viram aviso — a issue pede a conversa abrindo "sem texto e com
  // aviso", e silenciar faria o atendente achar que o texto nunca existiu.
  let avisoDeRascunho: AvisoDeRascunho | null = null;
  if (rascunho && id) {
    const db = await createClient();
    avisoDeRascunho = {
      conversationId: id,
      leitura: await lerRascunho(db, {
        organizationId: activeOrg.orgId,
        conversationId: id,
        draftId: rascunho,
      }),
    };
  }
  return (
    <InboxLayout
      initialSelectedId={id ?? null}
      rascunho={avisoDeRascunho}
      painelRecolhidoInicial={painelRecolhido}
    />
  );
}

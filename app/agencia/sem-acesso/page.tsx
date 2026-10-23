import Link from "next/link";
import { notFound } from "next/navigation";

import { contextoDaAgencia } from "@/lib/agencia/acesso";

export const metadata = { title: "Sem acesso à agência" };
export const dynamic = "force-dynamic";

/** Para quem está logado mas não tem acesso ativo à área da agência. */
export default async function SemAcesso() {
  const { decisao } = await contextoDaAgencia();
  // Com o módulo desligado a área não existe — nem esta página.
  if (decisao.tipo === "modulo_desligado") notFound();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Sem acesso à área da agência</h1>
        <p className="text-sm text-muted-foreground">
          Seu acesso não está ativo. Se você faz parte da equipe, peça um novo convite a quem administra a agência.
        </p>
        <Link href="/login" className="text-sm underline underline-offset-4">
          Entrar com outra conta
        </Link>
      </div>
    </main>
  );
}

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function InternalErrorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-2xl font-semibold">500 — Erro interno</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Algo deu errado do nosso lado. Reporte ao suporte com o ID exibido na tela
          anterior, se houver.
        </p>
        <div className="mt-4 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          ID: —
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/">Voltar</Link>
          </Button>
          <Button asChild>
            <Link href="/app/inbox">Voltar pra Inbox</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}

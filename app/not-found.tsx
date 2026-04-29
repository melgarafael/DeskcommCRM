import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-2xl font-semibold">404 — Página não encontrada</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Verifique o link ou volte pra inbox.
        </p>
        <div className="mt-6 flex justify-center gap-2">
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

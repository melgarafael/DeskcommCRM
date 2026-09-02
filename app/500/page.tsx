import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * `/500` — irmã de `/403` e `/503`, e faltava.
 *
 * `lib/auth/public-paths.ts` já isenta esta rota de auth desde sempre: o
 * sistema contava com a página. Sem ela, quem caísse aqui (proxy, link de
 * runbook, redirect de borda) via "página não encontrada" — a mensagem errada
 * sobre o que aconteceu.
 *
 * Distinta de `app/error.tsx`, que trata exceção em runtime dentro do React.
 * Esta é a página estática, alcançável por URL.
 */
export default function InternalErrorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-2xl font-semibold">500 — Erro interno</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Algo correu mal do nosso lado. Já registámos o ocorrido; tente de novo dentro de instantes.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button asChild>
            <Link href="/">Voltar</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}

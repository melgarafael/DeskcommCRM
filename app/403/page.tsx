export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">403 — Sem permissão</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Você não tem acesso a esta área. Volte para a página inicial.
        </p>
      </div>
    </main>
  );
}

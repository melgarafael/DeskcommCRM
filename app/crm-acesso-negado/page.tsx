import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Acesso ao CRM indisponível" };

export default function CrmAcessoNegadoPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md space-y-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">Acesso ao CRM indisponível</h1>
        <p className="text-sm text-muted-foreground">
          O acesso deste escritório expirou ou o Advomax está temporariamente indisponível. Verifique a assinatura para continuar.
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Button asChild><Link href="/app/settings">Ver assinatura</Link></Button>
          <Button asChild variant="outline"><Link href="/login">Sair</Link></Button>
        </div>
      </Card>
    </main>
  );
}

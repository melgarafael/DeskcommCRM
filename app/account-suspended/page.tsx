import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata = {
  title: "Conta suspensa — DeskcommCRM",
};

export default function AccountSuspendedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center space-y-4">
        <h1 className="text-2xl font-semibold">Conta suspensa</h1>
        <p className="text-sm text-muted-foreground">
          Sua conta está suspensa. Entre em contato com{" "}
          <a
            href="mailto:support@deskcomm.com.br"
            className="underline underline-offset-4 hover:text-foreground transition-colors"
          >
            support@deskcomm.com.br
          </a>{" "}
          para mais informações.
        </p>
        <div className="pt-2">
          <Button asChild variant="outline">
            <Link href="/login">Sair</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}

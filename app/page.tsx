import { redirect } from "next/navigation";

// A raiz não tem conteúdo próprio: manda pro painel. O middleware redireciona
// visitante não autenticado para /login?next=/app automaticamente.
export default function HomePage() {
  redirect("/app");
}

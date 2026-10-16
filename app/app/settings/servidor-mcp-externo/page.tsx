import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { CadastroDoServidorMcpExterno } from "./_components/CadastroDoServidorMcpExterno";

export const dynamic = "force-dynamic";
export const metadata = { title: "Servidor MCP externo" };

/**
 * A tela do servidor MCP externo da empresa (#2948).
 *
 * ── Quem entra ──────────────────────────────────────────────────────────────
 *
 * O DONO DA INSTALAÇÃO — é a régua da action que grava
 * (`regraPlatformAdmin`, a mesma das extensões), e a tela não inventa uma
 * segunda: quem não é dono recebe `/403` aqui, exatamente como receberia
 * `forbidden_role` da Server Action. Sessão de suporte cai junto, pelo mesmo
 * motivo de sempre: o endereço e a chave de um sistema de fora não são dado
 * que uma sessão emprestada existe para enxergar.
 *
 * `/403` e não `notFound()` (o que a vizinha `/app/settings/atualizacao` faz)
 * porque esta tela TEM porta no registro de navegação — o dono da instalação
 * é, na instalação de um dono só, quem administra a empresa. Um 404 para quem
 * clicou num item do hub pareceria link quebrado; o 403 diz o que é: falta
 * permissão.
 *
 * ── O que ela NÃO carrega ──────────────────────────────────────────────────
 *
 * Nada do banco no servidor. O que existe registrado não é legível por action
 * nenhuma (o endereço e a chave são lidos só pelo runtime), e é o TESTE que
 * conta o que está do outro lado — por isso a tela abre com o formulário
 * vazio e oferece "Testar conexão".
 */
export default async function ServidorMcpExternoPage() {
  const user = await requireAuth();
  if (!user.is_platform_admin || user.support) redirect("/403");

  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Servidor MCP externo", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O endereço e a chave do sistema de fora que a IA desta empresa pode consultar. Só o dono da instalação vê esta tela.",
            idioma,
          )}
        </p>
      </header>
      <CadastroDoServidorMcpExterno />
    </div>
  );
}

import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { exigirProvaDeMfa, mfaEmDividaEstrita, requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  CONEXAO_COMPARTILHADA,
  escritasLiberadasDaConexao,
  lerEscritaLiberada,
} from "@/lib/mcp/servidor-externo/escrita-liberada";
import { createAdminClient } from "@/lib/supabase/admin";
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
 * ── O que ela carrega, e o que NÃO ─────────────────────────────────────────
 *
 * Carrega SÓ a lista de ferramentas de escrita liberadas para a conexão do
 * servidor compartilhado (#4445), lida da organização DA SESSÃO. Sem isso o
 * campo abria em branco e quem voltava só para trocar o endereço apagava as
 * liberações ao salvar (doc de decisão 347). Nomes de ferramenta não são
 * segredo: são o que o próprio servidor anuncia no "Testar conexão".
 *
 * O endereço e a chave NÃO são carregados: o runtime é o único leitor deles, e
 * é o TESTE que conta o que está do outro lado — por isso esses dois campos
 * abrem vazios e a tela oferece "Testar conexão".
 */
export default async function ServidorMcpExternoPage() {
  const user = await requireAuth();
  if (!user.is_platform_admin || user.support) redirect("/403");
  // A action que grava exige o código provado nesta sessão: vai a ele antes.
  await exigirProvaDeMfa(mfaEmDividaEstrita);

  // A organização sai da SESSÃO, como na action que grava — nunca da URL.
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  const { data } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  const liberadasIniciais = escritasLiberadasDaConexao(
    lerEscritaLiberada(data?.settings),
    CONEXAO_COMPARTILHADA,
  ).join("\n");

  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <CabecalhoDaSubTela titulo={traduzir("Servidor MCP externo", idioma)} idioma={idioma}>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O endereço e a chave do sistema de fora que a IA desta empresa pode consultar. Só o dono da instalação vê esta tela.",
            idioma,
          )}
        </p>
      </CabecalhoDaSubTela>
      <CadastroDoServidorMcpExterno liberadasIniciais={liberadasIniciais} />
    </div>
  );
}

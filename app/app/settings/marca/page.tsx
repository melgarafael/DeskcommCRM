/**
 * Configurações → Marca. A tela onde o admin de UMA organização troca o nome e a
 * cor que a empresa dele mostra dentro do sistema.
 *
 * ── Por que aqui, e não em `/admin/marca` ────────────────────────────────────
 *
 * `/admin/marca` edita a marca da INSTALAÇÃO — a que pinta o login, a tela de
 * erro e o e-mail de recuperação, superfícies anteriores a qualquer organização.
 * Num revendedor que hospeda várias empresas, dar aquilo ao admin de um tenant
 * seria dar a um cliente o controle da fachada dos outros. Esta tela é a camada
 * de cima da mesma pilha: vale só dentro de `/app`, e só para esta organização.
 *
 * ── Por que o papel mínimo é `admin` ─────────────────────────────────────────
 *
 * Medido nos gates das telas vizinhas: identidade da empresa (`display_name`,
 * `legal_name`, NUIT, DPO) é admin (`settings/tenant/page.tsx`); billing é admin;
 * API tokens é admin. O nome e a cor que o cliente final do revendedor vê SÃO
 * identidade da empresa — dá-los a `manager` os colocaria abaixo de billing e de
 * tokens na mesma prancheta.
 *
 * E o gate daqui protege a ROTA, não a coluna: quem defende o dado é
 * `fn_definir_marca_da_organizacao`, que re-resolve o papel no banco e levanta
 * 42501. Server Action não passa por `requireRole` — ver o cabeçalho de
 * `app/actions/settings/updateMarcaDaOrganizacao.ts`.
 *
 * `redirect("/403")` e não `notFound()`: dentro do tenant, a existência desta
 * tela não é segredo de ninguém — o `manager` sabe que a empresa tem marca, só
 * não é ele quem a troca. Mesma escolha de `settings/tenant/page.tsx`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { marcaDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

import { FormularioDaMarcaDaOrganizacao } from "./_form";

export const metadata = { title: "Marca" };
export const dynamic = "force-dynamic";

export default async function MarcaDaOrganizacaoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  // Client de SESSÃO para LER, igual às telas irmãs: a leitura de `organizations`
  // é permitida a membro pela RLS, e usar o admin client aqui seria contornar a
  // política para buscar o que a política já entrega. Quem precisa de privilégio
  // é a ESCRITA — e ela mora na função SQL, não nesta tela.
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const gravada = marcaDaOrganizacaoDeSettings(data?.settings ?? null);
  const linha = await marcaDaInstalacao();

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Marca</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          O nome e a cor que a sua empresa mostra para quem trabalha aqui dentro.
        </p>
      </header>

      <FormularioDaMarcaDaOrganizacao
        gravada={{
          app_name: gravada?.app_name ?? null,
          accent_hex: gravada?.accent_hex ?? null,
          // O CAMINHO no bucket, não a URL: quem converte é `logoDaCamada`, do
          // lado do navegador, com a base do Storage injetada em runtime. Mandar
          // a URL pronta do servidor faria a tela ter uma segunda regra de
          // montagem, e a que divergisse seria a que ninguém abre.
          logo_path: gravada?.logo_path ?? null,
        }}
        // As DUAS camadas de baixo descem para o formulário, e não uma resolução
        // já pronta: a prévia ao vivo remonta a pilha inteira a cada tecla, pelo
        // mesmo caminho do servidor. Sem elas, a tela não saberia responder "e se
        // eu apagar o nome, o que aparece?" — que é a pergunta que o placeholder
        // e o bloco de origens existem para responder.
        instalacao={{
          app_name: linha?.app_name ?? null,
          logo_url: linha?.logo_url ?? null,
          logo_path: linha?.logo_path ?? null,
          accent_hex: linha?.accent_hex ?? null,
        }}
        // Só os três campos de marca do ambiente, nunca o objeto `env` inteiro:
        // isto atravessa a fronteira para o navegador, e o que atravessa é o que
        // já está visível na interface de qualquer forma.
        ambiente={{
          APP_NAME: env.APP_NAME,
          APP_LOGO_URL: env.APP_LOGO_URL,
          APP_ACCENT_HEX: env.APP_ACCENT_HEX,
        }}
      />
    </div>
  );
}

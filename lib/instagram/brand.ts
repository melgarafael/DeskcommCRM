import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { marcaDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";
import {
  BUCKET_DE_LOGOS,
  TAMANHO_MAXIMO_DO_LOGO,
  caminhoBateComPrefixo,
  prefixoDaOrganizacao,
  logoDaCamada,
} from "@/lib/branding/logo";
import { farejarTipo } from "@/lib/branding/logo-arquivo";
export type CompanyContext = {
  name: string;
  description: string;
  descriptionSource: "post" | "agent" | null;
  logoPath: string | null;
  logoUrl: string | null;
  accent: string | null;
};
export async function companyContext(org: string): Promise<CompanyContext> {
  const { rows } = await getRequestPool().query(
    `select o.display_name,o.settings,
      (select i.input->>'niche' from instagram_studio_items i where i.organization_id=o.id and i.kind='post' and length(trim(i.input->>'niche'))>0 order by i.created_at desc limit 1) as previous_description,
      (select a.description from ai_agents a where a.organization_id=o.id and a.is_active and a.archived_at is null and length(trim(a.description))>0 order by a.is_default desc,a.updated_at desc limit 1) as agent_description
     from organizations o where o.id=$1`,
    [org],
  );
  const row = rows[0];
  if (!row) throw new Error("Não foi possível ler o cadastro da empresa.");
  const brand = marcaDaOrganizacaoDeSettings(row.settings);
  const raw = brand?.logo_path;
  const logoPath = raw && caminhoBateComPrefixo(raw, prefixoDaOrganizacao(org)) ? raw : null;
  return {
    name: String(row.display_name).slice(0, 200),
    description: String(row.previous_description || row.agent_description || "").slice(0, 2000),
    descriptionSource: row.previous_description ? "post" : row.agent_description ? "agent" : null,
    logoPath,
    logoUrl: logoDaCamada(logoPath, null),
    accent: /^#[0-9a-f]{6}$/i.test(brand?.accent_hex ?? "") ? brand!.accent_hex! : null,
  };
}
export async function companyLogo(
  org: string,
  context: CompanyContext,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  if (!context.logoPath) return null;
  if (!caminhoBateComPrefixo(context.logoPath, prefixoDaOrganizacao(org)))
    throw new Error("Logo inválido para esta empresa.");
  const { data, error } = await createAdminClient()
    .storage.from(BUCKET_DE_LOGOS)
    .download(context.logoPath);
  if (error || !data || data.size > TAMANHO_MAXIMO_DO_LOGO)
    throw new Error(
      "Não foi possível carregar o logo. Tente novamente ou desmarque o uso do logo nesta criação.",
    );
  const bytes = new Uint8Array(await data.arrayBuffer());
  const type = farejarTipo(bytes);
  if (!type) throw new Error("O logo precisa estar em PNG ou JPG. Atualize o arquivo em Marca.");
  return { bytes, type };
}

/**
 * Publicar as regras que TODOS os agentes da organização seguem.
 *
 * Saiu de dentro da rota quando o onboarding passou a precisar da mesma escrita:
 * o passo de treinamento pergunta "quais são as regras da casa?" e a resposta
 * tem de ir para o mesmo lugar que a tela de Memória edita depois. Duas
 * gravações paralelas do mesmo conteúdo seria a versão do wizard divergindo da
 * versão que o agente lê.
 *
 * O conteúdo é versionado: cada publicação cria uma versão nova e move o
 * ponteiro. Nada é sobrescrito — é o que permite ver o que a organização
 * ensinou ao funcionário, e quando.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResultadoDaPublicacao =
  | { ok: true; versionId: string; versionNumber: number }
  | { ok: false; erro: "versao" | "ponteiro"; mensagem: string };

export async function publicarMemoriaDaOrg(
  admin: SupabaseClient,
  orgId: string,
  userId: string | null,
  content: string,
): Promise<ResultadoDaPublicacao> {
  const { data: maxRow } = await admin
    .from("org_memory_versions")
    .select("version_number")
    .eq("organization_id", orgId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ponytail: select-max + insert não é atômico sob publicação concorrente;
  // publicação é admin-only pela tela. Se virar concorrente, advisory lock por org.
  const nextVersion = ((maxRow?.version_number as number | null) ?? 0) + 1;

  const { data: ver, error: verErr } = await admin
    .from("org_memory_versions")
    .insert({
      organization_id: orgId,
      version_number: nextVersion,
      content,
      created_by: userId,
    })
    .select("id, version_number")
    .single();
  if (verErr || !ver) {
    return { ok: false, erro: "versao", mensagem: verErr?.message ?? "insert_sem_id" };
  }

  const { error: ptrErr } = await admin.from("org_memory_pointers").upsert(
    { organization_id: orgId, version_id: ver.id, updated_at: new Date().toISOString() },
    { onConflict: "organization_id" },
  );
  if (ptrErr) {
    // A versão ficou gravada e o ponteiro não moveu: o conteúdo existe, mas o
    // agente segue lendo o anterior. Quem chama precisa saber a diferença —
    // dizer "publicado" aqui seria prometer um comportamento que não mudou.
    return { ok: false, erro: "ponteiro", mensagem: ptrErr.message };
  }

  return {
    ok: true,
    versionId: ver.id as string,
    versionNumber: ver.version_number as number,
  };
}

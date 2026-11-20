/**
 * "NÃO ENVIAR AVISO DE CASO" — quem da equipe NÃO recebe o aviso de caso no
 * modo `responsavel` (#4989).
 *
 * ─── O pedido ──────────────────────────────────────────────────────────────
 *
 * Um usuário de fila ("Marketing · Fornecedores") recebe grupos, divulgação de
 * operadora e contato de fornecedor. Sem WhatsApp no perfil, a cadeia o pula
 * (`sem_telefone`) e TODO caso dessa fila cai no número da empresa, misturado
 * aos casos de cliente. "Sem número" e "não quero aviso" eram a mesma coisa;
 * esta marca separa as duas. A regra (a cadeia PARA em quem está marcado) mora
 * em `destino-do-aviso.ts`; aqui só se lê e se grava a marca.
 *
 * ─── Onde a marca mora, e por que aqui ─────────────────────────────────────
 *
 * Em `organizations.settings.aviso_de_caso_nao_avisar = { user_ids: [...] }`,
 * jsonb que já existe: NENHUMA migration. As duas alternativas citadas na
 * issue (coluna em `user_organizations`, ao lado do `whatsapp_e164`, ou coluna
 * em `config_aviso_de_caso`) pedem migration e uma mudança no corpo de
 * `fn_definir_aviso_de_caso`; se o mantenedor preferir uma delas, a leitura e
 * a gravação ficam todas neste arquivo, e é ele que muda.
 *
 * ─── Ler: "ninguém marcado" ≠ "não deu para ler" ───────────────────────────
 *
 * `lerMembrosSemAviso` devolve `null` quando a LEITURA falhou. Quem envia trata
 * isso como "ninguém marcado" (o aviso segue a ordem de sempre — um aviso que
 * sai para o número da empresa é melhor do que um que some), e quem mostra a
 * tela trava os interruptores: mostrar todos desligados e deixar alguém
 * "desmarcar" quem nunca viu marcado é o #3935 com outra roupa. jsonb torto
 * (string, número, lista de lixo) vale como ninguém marcado e não lança.
 *
 * ─── Gravar: só o que a pessoa mexeu ───────────────────────────────────────
 *
 * A tela manda só os membros cujo interruptor mudou. Quem ela não mostrou
 * (a lista lê até 200 pessoas; a leitura pode falhar) fica como está. Marcar
 * exige vínculo ATIVO na organização; desmarcar não exige — é como se limpa a
 * marca de quem já saiu. `settings` é compartilhado: lê, troca só esta chave,
 * grava (o mesmo jeito de `definirEntradaAutomaticaNoFunil`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * O client de SERVIÇO, pelo tipo: escrever em `organizations` com o de sessão
 * casa zero linhas e devolve sucesso (`escrita-em-organizations-usa-cliente-admin`).
 */
type ClienteAdmin = ReturnType<typeof createAdminClient>;

/** A chave em `organizations.settings`. */
export const CHAVE_DOS_MEMBROS_SEM_AVISO = "aviso_de_caso_nao_avisar";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Os membros marcados, lidos de um `settings` qualquer. Nunca lança. */
export function membrosSemAvisoDeclarados(settings: unknown): Set<string> {
  const raiz =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : null;
  const bloco = raiz?.[CHAVE_DOS_MEMBROS_SEM_AVISO];
  const ids =
    bloco && typeof bloco === "object" && !Array.isArray(bloco)
      ? (bloco as { user_ids?: unknown }).user_ids
      : null;
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.filter((id): id is string => typeof id === "string" && UUID.test(id)));
}

/**
 * Os membros marcados desta organização. `null` = a leitura FALHOU (não é
 * "ninguém marcado"); o motivo vai em `causa` para quem chama registrar.
 *
 * ⚠️ `admin` é o client de serviço: o `organization_id` vem de fonte confiável.
 */
export async function lerMembrosSemAviso(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ ids: Set<string> } | { ids: null; causa: string }> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) return { ids: null, causa: error.message };
    return { ids: membrosSemAvisoDeclarados((data as { settings?: unknown } | null)?.settings) };
  } catch (err) {
    return { ids: null, causa: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Algum MEMBRO ATIVO está marcado? Medido no servidor, sem o teto de 200 da
 * lista da tela: a frase da lista de entregas não pode sumir porque o único
 * marcado ficou fora da página. `null` = não deu para saber.
 */
export async function algumMembroAtivoSemAviso(
  admin: SupabaseClient,
  organizationId: string,
  marcados: ReadonlySet<string>,
): Promise<boolean | null> {
  if (marcados.size === 0) return false;
  try {
    const { data, error } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .is("revoked_at", null)
      .in("user_id", [...marcados])
      .limit(1);
    if (error) return null;
    return (data ?? []).length > 0;
  } catch {
    return null;
  }
}

/** Uma mudança vinda da tela: ligar ou desligar a marca de UM membro. */
export interface MudancaDaMarca {
  user_id: string;
  nao_avisar: boolean;
}

/** O que a gravação fez de fato — é isso que a auditoria registra. */
export type ResultadoDaMarca =
  | { ok: true; ligados: number; desligados: number; ignorados: number }
  | { ok: false };

/** Quantas vezes relê e tenta de novo quando outra escrita em `organizations` chegou no meio. */
const TENTATIVAS_DA_GRAVACAO = 3;

/**
 * Aplica as mudanças e grava. `ok: false` = não gravou; nada foi alterado.
 *
 * ⚠️ ESCRITA CONDICIONAL. `settings` é um jsonb só para a organização inteira:
 * ler, mesclar e gravar sem condição apagaria a escrita de quem chegou no meio
 * (outro admin marcando outra pessoa, ou outra tela mexendo em outra chave). A
 * gravação só casa se `updated_at` (tocado por `trg_organizations_touch`)
 * ainda for o lido; se não casar, relê e reaplica SÓ as mudanças pedidas.
 */
export async function gravarMembrosSemAviso(
  admin: ClienteAdmin,
  organizationId: string,
  mudancas: readonly MudancaDaMarca[],
): Promise<ResultadoDaMarca> {
  if (mudancas.length === 0) return { ok: true, ligados: 0, desligados: 0, ignorados: 0 };
  try {
    return await aplicarMudancas(admin, organizationId, mudancas);
  } catch {
    // Rede caída no meio: "não gravou" é a resposta honesta, e quem chama diz isso.
    return { ok: false };
  }
}

async function aplicarMudancas(
  admin: ClienteAdmin,
  organizationId: string,
  mudancas: readonly MudancaDaMarca[],
): Promise<ResultadoDaMarca> {
  // Marcar só quem é membro ATIVO desta organização: um id inventado no corpo
  // não pode virar lixo permanente no `settings`.
  const aMarcar = [...new Set(mudancas.filter((m) => m.nao_avisar).map((m) => m.user_id))];
  let ativos = new Set<string>();
  if (aMarcar.length > 0) {
    const { data, error } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .is("revoked_at", null)
      .in("user_id", aMarcar);
    if (error) return { ok: false };
    ativos = new Set(((data ?? []) as Array<{ user_id: string }>).map((l) => l.user_id));
  }
  const ignorados = aMarcar.filter((id) => !ativos.has(id)).length;

  for (let tentativa = 0; tentativa < TENTATIVAS_DA_GRAVACAO; tentativa += 1) {
    const { data: atual, error: erroLeitura } = await admin
      .from("organizations")
      .select("settings, updated_at")
      .eq("id", organizationId)
      .maybeSingle();
    if (erroLeitura || !atual) return { ok: false };
    const linha = atual as { settings?: unknown; updated_at?: string | null };
    const settings = (linha.settings ?? {}) as Record<string, unknown>;

    const marcados = membrosSemAvisoDeclarados(settings);
    // Contado contra o que ESTÁ gravado: ligar quem já estava ligado não é "ligou".
    let ligados = 0;
    let desligados = 0;
    for (const m of mudancas) {
      if (m.nao_avisar && ativos.has(m.user_id) && !marcados.has(m.user_id)) {
        marcados.add(m.user_id);
        ligados += 1;
      }
      if (!m.nao_avisar && marcados.delete(m.user_id)) desligados += 1;
    }

    const { data: gravadas, error } = await admin
      .from("organizations")
      .update({ settings: { ...settings, [CHAVE_DOS_MEMBROS_SEM_AVISO]: { user_ids: [...marcados] } } })
      .eq("id", organizationId)
      .eq("updated_at", linha.updated_at ?? "")
      .select("id");
    if (error) return { ok: false };
    if ((gravadas ?? []).length === 1) return { ok: true, ligados, desligados, ignorados };
    // Zero linhas: alguém gravou `organizations` entre a leitura e esta escrita.
  }
  return { ok: false };
}

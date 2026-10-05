import type { SupabaseClient } from "@supabase/supabase-js";

import { getWahaClient } from "@/lib/waha/client";

/**
 * A OPÇÃO POR CONEXÃO DA #999 — guardar o acervo do histórico do número.
 *
 * ─── Por que isto mora no `metadata` ───────────────────────────────────────
 *
 * A decisão registrada na issue é "desligado por padrão, com opção por
 * conexão". Opção por conexão precisa de casa própria, e a casa é
 * `channel_sessions.metadata` (jsonb, já existente): uma migration nova para
 * um booleano seria preço de schema por um dado de tela, e a issue estava sem
 * migration. A chave nasce ausente — o default é `false`, que é a decisão.
 *
 * ─── Ligar vale sozinho ────────────────────────────────────────────────────
 *
 * `POST /api/sessions` responde 422 quando a sessão já existe e a config NÃO é
 * aplicada nesse caminho, então gravar a opção não liga nada por si. O que
 * liga é a convergência (`convergirConfigDaSessao`), que faz GET + PUT em cima
 * do que já está lá: ela preserva filtro, `webhooks` e o resto do `noweb` e
 * só grava o `store`. A credencial de pareamento fica no volume do canal e o
 * PUT só reinicia a sessão — mas, num número JÁ pareado, ligar guarda daqui em
 * diante: o `fullSync` (cerca de 1 ano de histórico) só acontece na
 * vinculação, como a própria #999 diz ("Ligar depois não resolve"). E a doc
 * do NOWEB avisa: "Do not change the values after you scanned QR, it can lead
 * to the loss of the chat history" — desligar depois de pareado pode apagar o
 * que já está guardado. A tela diz as duas coisas.
 *
 * ─── Gravação: le-modifica-escreve, e por quê ──────────────────────────────
 *
 * Uma escrita atômica de uma chave do `metadata` seria uma RPC nova, que é
 * migration — proibida aqui. O que existe é uma troca de uma chave só, feita
 * por um administrador numa tela, e as outras chaves do `metadata`
 * (`ai_gate*`, `onboarding`) são relidas antes da escrita para serem
 * devolvidas como estavam. Se um dia dois desses painéis rodarem ao mesmo
 * tempo, o conserto é a RPC, não um bloqueio em aplicação.
 */
export const GUARDAR_HISTORICO = "guardar_historico";

/** `true` só com `true` explícito: a chave ausente é a decisão de não ligar. */
export function lerGuardarHistorico(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>)[GUARDAR_HISTORICO] === true;
}

/** Leitura da opção para a tela. `null` = não achei a conexão (ou está arquivada). */
export async function lerAcervoDoCanal(
  db: SupabaseClient,
  organizationId: string,
  canalId: string,
): Promise<boolean | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return lerGuardarHistorico(data.metadata);
}

/**
 * Grava a opção e já tenta aplicá-la na sessão que existe. Num número já
 * pareado, ligar guarda daqui em diante (ver o cabeçalho). `guardar` aqui é
 * SEMPRE explícito: este é o único caminho que pode desligar o store.
 *
 * `aplicado: false` NÃO é erro de gravação: a opção foi salva e vale na
 * próxima subida da sessão. Acontece quando o transporte não está configurado,
 * quando a sessão ainda não existe ou quando o PUT não saiu — a conversa com o
 * canal é oportunista, nunca a condição de gravar a escolha do operador.
 */
export async function salvarAcervoDoCanal(
  db: SupabaseClient,
  organizationId: string,
  canalId: string,
  guardar: boolean,
): Promise<{ guardar_historico: boolean; aplicado: boolean } | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("metadata, waha_session_name")
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const metadata = { ...((data.metadata ?? {}) as Record<string, unknown>), [GUARDAR_HISTORICO]: guardar };
  const { error: erroAoGravar } = await db
    .from("channel_sessions")
    .update({ metadata })
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .select("id")
    .maybeSingle();
  if (erroAoGravar) return null;
  const nome = (data as { waha_session_name?: string | null }).waha_session_name;
  const cliente = getWahaClient();
  const aplicado = Boolean(cliente && nome && (await cliente.convergirConfigDaSessao(nome, { guardarHistorico: guardar })));
  return { guardar_historico: guardar, aplicado };
}

/**
 * A lista de canais que uma tela pode OFERECER como destino.
 *
 * ─── Por que é uma função só, e não um `select` por tela ─────────────────────
 * O filtro de canal arquivado nasceu espalhado: cada tela com seletor de número
 * escrevia o próprio `select` em `channel_sessions`, e três ficaram sem o
 * `archived_at is null`. O efeito não é cosmético — o canal que o usuário acabou
 * de excluir continuava no dropdown, e salvar um roteador com ele devolvia 404
 * "Número de WhatsApp não encontrado nesta organização": mensagem falsa, porque
 * ele ESTÁ na organização, arquivado. Com uma função só, o próximo seletor nasce
 * filtrado sem ninguém precisar lembrar do filtro.
 *
 * ─── Por que erro SOBE ───────────────────────────────────────────────────────
 * Devolver lista vazia quando a consulta falhou é indistinguível de "esta
 * organização não tem número" — e é assim que se convida alguém a parear de novo
 * um número que já está no ar. A única falha tolerada é a coluna `archived_at`
 * não existir (código novo, banco sem a migration 0106): aí nada está arquivado,
 * e a lista sem o filtro é a lista exata (ver `./archived`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { nomeDoCanal } from "@/lib/channels/estado";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { PROVIDERS_DE_MENSAGEM } from "./capabilities";

/** Um canal oferecível como destino, já com o rótulo resolvido para a tela. */
export interface SelectableChannel {
  id: string;
  display_name: string;
  status: string;
  phone_number: string | null;
}

const COLUNAS = "id, display_name, status, phone_number, waha_session_name";

interface LinhaCanal {
  id: string;
  display_name: string | null;
  status: string;
  phone_number: string | null;
  waha_session_name: string | null;
}

/**
 * Canais ativos da organização, do mais antigo para o mais novo (ordem estável:
 * um dropdown que embaralha a cada render faz o operador clicar no item errado).
 *
 * `db` aceita tanto o client do usuário (RLS) quanto o admin — quem chama com o
 * admin já é responsável pelo `organization_id`, que aqui é sempre explícito.
 */
export async function listSelectableChannels(
  db: SupabaseClient,
  organizationId: string,
): Promise<SelectableChannel[]> {
  const base = () =>
    db
      .from("channel_sessions")
      .select(COLUNAS)
      .eq("organization_id", organizationId)
      // Esta é a FONTE ÚNICA dos seletores de "Número conectado" — e alimenta
      // também `lib/ai/agents/first-publication.ts` (que amarra o primeiro
      // agente publicado a `canais[0]`) e o retrato de
      // `app/api/v1/system/instalacao/route.ts` (que conta canal conectado).
      // Uma linha de chamada de voz (spec 18) aqui vira número escolhível,
      // agente preso a um canal mudo e "1 canal conectado" numa instalação com
      // zero canal de mensagem.
      .in("provider", [...PROVIDERS_DE_MENSAGEM]);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
  if (error) throw new Error(`channel_sessions_list_failed: ${error.message ?? "unknown"}`);

  return ((data ?? []) as LinhaCanal[]).map((c) => ({
    id: c.id,
    // ⚠️ `waha_session_name` SAIU DESTA CADEIA. Ele era o segundo degrau, e o
    // resultado aparecia na tela: um canal sem apelido virava a opção
    // `org_2dd5e6ea` no seletor "Número conectado" do editor de agente — o
    // identificador que NÓS geramos para o transporte, exposto como se fosse o
    // nome do número da pessoa. Um canal sem apelido e sem telefone é um canal
    // sem nome, e dizer isso é melhor do que inventar um.
    display_name: nomeDoCanal(c),
    status: c.status,
    phone_number: c.phone_number ?? null,
  }));
}

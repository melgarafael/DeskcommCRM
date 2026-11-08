/**
 * O NOME do responsável humano no card do funil — UMA consulta por organização.
 *
 * ─── Onde o nome mora hoje (medido, com arquivo:linha) ─────────────────────
 *
 * **Não existe tabela de perfil neste banco.** `user_organizations` guarda o
 * VÍNCULO (`user_id`, `role`, `interface_settings`, `calendar_color`) e nenhuma
 * coluna dela tem o nome da pessoa. O nome existe num lugar só: o GoTrue, em
 * `auth.users.raw_user_meta_data->>'full_name'` — fora do alcance de uma
 * consulta PostgREST (o mesmo já declarado em `lib/types/messaging.ts`, no
 * comentário de `sent_by_user_name`).
 *
 * Quem lê esse nome hoje:
 *
 *   · `app/api/v1/team/assignable/route.ts:36-42` lê `user_organizations`
 *     (id + role) e, em `:54-62`, chama `admin.auth.admin.getUserById` **uma
 *     vez por membro** — uma requisição HTTP ao GoTrue por pessoa da equipe.
 *     É a rota de que o quadro depende para o nome do dono humano.
 *   · `app/api/v1/team/route.ts:74-84` repete o mesmo na tela de Equipe.
 *   · `lib/users/nome-do-atendente.ts:70-105` deduplica os ids e ainda assim
 *     paga uma requisição por id ÚNICO (o cabeçalho de lá mede: ~60 ms para 1,
 *     ~350 ms para 10, ~1,2 s para 50).
 *
 * Trazer o nome para o payload do quadro por esse caminho custaria, portanto,
 * **uma chamada ao GoTrue por dono do quadro** — no card que mais recarrega no
 * produto. É esse custo que esta função evita.
 *
 * ─── De onde o nome vem, então, sem GoTrue ────────────────────────────────
 *
 * `conversations.assigned_to_user_name` (migration 0202) é a cópia
 * desnormalizada do MESMO `full_name`: escrita por `fn_conversation_assign` no
 * mesmo UPDATE que grava `assigned_to_user_id` e zerada quando a atribuição
 * sai. Ela existe exatamente para não pagar o GoTrue — e é coluna de banco,
 * alcançável numa consulta só.
 *
 * E o dono do NEGÓCIO acompanha o dono da CONVERSA: a 9208 põe a régua dentro
 * de `fn_conversation_assign` (na transferência leva o negócio aberto do
 * contato; em claim/routing/handoff dá dono ao negócio sem responsável), então
 * o nome de quem responde pelos negócios do quadro está nessa cópia.
 *
 * ─── O que fica de fora, declarado ───────────────────────────────────────
 *
 * Quem tem negócio mas nunca foi atribuído a uma conversa da organização não
 * tem cópia: `owner_user_name` vem `null` e o card cai no rótulo anterior
 * ("Responsável"), com o nome do mapa de `/team/assignable` quando ele estiver
 * carregado — nunca "undefined", nunca e-mail cru. Nome ausente é estado
 * legítimo, o mesmo contrato de `resolveLeadOwner` (`lib/kanban/owner.ts`).
 *
 * A alternativa EXATA (RPC que lesse `auth.users`, ou desnormalizar o nome na
 * própria linha do negócio) é decisão de schema — migration, superfície nova e
 * espelho no baseline —, não um detalhe desta fatia.
 */
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/lib/types/leads";

/** Quantas colunas o card precisa desta leitura. */
interface LinhaDaAtribuicao {
  assigned_to_user_id: string | null;
  assigned_to_user_name: string | null;
}

/**
 * O nome como o card pode desenhá-lo — ou `null`.
 *
 * Duas recusas, de propósito:
 *
 *  1. **vazio/espaço** não é nome: um `full_name = "   "` produziria um disco
 *     com iniciais "?" e um rótulo em branco, que é pior que o rótulo genérico;
 *  2. **e-mail cru** não é nome. `full_name` é campo livre do cadastro, e em
 *     instalação real ele recebe o e-mail digitado no lugar do nome — publicar
 *     isso no card seria vazar PII para a tela toda (a régua de
 *     `team/assignable` é expor o MÍNIMO: nem e-mail, nem `user_metadata`).
 *
 * Espaço interno é colapsado porque o nome vem de um `<input>` sem máscara:
 * "Maria   Silva" e "Maria Silva" são a mesma pessoa e o badge trunca por
 * caractere.
 */
export function nomeLegivel(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string") return null;
  const nome = bruto.trim().replace(/\s+/g, " ");
  if (nome.length === 0) return null;
  if (nome.includes("@")) return null;
  return nome;
}

/**
 * Anexa `owner_user_name` aos negócios com dono HUMANO.
 *
 * Uma leitura por CHAMADA (a organização inteira filtrada pelos ids do quadro),
 * não uma por negócio: o teste de contagem compara 2 e 12 negócios e exige o
 * mesmo número de consultas. Sem nenhum dono humano, sai daqui sem consultar
 * nada — quadro de funil tocado só pela IA não paga nem a ida ao banco.
 *
 * `organization_id` é filtrado explicitamente e vem do pipeline já validado
 * pela RLS do chamador: é isso que impede o nome de alguém de outra
 * organização de aparecer (o mesmo cuidado de `withOwnerAgents`).
 *
 * **Falha de leitura NÃO derruba o quadro.** O nome é cortesia; o quadro é a
 * tela. Um erro aqui devolve os negócios como vieram — o card cai no rótulo
 * anterior e continua dizendo que há um responsável (`owner_user_id` é a
 * verdade, o nome é o enfeite), com uma linha de log para o erro não sumir.
 * É a mesma escolha de `lib/users/nome-do-atendente.ts`, e o oposto do que as
 * etapas de DADO fazem nesta rota (score, tarefa, conversa): aquelas, se não
 * sabem, o card não pode afirmar que não há.
 */
export async function withOwnerUserNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<Lead[]> {
  const donos = [
    ...new Set(
      leads
        .map((l) => l.owner_user_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (donos.length === 0) return leads;

  const { data, error } = await supabase
    .from("conversations")
    .select("assigned_to_user_id, assigned_to_user_name")
    .eq("organization_id", organizationId)
    .in("assigned_to_user_id", donos)
    // `null` não é nome, e sem este filtro a leitura traria TODA conversa dos
    // donos (milhares, num número movimentado) para descartar quase tudo aqui.
    .not("assigned_to_user_name", "is", null);

  if (error) {
    logger.warn("[nome-do-dono] cópia do nome não lida: o card cai no rótulo anterior", {
      organizationId,
      donos: donos.length,
      erro: error.message,
    });
    return leads;
  }

  const nomePorId = new Map<string, string>();
  for (const linha of (data ?? []) as LinhaDaAtribuicao[]) {
    const id = linha.assigned_to_user_id;
    if (!id || nomePorId.has(id)) continue;
    const nome = nomeLegivel(linha.assigned_to_user_name);
    if (nome) nomePorId.set(id, nome);
  }
  // Sem nenhum nome utilizável a lista AINDA é percorrida: o resultado diz
  // "olhei e nenhum destes donos tem nome" (`null` explícito), que é diferente
  // do erro acima, em que não se olhou (campo ausente). O card trata os dois
  // igual — cai no rótulo anterior —, mas quem depurar o payload precisa poder
  // distinguir.
  return leads.map((lead) => {
    if (!lead.owner_user_id) return lead;
    // `null` EXPLÍCITO quando não há cópia: é a declaração de "olhei e esta
    // pessoa não tem nome", não o silêncio de um campo que ninguém preencheu.
    return { ...lead, owner_user_name: nomePorId.get(lead.owner_user_id) ?? null };
  });
}

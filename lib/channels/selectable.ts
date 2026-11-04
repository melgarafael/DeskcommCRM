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
import { lerModoDeAcessoDaIa, lerNumerosDeTeste } from "@/lib/ai/elegibilidade/pre-go-live";
import type { AcessoDaAiDoCanal } from "@/lib/ai/elegibilidade/aviso-do-modo-de-teste";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { PROVIDERS_DE_MENSAGEM, capabilitiesOf, transportaMensagem } from "./capabilities";
import type { ProviderDeMensagem } from "./types";

/** Um canal oferecível como destino, já com o rótulo resolvido para a tela. */
export interface SelectableChannel {
  id: string;
  display_name: string;
  status: string;
  phone_number: string | null;
  /**
   * O canal manda TEXTO LIVRE a qualquer hora?
   *
   * É a pergunta que a conexão de avisos de caso precisa fazer, e ela é de
   * CAPACIDADE, não de provedor: o aviso sai quando a IA trava, sem nenhuma
   * janela de 24 horas aberta pela equipe — e nunca haverá uma, porque o número
   * do suporte não conversa com ninguém. Um canal que exige modelo aprovado
   * aceitaria a configuração e nunca entregaria um aviso.
   *
   * Sai daqui, e não de um `if` na tela, porque `docs/doctrine/restricao-de-
   * canal.md` (invariante 1) proíbe nome de provedor fora de `lib/channels/` —
   * e `pnpm lint:channels` reprova, inclusive em comentário. O campo é ADITIVO:
   * quem já consumia `SelectableChannel` não muda uma linha.
   */
  aceitaMensagemLivre: boolean;
  /**
   * Como o acesso da IA está NESTE canal — modo e quantos números de teste estão
   * autorizados. Sem isto, a tela do agente não tinha como saber que o número
   * escolhido está em modo de teste com a lista vazia, que é o estado de fábrica
   * de todo canal: a IA não responde ninguém e a tela dizia que estava tudo
   * certo (#3976).
   *
   * Contagem, nunca a lista: os telefones autorizados são PII e exigem
   * administrador (`/api/v1/channel-sessions/[id]/ai-access`). Quem decide a
   * frase é `decidirAvisoDoModoDeTeste` — a tela não reescreve a regra.
   */
  acessoDaAi: AcessoDaAiDoCanal;
}

// `provider` entra no `select` por causa de `aceitaMensagemLivre`. Ele é lido
// aqui e MORRE aqui: o DTO leva a capacidade, nunca o nome do provedor.
//
// `metadata` entra SÓ para derivar `acessoDaAi` (modo e contagem). O DTO leva o
// resumo, nunca a metadata crua — é ela que carrega os telefones de teste.
const COLUNAS = "id, display_name, status, phone_number, waha_session_name, provider, metadata";

interface LinhaCanal {
  id: string;
  display_name: string | null;
  status: string;
  phone_number: string | null;
  waha_session_name: string | null;
  provider: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * A capacidade de mandar texto livre, resolvida sem deixar o erro escapar.
 *
 * `capabilitiesOf` LANÇA para provedor fora da matriz — é o fail-closed certo no
 * caminho de ENVIO. Aqui ele seria o desfecho errado: um clone que aplicou o
 * baseline antes de puxar a imagem nova tem, na coluna, um provedor que este
 * build não conhece, e um throw apagaria a lista INTEIRA de conexões — inclusive
 * as que funcionam. `false` é a resposta conservadora e local: "não use ESTE
 * canal para mandar recado".
 */
function aceitaMensagemLivre(provider: string | null): boolean {
  if (!transportaMensagem(provider)) return false;
  try {
    return capabilitiesOf(provider as ProviderDeMensagem).freeformOutsideWindow;
  } catch {
    return false;
  }
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
    aceitaMensagemLivre: aceitaMensagemLivre(c.provider),
    acessoDaAi: {
      // O MESMO leitor do runtime (`gate.ts` → `lerModoDeAcessoDaIa`): a tela
      // não pode chamar de "modo de teste" um canal que o motor trata de outro
      // jeito, nem o contrário.
      mode: lerModoDeAcessoDaIa(c.metadata),
      testNumbersCount: lerNumerosDeTeste(c.metadata).length,
    },
  }));
}

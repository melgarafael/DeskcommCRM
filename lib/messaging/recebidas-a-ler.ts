/**
 * Quais mensagens do cliente ESTA resposta lê — a lista que vai em
 * `OutboundEnvelope.readExternalIds` para o canal marcá-las como lidas (#5015).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * O visto azul (#2981) pedia ao canal "li esta conversa", sem dizer quais
 * mensagens. No NOWEB com "Guardar histórico" desligado — o padrão desde o #999 —
 * o canal por QR só sabe marcar por mensagem e recusa o pedido sem ids com 400. O adapter
 * não lê banco (`docs/doctrine/restricao-de-canal.md`), então a lista é resolvida
 * aqui, por quem monta o envelope, como já é o `external_id` da citada.
 *
 * ─── A régua ────────────────────────────────────────────────────────────────
 *
 * "Respondi, então li" = as mensagens que o cliente mandou DEPOIS do último envio
 * nosso que saiu de verdade, na ordem em que o CRM as viu (`created_at`). Não é
 * `sent_at`: o webhook do canal por QR traz a hora em SEGUNDOS, e uma mensagem que
 * chegou no mesmo segundo da resposta anterior pareceria mais velha que ela.
 *
 *   - Envio que falhou ou ainda está na fila não respondeu nada: não fecha a régua.
 *   - Reação e mensagem de sistema não são resposta nem mensagem que alguém
 *     responde (como em `ultimaMensagemDoCliente`, `lib/messaging/presenca.ts`):
 *     ficam fora dos dois lados. O 👍 do atendente antes do texto não é a resposta.
 *   - A linha do próprio envio em curso (já inserida pelo handler) fica de fora
 *     pelo id.
 *   - Linha sem `external_id` não tem como ser endereçada.
 *   - Linha do acervo importado (`metadata.historico_importado = 'true'`, ver
 *     `lib/channels/historico/mapear.ts`) fica fora dos dois lados: o
 *     `created_at` dela é a hora da IMPORTAÇÃO, e uma resposta antiga importada
 *     agora pareceria a resposta mais recente.
 *
 * A comparação de horas é pelo TEXTO que o banco devolve, não por `Date.parse`:
 * o Postgres guarda microssegundos, e o milissegundo do JavaScript juntaria duas
 * linhas diferentes na mesma hora. No formato ISO do PostgREST a ordem do texto
 * é a ordem do tempo.
 *
 * Os filtros vão para o banco ANTES do teto, para registros que não contam não
 * empurrarem para fora a mensagem que conta. Teto de 30: o mesmo que o canal por QR
 * aplica ao "li a conversa" numa conversa individual. Devolve da mais antiga para
 * a mais nova.
 *
 * ─── Lista vazia e falha ────────────────────────────────────────────────────
 *
 * Nada novo, erro de leitura ou leitura lenta devolvem `undefined`: o canal faz
 * o pedido de antes (a conversa inteira), que segue valendo para quem tem o store
 * ligado — é o que a issue sugere, e quem tem store não perde nada. A leitura tem
 * teto de tempo porque roda ANTES do envio: o visto é enfeite da resposta e nunca
 * a segura.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O teto do próprio canal por QR para "li a conversa" numa conversa individual. */
const MAXIMO_DE_IDS = 30;
/** Quanto a leitura pode atrasar o envio, no pior caso. */
const TETO_DA_LEITURA_MS = 2_000;
/** Status de saída em que a mensagem chegou ao transporte — a resposta existiu. */
const SAIU = ["sent", "delivered", "read", "replied"];
/** Tipos que não são fala: nem resposta, nem mensagem que alguém responde. */
const NAO_E_FALA = ["reaction", "system"];
const NAO_E_FALA_FILTRO = `(${NAO_E_FALA.join(",")})`;

interface LinhaDaConversa {
  id: string;
  direction: string | null;
  type: string | null;
  status: string | null;
  external_id: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RecebidasALerInput {
  /** De FONTE CONFIÁVEL (`ctx`), nunca do corpo: o client pode ser de service role. */
  organizationId: string;
  conversationId: string;
  /** A linha do envio em curso, que não conta como resposta anterior. */
  envioId: string;
}

const COLUNAS = "id, direction, type, status, external_id, created_at, metadata";
const IMPORTADA = "metadata->>historico_importado";
/**
 * Fora do acervo = a marca não é `'true'`. É a régua do repositório
 * (`tests/invariants/historico-importado-nao-dispara.test.ts`): `is null` sozinho
 * também tiraria `'false'`, e `neq` sozinho tiraria a linha sem a chave (NULL).
 */
const FORA_DO_ACERVO = `${IMPORTADA}.is.null,${IMPORTADA}.neq.true`;
const hora = (l: LinhaDaConversa) => l.created_at ?? "";
const maisNovaPrimeiro = (a: LinhaDaConversa, b: LinhaDaConversa) =>
  hora(a) < hora(b) ? 1 : hora(a) > hora(b) ? -1 : 0;
const eFala = (l: LinhaDaConversa) => !NAO_E_FALA.includes(l.type ?? "");
const doAcervo = (l: LinhaDaConversa) => String(l.metadata?.historico_importado ?? "") === "true";

async function ler(
  supabase: SupabaseClient,
  input: RecebidasALerInput,
  desistiu: () => boolean,
): Promise<string[] | undefined> {
  // 1. A última resposta que saiu de verdade.
  const anteriores = await supabase
    .from("messages")
    .select(COLUNAS)
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .eq("direction", "outbound")
    .in("status", SAIU)
    .not("type", "in", NAO_E_FALA_FILTRO)
    .or(FORA_DO_ACERVO)
    .neq("id", input.envioId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (anteriores.error || !Array.isArray(anteriores.data)) return undefined;
  // A régua é refeita aqui também: o filtro do banco é a economia, esta é a regra.
  const ultima = (anteriores.data as LinhaDaConversa[])
    .filter(
      (l) =>
        l.direction === "outbound" &&
        SAIU.includes(l.status ?? "") &&
        eFala(l) &&
        !doAcervo(l) &&
        l.id !== input.envioId,
    )
    .sort(maisNovaPrimeiro)[0];
  const desde = ultima?.created_at ?? null;
  // O teto de tempo já venceu: o envio seguiu sem esperar, e a segunda leitura
  // não teria a quem servir.
  if (desistiu()) return undefined;

  // 2. O que o cliente mandou depois dela.
  let consulta = supabase
    .from("messages")
    .select(COLUNAS)
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .eq("direction", "inbound")
    .not("type", "in", NAO_E_FALA_FILTRO)
    .not("external_id", "is", null)
    .or(FORA_DO_ACERVO);
  if (desde) consulta = consulta.gt("created_at", desde);
  const recebidas = await consulta.order("created_at", { ascending: false }).limit(MAXIMO_DE_IDS);
  if (recebidas.error || !Array.isArray(recebidas.data)) return undefined;

  const ids = (recebidas.data as LinhaDaConversa[])
    .filter((l) => l.direction === "inbound" && eFala(l) && !doAcervo(l) && !!l.external_id)
    .filter((l) => !desde || hora(l) > desde)
    .sort(maisNovaPrimeiro)
    .slice(0, MAXIMO_DE_IDS)
    .map((l) => l.external_id as string)
    .reverse();
  return ids.length > 0 ? ids : undefined;
}

export async function recebidasQueARespostaLe(
  supabase: SupabaseClient,
  input: RecebidasALerInput,
): Promise<string[] | undefined> {
  let teto: ReturnType<typeof setTimeout> | undefined;
  let venceu = false;
  try {
    return await Promise.race([
      ler(supabase, input, () => venceu),
      new Promise<undefined>((resolve) => {
        teto = setTimeout(() => {
          venceu = true;
          resolve(undefined);
        }, TETO_DA_LEITURA_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (teto) clearTimeout(teto);
  }
}

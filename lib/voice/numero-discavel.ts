/**
 * O NÚMERO QUE A LIGAÇÃO DISCA É O QUE O WHATSAPP REGISTROU, NÃO O DO CADASTRO.
 *
 * Medido na VPS em 2026-09-15: o contato `+5531998966398` foi discado como
 * `5531998966398@s.whatsapp.net`. O WhatsApp registra esse celular como
 * `553198966398` — sem o nono dígito, o caso comum em DDD fora de São Paulo —,
 * e o canal de mensagens da organização confirmou (as duas grafias responderam
 * `553198966398@c.us`). O serviço de voz não pergunta nada a ninguém: monta o
 * destino com `types.NewJID(dígitos, DefaultUserServer)`. A oferta saiu para um
 * endereço que não existe, o painel ficou em "Chamando…" e a ligação expirou
 * sem que telefone nenhum tocasse.
 *
 * O CRM guarda o celular brasileiro COM o nono dígito, de propósito
 * (`lib/channels/phone-variants.ts`), e o envio de mensagem já pergunta ao
 * canal qual grafia existe. A ligação faz o mesmo, pela porta do canal
 * (`ChannelAdapter.resolveRegisteredPhone`): percorre as sessões de mensagem em
 * pé da organização e pergunta a quem souber responder. Qual plataforma
 * responde é assunto de `lib/channels/`, não daqui — o `lint:channels` reprova
 * este arquivo se ele nomear uma.
 *
 * Falha ABERTA: sem sessão de mensagens em pé, canal que não sabe responder, só
 * identidade opaca, consulta que falha ou que passa do prazo — disca o número
 * do cadastro, exatamente o comportamento anterior. Recusar aqui trocaria "às
 * vezes não toca" por "nunca liga".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CHANNEL_SESSION_REF_COLUMNS,
  PROVIDERS_DE_MENSAGEM,
  getAdapter,
  resolveSessionRef,
  type ChannelAdapter,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";

/**
 * Quanto a ligação espera o canal responder antes de discar o cadastro.
 *
 * Cada consulta tem teto de 15 s no cliente do transporte e são até duas grafias
 * em série: com o canal aceitando conexão e sem responder, a rota passava dos
 * 30 s em que o navegador desiste de uma escrita (`MUTATION_TIMEOUT_MS`). A tela
 * mostrava erro, o botão seguia livre para outro clique, e a ligação saía mesmo
 * assim ~31 s depois — uma por clique. Numa resposta normal a consulta volta em
 * dezenas de milissegundos; 4 s é folga, não estimativa.
 */
export const PRAZO_DA_CONSULTA_MS = 4_000;

export interface NumeroDiscavel {
  /** Só dígitos, sem `+` — a forma que `POST /api/sessions/{sid}/calls` recebe. */
  digitos: string;
  /** `whatsapp` = confirmado pelo canal; `cadastro` = fallback sem confirmação. */
  fonte: "whatsapp" | "cadastro";
}

export async function resolverNumeroDiscavel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  organizationId: string,
  telefone: string,
  deps: { adapterDe?: (provider: ChannelProvider) => ChannelAdapter; prazoMs?: number } = {},
): Promise<NumeroDiscavel> {
  const doCadastro: NumeroDiscavel = { digitos: telefone.replace(/\D/g, ""), fonte: "cadastro" };
  const adapterDe = deps.adapterDe ?? getAdapter;

  const { data } = await supabase
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("status", "WORKING")
    .is("archived_at", null)
    .in("provider", [...PROVIDERS_DE_MENSAGEM])
    .limit(10);
  const sessoes = (data ?? []) as ChannelSessionRef[];
  if (sessoes.length === 0) return doCadastro;

  // Qualquer sessão que saiba responder serve: a pergunta é ao diretório da
  // plataforma, e a resposta não depende de qual conta perguntou.
  const procurar = async (): Promise<string | null> => {
    for (const sessao of sessoes) {
      let adapter: ChannelAdapter;
      try {
        adapter = adapterDe(sessao.provider);
      } catch {
        continue;
      }
      if (!adapter.resolveRegisteredPhone || !adapter.isConfigured()) continue;
      const sessionRef = resolveSessionRef(sessao);
      if (!sessionRef) continue;
      const digitos = await adapter
        .resolveRegisteredPhone({ organizationId, sessionRef, phone: telefone })
        .catch(() => null);
      if (digitos) return digitos;
    }
    return null;
  };

  // A consulta que estoura o prazo segue em segundo plano e é descartada: é
  // leitura, não tem efeito a desfazer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.prazoMs ?? PRAZO_DA_CONSULTA_MS);
  });
  try {
    const digitos = await Promise.race([procurar(), prazo]);
    return digitos ? { digitos, fonte: "whatsapp" } : doCadastro;
  } finally {
    clearTimeout(timer);
  }
}

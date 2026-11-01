/**
 * As guardas COMPARTILHADAS por toda ação que manda mensagem para um contato:
 * existe, não está bloqueado, tem telefone, tem consentimento.
 *
 * Nasceu porque a mesma sequência de 3 `if`s vivia em `send-whatsapp.ts` e em
 * `send-ai-message.ts` — irmãs de propósito (mesmo comentário de cabeçalho:
 * "MESMAS guardas... reescrevê-las aqui faria a ação nova nascer sem o
 * conserto que a antiga acabou de receber"). O gate de consentimento nasceu
 * SÓ na primeira (achado 2026-08-25) e ficaria esquecido na segunda até
 * alguém notar — exatamente o "conserto por instância" que este repo já
 * pagou (ver `desfecho-do-envio.ts`, mesmo raciocínio para o desfecho do
 * envio). Um módulo só, as duas ações chamam.
 *
 * ═══ Por que a recusa é um gate FIXO, não uma `condition` declarável ═══
 *
 * Porque não pode ter exceção por regra mal configurada. Uma condição
 * declarável (`lib/automation/conditions.ts`) depende de quem a configura —
 * até o #2727, campo ausente + `neq` era verdadeiro —, e um admin pode
 * escrevê-la errado ou apagá-la, deixando passar exatamente o caso mais
 * perigoso. Invariante de conformidade fica em código, não em configuração
 * que um admin desliga sem querer.
 *
 * ═══ Por que ele lê `declined_at`, e NÃO a ausência de `granted_at` ═══
 *
 * Esta é a parte contra-intuitiva, e ela é medida, não opinada. O DEFAULT da
 * coluna `contacts.consent` (ver `supabase/baseline.sql`) já é
 *
 *     {"marketing": {"granted_at": null, "source": null, "version": null}, …}
 *
 * — ou seja, TODO contato do produto nasce com a mesma forma que uma recusa
 * deixaria. Bloquear por `granted_at` ausente bloqueia dois estados de uma vez:
 * "a pessoa disse não" e "**ninguém nunca perguntou**".
 *
 * E o segundo é a instalação inteira. Medido na `main` de 2026-08-26: o único
 * escritor de `consent.marketing.granted_at` em código de produção é o mapeador
 * do Respondi (`buildContactConsentGrant`, um call site), e não existe **nenhum**
 * controle de consentimento em `components/` ou `app/app/`. Um gate por ausência
 * faria toda automação de WhatsApp parar de enviar para lead de webhook
 * genérico, de importação, de criação manual e de inbound — sem tela para
 * consertar, e sem migração. Num produto self-host, isso é o cliente concluindo
 * que o produto quebrou.
 *
 * `declined_at` é a chave que só existe quando alguém respondeu NÃO
 * (`buildContactConsentDenial`, escrita pela ingestão). É sobre ela que a
 * guarda decide, e é o que torna verdadeira a promessa que a própria rota de
 * webhook já escrevia na `main`: a recusa registrada "pra quem olha o dossiê
 * saber POR QUE nenhuma automação de 1º toque disparou pra este lead".
 *
 * Coerente, além disso, com o gate de LGPD que este repositório já tem
 * (`lib/agent-engine/guardrails/lgpd/legal-basis.ts`): lá está escrito que
 * responder a quem te procurou NÃO é prospecção e não exige base legal de
 * prospecção — "do contrário todo 1º reply de inbound seria vetado". Quem
 * preencheu o seu formulário te procurou. Quem disse "não me mande mensagem",
 * não.
 */
import type { ActionCtx } from "@/lib/automation/types";

export type MotivoDeBloqueio = "no_contact" | "contact_blocked" | "no_phone" | "consent_declined";

export interface ContatoLiberadoParaEnvio {
  id: string;
  phone_number: string;
}

interface ContatoDoContexto {
  id: string;
  is_blocked?: boolean;
  phone_number?: string | null;
  consent?: { marketing?: { granted_at?: string | null; declined_at?: string | null } | null } | null;
}

export type ResultadoDaGuarda =
  | { ok: true; contact: ContatoLiberadoParaEnvio }
  | { ok: false; reason: MotivoDeBloqueio };

/**
 * Corre as 4 guardas, na ordem que mais barato falha primeiro (nenhum dado
 * lido antes de saber que há contato). Devolve o contato tipado e estreito
 * (só o que o chamador precisa) quando passa; a razão do bloqueio quando não.
 */
export function checarGuardasDeContato(ctx: ActionCtx): ResultadoDaGuarda {
  const contact = ctx.context.contact as ContatoDoContexto | undefined;
  if (!contact) return { ok: false, reason: "no_contact" };
  if (contact.is_blocked) return { ok: false, reason: "contact_blocked" };
  if (!contact.phone_number) return { ok: false, reason: "no_phone" };
  // Recusa registrada — não "grant ausente". Ver o cabeçalho.
  if (contact.consent?.marketing?.declined_at) return { ok: false, reason: "consent_declined" };
  return { ok: true, contact: { id: contact.id, phone_number: contact.phone_number } };
}

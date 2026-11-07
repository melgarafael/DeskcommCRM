/**
 * POR QUE A AGENDA DO CELULAR NÃO FOI LIDA — em função pura (#4102).
 *
 * ─── O defeito que este módulo tira do lugar ────────────────────────────────
 *
 * A rota tratava TODO erro de transporte como "o WhatsApp não respondeu,
 * confira se ele está conectado". Na comunidade, o número estava conectado e
 * funcionando: no NOWEB sem store o `GET /api/contacts/all` devolve **400**, e o
 * 400 é o pedido para ligar "Guardar o histórico anterior à vinculação" na
 * conexão. A pessoa foi mandada reconectar o que já estava conectado — e só
 * resolveu quando achou sozinha uma opção que a tela não citava.
 *
 * ─── Por que o 400 é causa própria, e o resto não ──────────────────────────
 *
 * O código cru do transporte (`waha_contacts_all_<status>`, `lib/waha/client.ts`)
 * diz QUAL status o WAHA devolveu; 400 é o único que tem um conserto do lado de
 * quem está na tela e um nome de botão para citar. Os demais (403, 404, 5xx,
 * teto de tempo) continuam na frase da conexão — é o que eles são, e inventar
 * uma causa por status seria adivinhar. O código cru vai para o log junto do
 * motivo escolhido: a frase é para quem clica, o código é para quem investiga.
 */

/** O que a recusa da agenda quer dizer, e qual botão resolve. */
export type CodigoDaRecusaDaAgenda = "acervo_desligado" | "transporte";

/**
 * O mesmo pedido que `ACERVO_DESLIGADO` faz na importação do histórico
 * (`app/api/v1/channel-sessions/[id]/historico/route.ts`), com o nome EXATO do
 * botão da tela de Conexões (`components/connections/ChannelAcervo.tsx`).
 */
export const MSG_ACERVO_DESLIGADO_NA_AGENDA =
  "Para ler a agenda, ligue 'Guardar o histórico anterior à vinculação' na conexão deste número (Conexões) e tente de novo.";

export const MSG_TRANSPORTE_SEM_RESPOSTA =
  "O WhatsApp deste número não respondeu. Confira se ele está conectado e tente de novo.";

export interface RecusaDaAgenda {
  codigo: CodigoDaRecusaDaAgenda;
  /** A frase da tela — chave do dicionário PT/ES (`lib/i18n/dicionario.ts`). */
  mensagem: string;
}

/**
 * Traduz o erro do transporte na recusa certa.
 *
 * Aceita `unknown` porque é isso que o `catch` entrega; o reconhecimento é pelo
 * código cru que `listarAgendaDoAparelho` lança, não pelo texto da mensagem de
 * erro do WAHA (que muda entre builds).
 */
export function recusaDaAgenda(causa: unknown): RecusaDaAgenda {
  const bruto = causa instanceof Error ? causa.message : String(causa ?? "");
  // `\b` para não casar `..._4000` nem um status futuro com o mesmo prefixo.
  if (/waha_contacts_all_400\b/.test(bruto)) {
    return { codigo: "acervo_desligado", mensagem: MSG_ACERVO_DESLIGADO_NA_AGENDA };
  }
  return { codigo: "transporte", mensagem: MSG_TRANSPORTE_SEM_RESPOSTA };
}

/**
 * As três leituras que fazemos no Microsoft Graph: quem é a conta, quais agendas
 * ela tem e o que ocupa cada uma numa janela.
 */
const RAIZ = "https://graph.microsoft.com/v1.0";
const PRAZO_MS = 15_000;
/** Teto de páginas. Passou disto, a leitura FALHA: meia agenda não é cobertura. */
export const TETO_DE_PAGINAS = 40;

export class ErroDoGraph extends Error {
  constructor(readonly status: number) {
    super(`Microsoft Graph respondeu ${status}`);
    this.name = "ErroDoGraph";
  }
}

export interface AgendaDaMicrosoft {
  id: string;
  nome: string;
  principal: boolean;
}

export interface EventoDaMicrosoft {
  id?: string;
  iCalUId?: string | null;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
}

export function graphDaMicrosoft(accessToken: string, buscar: typeof fetch = fetch) {
  async function ler(url: string): Promise<Record<string, unknown>> {
    // O token só viaja para o Graph: `@odata.nextLink` vem de fora.
    if (!url.startsWith(`${RAIZ}/`)) throw new ErroDoGraph(502);
    const resposta = await buscar(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        prefer: 'outlook.timezone="UTC", odata.maxpagesize=250',
      },
      signal: AbortSignal.timeout(PRAZO_MS),
      cache: "no-store",
      redirect: "error",
    });
    if (!resposta.ok) throw new ErroDoGraph(resposta.status);
    return (await resposta.json()) as Record<string, unknown>;
  }

  async function paginas<T>(primeira: string): Promise<T[]> {
    const itens: T[] = [];
    let url: string | null = primeira;
    for (let n = 0; url; n += 1) {
      if (n >= TETO_DE_PAGINAS) throw new ErroDoGraph(413);
      const pagina: Record<string, unknown> = await ler(url);
      if (!Array.isArray(pagina.value)) throw new ErroDoGraph(502);
      itens.push(...(pagina.value as T[]));
      const proxima = pagina["@odata.nextLink"];
      url = typeof proxima === "string" ? proxima : null;
    }
    return itens;
  }

  return {
    async conta(): Promise<string | null> {
      const eu = await ler(`${RAIZ}/me?$select=mail,userPrincipalName`);
      const email = eu.mail || eu.userPrincipalName;
      return typeof email === "string" && email ? email.toLowerCase() : null;
    },
    async agendas(): Promise<AgendaDaMicrosoft[]> {
      const itens = await paginas<{ id?: string; name?: string; isDefaultCalendar?: boolean }>(
        `${RAIZ}/me/calendars?$select=id,name,isDefaultCalendar&$top=100`,
      );
      return itens.flatMap((a) =>
        a.id ? [{ id: a.id, nome: a.name || a.id, principal: a.isDefaultCalendar === true }] : [],
      );
    },
    ocupacao(agendaId: string, de: string, ate: string): Promise<EventoDaMicrosoft[]> {
      const q = new URLSearchParams({
        startDateTime: de,
        endDateTime: ate,
        // Sem assunto, corpo nem convidados: só o que ocupa hora.
        $select: "id,iCalUId,start,end,isAllDay,isCancelled,showAs",
        $top: "250",
      });
      return paginas<EventoDaMicrosoft>(
        `${RAIZ}/me/calendars/${encodeURIComponent(agendaId)}/calendarView?${q}`,
      );
    },
  };
}

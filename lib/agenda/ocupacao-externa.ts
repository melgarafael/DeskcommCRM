/**
 * A ocupação do Google Agenda que a TELA da Agenda mostra — uma leitura só.
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * A mesma ocupação era lida em DOIS lugares, com a MESMA consulta copiada: a
 * semente do servidor (`app/app/agenda/page.tsx`) e a resposta da rota
 * (`app/api/v1/agenda/agendamentos/route.ts`). Duas cópias da mesma regra
 * divergem no dia em que só uma delas muda — é o defeito da issue #525.
 *
 * ─── O recorte é INTERSEÇÃO de intervalos ───────────────────────────────────
 *
 * O motor de disponibilidade (`fn_agenda_ocupacao_google_do_dono`, migration
 * 0260) considera o compromisso ocupado quando `starts_at < fim AND ends_at >
 * inicio` — sobreposição real de intervalos. A tela comparava só o COMEÇO
 * (`starts_at >= inicio AND starts_at < fim`), então o compromisso que ATRAVESSA
 * o limite do recorte — 23:30 de ontem até 00:30 de hoje, pedindo o recorte de
 * hoje — sumia da grade enquanto o motor o recusava marcar: a tela mostrava
 * livre o horário que a marcação recusa. Quem mede os dois lados é
 * `tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts`.
 *
 * ─── O que o bloco devolvido descreve ───────────────────────────────────────
 *
 * A FATIA VISÍVEL dentro do recorte pedido. `GradeDaAgenda` atribui cada bloco à
 * coluna do dia pelo seu INÍCIO (`isSameDay(comeca, coluna)`): devolver o
 * instante cru de um evento que começa antes do recorte jogaria o bloco para
 * fora de toda coluna desenhada — a tela ficaria vazia de novo, agora por outro
 * motivo. Fatiar no limite do recorte é o que faz a tela desenhar a ocupação que
 * o motor já recusava.
 *
 * Mesma decisão do motor, um limite a mais: um compromisso que ACABA exatamente
 * no começo do recorte não ocupa nenhum minuto dele, e um que COMEÇA exatamente
 * no fim também não — as duas comparações são estritas.
 *
 * ─── O que fica de fora ─────────────────────────────────────────────────────
 *
 * `transparent` no Google é "livre": o evento existe e não ocupa. `cancelled`
 * não aconteceu. Trazer os dois como bloco diria que o horário está tomado
 * quando a própria pessoa marcou que não está — o mesmo filtro que a coleta do
 * motor aplica.
 *
 * ─── ⚠️ ALCANCE DECLARADO: fecha a FRONTEIRA, não o PAPEL ───────────────────
 *
 * Esta leitura é pela SESSÃO de quem abriu a tela, com o embed
 * `calendar_connections!inner`. A RLS de `calendar_connections`
 * (`calendar_connections_dono_ou_manager_read`, em `supabase/baseline.sql`) só
 * libera `user_id = auth.uid()` ou `fn_role_at_least(organization_id,
 * 'manager')` — então, para `viewer` e `agent`, a conexão do colega fica
 * escondida e a grade segue SEM a ocupação do Google desse colega.
 *
 * O motor, não: `fn_agenda_ocupacao_google_do_dono` (migration 0260) é
 * `security definer` e entrega a ocupação a todo membro da organização. Logo,
 * para esses dois papéis a tela continua desenhando livre TODO compromisso do
 * colega — não só o que atravessa a borda do recorte — enquanto o motor recusa
 * marcar. É a MESMA discordância tela↔motor da issue #525, pela metade que este
 * módulo não fecha: a da fronteira ficou fechada, a do PAPEL de quem olha
 * continua aberta (resíduo da issue #879).
 *
 * Fechar isso é decisão de produto sobre QUEM enxerga a ocupação de quem — não
 * é conserto de consulta. Quando for tomada, o lugar de aplicá-la é este
 * arquivo (trocar o caminho de leitura), e o registro da pendência está em
 * `docs/testing/user-journey-map.md`, J13.13.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Um compromisso externo como a tela o desenha: rótulo, dono e a fatia do recorte. */
export interface BlocoExternoDaTela {
  id: string;
  /** `calendar_connections.user_id` — a agenda dona do compromisso. */
  donoId: string | null;
  /** ISO — começo da fatia visível (nunca antes de `de`). */
  iniciaEm: string;
  /** ISO — fim da fatia visível (nunca depois de `ate`). */
  terminaEm: string;
}

export interface RecorteDaAgenda {
  organizationId: string;
  /** ISO — começo do recorte pedido pela tela. */
  de: string;
  /** ISO — fim do recorte pedido pela tela (o motor também trata o fim como exclusivo). */
  ate: string;
}

export interface LeituraDaOcupacaoExterna {
  blocos: BlocoExternoDaTela[];
  /**
   * Mensagem do banco, quando a leitura falha. A decisão de derrubar ou não a
   * tela é de QUEM chama: na rota, sem ocupação a grade fica pobre e sem
   * agendamento ela fica errada — o `warn` fica lá; na semente, a página segue.
   */
  erro: string | null;
}

/** A linha como o PostgREST a entrega, com o embed `!inner` da conexão. */
interface LinhaDoEventoExterno {
  id: string;
  starts_at: string;
  ends_at: string;
  calendar_connections: { user_id: string } | { user_id: string }[] | null;
}

const instante = (iso: string): number => new Date(iso).getTime();

/** O mais TARDE dos dois instantes — o começo da fatia visível. */
const maisTarde = (a: string, b: string): string => (instante(a) >= instante(b) ? a : b);

/** O mais CEDO dos dois instantes — o fim da fatia visível. */
const maisCedo = (a: string, b: string): string => (instante(a) <= instante(b) ? a : b);

/**
 * Os compromissos do Google selecionados pela organização que ocupam o recorte.
 *
 * Leitura única de propósito: a semente e a rota pedem a MESMA coisa, e a
 * resposta é a mesma. Se um dia a regra mudar, muda aqui — não em duas cópias
 * que se separam em silêncio.
 */
export async function lerOcupacaoExterna(
  supabase: SupabaseClient,
  recorte: RecorteDaAgenda,
): Promise<LeituraDaOcupacaoExterna> {
  const { data, error } = await supabase
    .from("calendar_selected_external_events")
    .select("id, starts_at, ends_at, calendar_connections!inner(user_id)")
    .eq("organization_id", recorte.organizationId)
    // INTERSEÇÃO de intervalos — a MESMA conta do motor de disponibilidade
    // (`fn_agenda_ocupacao_google_do_dono`, migration 0260, e `coletaOQueOcupa`):
    // o compromisso ocupa o recorte quando COMEÇA antes do fim E TERMINA depois
    // do começo. Comparar só o começo (`starts_at >= de`) descartava o
    // compromisso que ATRAVESSA o limite — a grade mostrava livre o horário que
    // a marcação recusa, e quem atende só descobria no erro (issue #525).
    .lt("starts_at", recorte.ate)
    .gt("ends_at", recorte.de)
    // `transparent` no Google é "livre": existe e não ocupa. `cancelled` não
    // aconteceu. Mesmo filtro da coleta — a regra é uma só.
    .neq("transparency", "transparent")
    .neq("status", "cancelled")
    .order("starts_at");

  if (error) return { blocos: [], erro: error.message };

  const linhas = (data ?? []) as unknown as LinhaDoEventoExterno[];

  return {
    blocos: linhas.map((linha) => {
      const conexao = linha.calendar_connections;
      const dono = Array.isArray(conexao) ? conexao[0]?.user_id : conexao?.user_id;
      return {
        id: linha.id,
        donoId: dono ?? null,
        // A FATIA VISÍVEL: o bloco não começa antes do recorte nem termina
        // depois dele. `GradeDaAgenda` atribui cada bloco à coluna do dia pelo
        // INÍCIO — com o instante cru, o compromisso que vem de ontem cairia
        // fora de toda coluna desenhada e sumiria da tela de novo.
        //
        // `toISOString()` porque o limite do recorte é texto de QUEM CHAMOU: a
        // rota aceita `2026-09-16T00:00:00-03:00` (o Zod exige `offset: true`),
        // e devolver esse literal faria a mesma resposta misturar dois formatos
        // de data — bloco recortado com offset, bloco inteiro no formato do
        // PostgREST. Quem lê a lista de fora não tem como saber qual é qual.
        iniciaEm: new Date(maisTarde(linha.starts_at, recorte.de)).toISOString(),
        terminaEm: new Date(maisCedo(linha.ends_at, recorte.ate)).toISOString(),
      };
    }),
    erro: null,
  };
}

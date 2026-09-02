import { addDays, startOfWeek } from "date-fns";
import { redirect } from "next/navigation";

import { enderecoDeRetorno, faltaParaConectarOGoogle, googleEstaConfigurado } from "@/lib/agenda/google/config";
import { PROVEDOR_GOOGLE } from "@/lib/agenda/tipos";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

import type { Agendamento as AgendamentoDaTela } from "@/components/agenda/tipos";

import { AgendaClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A Agenda.
 *
 * O servidor resolve só a SEMENTE — quem é, de que organização, e em que fuso a
 * grade deve ser desenhada. O dado vivo vem do cliente por `/api/v1/agenda`,
 * porque o cookie de sessão é `httpOnly` e o supabase-js do browser não o lê:
 * `auth.uid()` viria null e a RLS esconderia tudo. É a razão estrutural que o
 * resto do produto já segue.
 *
 * O FUSO É DA APRESENTAÇÃO, não da regra (decisão 4 da entrega): quem está em
 * Manaus vê a grade no horário de Manaus, enquanto as janelas de trabalho
 * continuam valendo no fuso da jornada. São perguntas diferentes e por isso duas
 * fontes — e este campo do perfil, oferecido pela tela há meses, ganha aqui o
 * primeiro leitor de verdade.
 */
/**
 * O embed do PostgREST devolve objeto quando a FK é para-um e array quando o
 * gerador de tipos não consegue provar isso. Aceitar as duas formas evita que a
 * tela dependa de qual das duas o `database.types.ts` do dia declarou.
 */
function nomeDoContato(
  c: { name: string | null; display_name: string | null } | { name: string | null; display_name: string | null }[] | null,
): string | undefined {
  const alvo = Array.isArray(c) ? c[0] : c;
  return alvo?.name ?? alvo?.display_name ?? undefined;
}

export default async function AgendaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  // `user.timezone` e não `user_metadata.timezone`: o AuthUser deste projeto
  // não expõe o metadata cru — ele extrai o que toda tela precisa no primeiro
  // render, como já fazia com o `locale`. O fuso entrou lá pela mesma razão.
  const fusoDeApresentacao = user.timezone ?? null;

  // Resolvido no SERVIDOR: `GOOGLE_CALENDAR_*` é env de servidor e não pode
  // atravessar para o cliente. A tela recebe o booleano e a lista do que falta,
  // nunca o segredo.
  /**
   * A SEMENTE vem do servidor, e não de um hook — porque a rota de leitura ainda
   * não existe.
   *
   * ⚠️ ESTE PARÁGRAFO VENCEU e foi reescrito. Ele dizia que
   * `GET /api/v1/agenda/agendamentos` "não foi escrito (medido)" — e o GET existe:
   * `grep -n "^export async function" app/api/v1/agenda/agendamentos/route.ts` → GET:95.
   * A medição estava certa no dia; a frase não tinha como saber que envelheceu.
   *
   * O que esta consulta faz HOJE é a PRIMEIRA PINTURA: o RSC entrega a grade já
   * desenhada, sem piscar e sem spinner, e o `useAgendamentos` assume a partir
   * dali para as atualizações. O cookie `httpOnly` segue impedindo o supabase-js
   * do browser de consultar direto — por isso o caminho do cliente é a rota.
   *
   * O servidor PODE: ele tem a sessão, e a RLS filtra por organização como em
   * qualquer outra tela. Então a Agenda nasce com dado REAL em vez de vazia — o
   * que ela perde, até o GET existir, é atualizar sem recarregar.
   *
   * Isto NÃO é contorno permanente: quando o GET subir, troca-se esta consulta
   * por `useQuery` e a tela ganha o realtime. O que muda é a origem; o desenho
   * fica. E é melhor que esperar: uma tela vazia por falta de rota é
   * indistinguível, para quem olha, de uma agenda sem compromissos.
   */
  const supabase = await createClient();

  // A semana da âncora, que é o que a grade abre por padrão.
  const inicio = startOfWeek(new Date(), { weekStartsOn: 0 });
  const fim = addDays(inicio, 7);

  // `.eq("organization_id", activeOrg.orgId)` em TODA consulta desta página, e
  // não só a RLS. A `fn_user_org_ids()` que as policies usam devolve TODAS as
  // organizações do usuário: ela é PISO (impede vazamento entre inquilinos), não
  // ESCOPO (não escolhe a org ativa). Sem o filtro, quem é membro de duas
  // organizações via seis tipos onde há três — e clicar no da outra org dava
  // "Tipo de agendamento não encontrado", porque a rota que marca ESCAPA a org
  // certa e não achava o tipo que esta tela ofereceu.
  const [{ data: tipos }, { data: linhas }] = await Promise.all([
    supabase
      .from("calendar_event_types")
      .select("id, name, duration_minutes, location_kind, location_details, is_active, default_owner_user_id")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("calendar_appointments")
      .select(
        "id, title, starts_at, ends_at, status, owner_user_id, contact_id, event_type_id, location_kind, contacts(name, display_name)",
      )
      .eq("organization_id", activeOrg.orgId)
      .gte("starts_at", inicio.toISOString())
      .lt("starts_at", fim.toISOString())
      .order("starts_at"),
  ]);

  /**
   * A OCUPAÇÃO QUE VEM DO GOOGLE — o que o dono cria lá e não via aqui.
   *
   * ⚠️ ESTE FIO NUNCA EXISTIU, e é o Lado B do relato: "quando marco algo pelo
   * calendar não mostra no deskcomm". Medido na VPS: 27 linhas em
   * `calendar_external_events`, entrando certo. Mas essa tabela só alimentava o
   * motor de disponibilidade (`lib/agenda/ocupados.ts`) — o horário ficava
   * bloqueado e o bloco não aparecia. O dono via a agenda vazia e o horário
   * indisponível ao mesmo tempo.
   *
   * ⚠️ E O `title` NÃO É LIDO, de propósito. A tabela tem a coluna e nós a
   * gravamos; esta consulta a deixa de fora.
   *
   * A razão é medida, não estética, e está escrita inteira aqui de propósito:
   * sem o argumento completo, a próxima pessoa lê a ausência do título como
   * esquecimento e o acrescenta achando que está melhorando a tela.
   *
   * ─── O que o cal.com faz, medido no código deles (QUATRO provas) ───────────
   *  1. o tipo de retorno da disponibilidade (`EventBusyDate`) não tem campo de
   *     título — só `start`, `end`, `source`, `timeZone`;
   *  2. o caminho antigo usa `freebusy.query`, que por definição não devolve
   *     título nenhum;
   *  3. o cache `CalendarCacheEvent` GRAVA `summary`/`description`/`location`, e
   *     o `select` da leitura devolve só `start`/`end`/`timeZone`
   *     (`packages/features/calendar-subscription/lib/cache/CalendarCacheEventRepository.ts`);
   *  4. as duas telas deles escrevem "Busy" na mão, e a distinção visual é
   *     contorno-sem-preenchimento, ou cor por origem.
   *
   * A terceira é a que decide: guardar e não ler não é limitação, é DECISÃO —
   * alguém escreveu aquele `select` de propósito.
   *
   * ─── E o nosso caso é PIOR que o deles ─────────────────────────────────────
   * No cal.com a tela é do próprio dono da agenda. Aqui a agenda conectada é
   * PESSOAL de quem atende e a tela é multi-tenant, vista por gestor:
   * "consulta médica", "terapia", "entrevista de emprego" apareceriam para o
   * chefe. Não copiamos a decisão deles — medimos que a nossa exposição é maior.
   *
   * ─── A assimetria que decide sozinha ───────────────────────────────────────
   * Mostrar o título é reversível no código; o vazamento não é. Quando há
   * dúvida, o default certo é o mais restrito.
   *
   * Se o dono quiser o nome do evento, a decisão é dele — e o caminho é POR
   * ORGANIZAÇÃO e com aviso de quem vê, nunca por default.
   *
   * ⚠️ Isto tem GUARDA, não só comentário:
   * `tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts`.
   *
   * O dono vem por `connection_id → calendar_connections.user_id`, porque esta
   * tabela não tem `user_id` — é a mesma junção que `ocupados.ts` já faz.
   */
  const { data: externos } = await supabase
    .from("calendar_external_events")
    .select("id, starts_at, ends_at, status, transparency, calendar_connections!inner(user_id)")
    .eq("organization_id", activeOrg.orgId)
    .gte("starts_at", inicio.toISOString())
    .lt("starts_at", fim.toISOString())
    // `transparent` no Google é "livre": o evento existe e não ocupa. Trazê-lo
    // como bloco diria que o horário está tomado quando a própria pessoa marcou
    // que não está.
    .neq("transparency", "transparent")
    .neq("status", "cancelled")
    .order("starts_at");

  // QUAL conta está conectada — o prop existia no cartão e NUNCA era passado,
  // então o ramo "Agenda conectada" era código morto e o botão "Conectar Google"
  // não sumia depois de conectar. Segunda conexão era um clique no mesmo botão.
  const { data: conexao } = await supabase
    .from("calendar_connections")
    .select("account_email, status")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", user.id)
    // ⚠️ A CONSTANTE, e não o literal. Isto era `.eq("provider", "google")` — um
    // valor que o CHECK de `calendar_connections` PROÍBE existir, então a
    // consulta casava zero linhas SEMPRE. O efeito na tela: `contaConectada`
    // vinha `null`, o ramo "Agenda conectada" do cartão nunca entrava, e o botão
    // "Conectar Google" continuava aparecendo depois de a pessoa já ter
    // conectado. Ela reconectava, o ciclo repetia.
    .eq("provider", PROVEDOR_GOOGLE)
    .neq("status", "disconnected")
    .maybeSingle();

  // `await`: a credencial pode vir do BANCO agora (migration 0201), não só do
  // `.env`. `faltaParaConectarOGoogle` já só devolve nomes de variável quando as
  // DUAS fontes estão vazias — mandar editar o `.env` de uma instalação que
  // gravou a credencial pela tela seria pior que não dizer nada.
  const googleConfigurado = await googleEstaConfigurado();
  const faltaNoGoogle = googleConfigurado ? [] : await faltaParaConectarOGoogle();

  return (
    /*
      PILOTO da superfície clara. O escopo mora aqui, e não no `<main>` do
      `AppShell`, porque aquele `<main>` é o de TODAS as telas do produto —
      movê-lo para lá acende as quatorze de uma vez, e o combinado era validar
      uma antes.

      `-m-6 p-6` cancela e repõe o respiro do `<main>`: sem isso a superfície
      clara nasceria 24px para dentro e sobraria uma moldura escura em volta,
      que é exatamente o que denuncia um tema aplicado pela metade. O
      `min-h-full` faz o Paper alcançar o rodapé quando a agenda está vazia.
    */
    <div data-superficie="clara" className="-m-6 min-h-[calc(100%+3rem)] bg-bg p-6 text-text">
      <AgendaClient
        fusoDeApresentacao={fusoDeApresentacao}
        googleConfigurado={googleConfigurado}
        contaConectada={conexao?.account_email ?? null}
        enderecoDeRetorno={enderecoDeRetorno()}
        faltaNoGoogle={faltaNoGoogle}
        // SÓ para quem administra a INSTALAÇÃO. A tela do app OAuth vive em
        // `/admin` e faz `notFound()` para o resto — oferecer o link a quem não
        // pode entrar seria trocar um beco por outro.
        linkDeConfiguracaoDoGoogle={user.is_platform_admin ? "/admin/google" : undefined}
        tiposIniciais={(tipos ?? []).map((t) => ({
          id: t.id,
          nome: t.name,
          duracaoMin: t.duration_minutes,
          // Quem DE FATO atende este tipo. Sem isto a tela mostrava o primeiro da
          // lista de pessoas como responsável e marcava na agenda dele — enquanto
          // os horários oferecidos vinham da jornada de outra pessoa.
          donoId: t.default_owner_user_id ?? null,
          // O LOCAL DE VERDADE. O `select` acima já trazia `location_kind` e
          // `location_details`, e o mapeamento os descartava — então o painel caía
          // no default de parâmetro e toda clínica de toda instalação lia
          // "Presencial · Sala 2" numa tela real.
          localKind: t.location_kind ?? null,
          localDetalhes: t.location_details ?? null,
        }))}
        agendamentosIniciais={((linhas ?? []).map((a) => ({
          id: a.id,
          titulo: a.title ?? "Agendamento",
          responsavelId: a.owner_user_id ?? "",
          comeca: a.starts_at,
          termina: a.ends_at,
          origem: "ui" as const,
          situacao: a.status as "confirmed",
          // "com quem" é a promessa do subtítulo desta tela, e era a única parte
          // dela que o servidor não entregava: `contact_id` vinha no select e
          // morria aqui. `dados-de-mentira.ts` preenche este campo nos 11 cards,
          // então a tela pareceu pronta o tempo todo — e o `?? a.titulo` do
          // histórico transformou a ausência em silêncio, não em erro.
          // `name` antes de `display_name` segue o precedente do produto
          // (`app/app/lgpd/requests/[id]/PreviewPanel.tsx`); as duas colunas são
          // reescritas pelo cascade de LGPD, então nenhuma vaza titular anonimizado.
          quemSeraAtendido: nomeDoContato(a.contacts),
        })) as AgendamentoDaTela[]).concat(
          /**
           * A ocupação do Google entra na MESMA lista, com `origem: "google_sync"`.
           *
           * A grade já sabia tratar essa origem — `GradeDaAgenda` desabilita o
           * bloco, tira o clique, tira o arraste e diz "ocupado na agenda do
           * Google" no rótulo acessível. O que faltava era alguém entregar os
           * dados: o tratamento existia e nunca recebia uma linha.
           *
           * `titulo: "Ocupado"` é o rótulo, não o nome do evento — ver o
           * comentário da consulta acima sobre por que o `title` não é lido.
           * `quemSeraAtendido` fica ausente de propósito: o tipo já documenta essa
           * ausência como o caso do Google.
           */
          (externos ?? []).map((e) => {
            const conexao = e.calendar_connections as { user_id: string } | { user_id: string }[] | null;
            const dono = Array.isArray(conexao) ? conexao[0]?.user_id : conexao?.user_id;
            return {
              id: e.id,
              titulo: "Ocupado",
              responsavelId: dono ?? "",
              comeca: e.starts_at,
              termina: e.ends_at,
              origem: "google_sync" as const,
              situacao: "confirmed" as const,
            };
          }) as AgendamentoDaTela[],
        )}
      />
    </div>
  );
}

/**
 * O ÚLTIMO FILTRO DE RESPONSÁVEL ESCOLHIDO NA TELA DE TAREFAS (#4737, parte 1).
 *
 * ─── Onde ele é guardado, e por que AQUI ───────────────────────────────────
 *
 * No `raw_user_meta_data` da PESSOA, sob `filtro_de_responsavel_das_tarefas` —
 * o MESMO sítio da camada de datas da Agenda (`lib/agenda/preferencia-da-camada.ts`,
 * chave `camada_datas_dos_negocios`) e dos lembretes de tarefa
 * (`lib/tarefas/preferencia-de-lembrete.ts`). Não é um segundo mecanismo: é o
 * primeiro, aplicado à tela de Tarefas.
 *
 * As alternativas já foram medidas e descartadas na Agenda, e valem igual aqui:
 *
 *   1. `localStorage` seria por NAVEGADOR. Quem escolhe "Minhas" no desktop
 *      abriria "Todos" no celular — e o pedido é que a escolha acompanhe a
 *      pessoa, não o aparelho.
 *   2. `organizations.settings` seria por ORGANIZAÇÃO: o filtro de um viraria
 *      o de todo mundo. A decisão da empresa é OUTRA coisa, e é a parte 2 desta
 *      mesma entrega (`lib/tarefas/escopo-do-atendente.ts`).
 *   3. Tabela nova com migration seria mais peso do que a escolha pede: o
 *      metadata já é escrito pela própria pessoa (`auth.updateUser`), lido no
 *      RSC da página e invalidado pelo cache curto de sessão.
 *
 * ─── O insumo é DADO ALHEIO ───────────────────────────────────────────────
 *
 * O gravado foi escrito numa sessão antiga, por uma versão anterior do produto,
 * ou aponta para um membro que saiu da equipe ontem. `lerFiltroDoResponsavel`
 * NUNCA lança e nunca devolve um filtro que não existe mais: valor torto — ou
 * id que não é id — volta ao padrão DAQUELE contexto, e a pessoa escolhe de
 * novo. A tela abre na lista certa em vez de abrir vazia, mentindo "nenhuma
 * tarefa sua" por causa de um id órfão.
 *
 * `todos` também cai no padrão quando a organização restringe o atendente às
 * próprias tarefas (parte 2): a tela não pode abrir num filtro que a API
 * recusa — e recusar em silêncio, devolvendo a lista inteira, seria o defeito.
 */
import type { FiltroDeResponsavel } from "@/lib/tarefas/filtro-de-responsavel";

/** Onde a escolha mora no `raw_user_meta_data` da pessoa. */
export const CHAVE_DO_FILTRO_DAS_TAREFAS = "filtro_de_responsavel_das_tarefas";

/** Um UUID no formato que o Postgres aceita. O resto é lixo de outra época. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContextoDoFiltro {
  /**
   * O filtro com que a tela abre para quem NUNCA escolheu. É `eu` para quem tem
   * papel de atendente e `todos` para o resto — decidido no servidor, junto com
   * o papel (`app/app/tasks/page.tsx`).
   */
  padrao: FiltroDeResponsavel;
  /**
   * A organização ligou "Atendente vê só as próprias tarefas" e esta pessoa é
   * atendente. `todos` deixa de ser uma escolha possível: cair nele abriria a
   * tela num filtro que a rota responde com lista vazia ou 403.
   */
  restritoAoProprio?: boolean;
}

/**
 * A escolha gravada, saneada contra o que a tela pode oferecer HOJE.
 *
 * Devolve sempre um filtro utilizável: a escolha da pessoa quando ela ainda
 * cabe no contexto, o padrão quando não cabe. Nunca `undefined`, nunca `null` —
 * a tela não tem um terceiro estado.
 */
export function lerFiltroDoResponsavel(
  metadata: unknown,
  contexto: ContextoDoFiltro,
): FiltroDeResponsavel {
  const padrao = contexto.padrao;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return padrao;

  const cru = (metadata as Record<string, unknown>)[CHAVE_DO_FILTRO_DAS_TAREFAS];
  if (typeof cru !== "string") return padrao;
  const valor = cru.trim();

  if (valor === "eu" || valor === "ninguem") return valor;
  // `todos` é a única escolha que a restrição da organização tira da mesa.
  if (valor === "todos") return contexto.restritoAoProprio ? padrao : "todos";
  if (UUID.test(valor)) return valor;

  // Qualquer outra coisa — vazio, `mariana`, o id de um funil — volta ao padrão.
  return padrao;
}

/**
 * O filtro inicial da tela, com o `?assigned_to=me` do endereço na frente.
 *
 * O endereço é o que o lembrete e o push de tarefa abrem (`?assigned_to=me`), e
 * ele continua ganhando da preferência: quem clicou no aviso quer AS SUAS, não
 * o filtro que deixou ontem.
 */
export function filtroInicialDaTela(
  metadata: unknown,
  contexto: ContextoDoFiltro & { pedidoNoEndereco?: string | null },
): FiltroDeResponsavel {
  if (contexto.pedidoNoEndereco === "me") return "eu";
  return lerFiltroDoResponsavel(metadata, contexto);
}

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
 *      o de todo mundo. O que a empresa decide é OUTRA coisa, e já mora no
 *      banco (`lib/tarefas/escopo-do-atendente.ts` explica a régua).
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
 * O id de um COLEGA também cai no padrão quando o banco recorta o que esta
 * pessoa vê: a tela não oferece colegas nesse caso, e abrir num filtro que não
 * está no seletor mostraria uma fração das tarefas dele como se fosse tudo.
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
   * O banco recorta o que esta pessoa vê (`escopoDaTelaDeTarefas` não é
   * `null`). O id de um colega deixa de ser uma escolha possível.
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

  if (valor === "eu" || valor === "ninguem" || valor === "todos") return valor;
  // O colega é a única escolha que o recorte do banco tira da mesa.
  if (UUID.test(valor)) return contexto.restritoAoProprio ? padrao : valor;

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

/**
 * Recursos pré-prontos do atendimento (#2833) — o modelo de TEXTO, de IMAGEM ou
 * de ÁUDIO que o operador escolhe num clique dentro do Inbox.
 *
 * O produto de mercado dispara o conteúdo no clique; a issue cobra o oposto:
 * a escolha só PREPARA o compositor. Um recurso de texto cai no campo editável
 * e um de mídia entra na FILA de anexos — é o operador quem decide o instante do
 * envio. Este módulo descreve o dado do recurso e NÃO tem nenhum caminho de
 * envio: quem manda é sempre um clique humano, separado.
 *
 * ── Um caminho só, o mesmo da resposta rápida do `/` ───────────────────────
 *
 * A escolha na barra entrega o recurso ao MESMO `applyTemplate` que o
 * slash-menu (`/`) usa. Não existe plano próprio da barra: um caminho só
 * significa que a mídia do recurso (imagem OU áudio) chega à fila de anexos com
 * prévia e retry pelo caminho que já estava provado, e o texto do corpo entra
 * como legenda da PRIMEIRA mídia — exatamente como o `/` já fazia.
 *
 * O desenho anterior tinha um segundo caminho (o plano que este módulo
 * descrevia), que devolvia só o texto e deixava a mídia para trás: uma resposta
 * rápida COM IMAGEM clicada na barra perdia a imagem. Foi o defeito medido no PR
 * #2847 e o motivo desta troca.
 *
 * ── Um recurso é uma linha de `message_templates` ──────────────────────────
 *
 * Texto mora no `body`; a mídia é uma entrada de `midias` — o MESMO vocabulário
 * de mídia da resposta rápida (#2526), no mesmo bucket privado e gravada pela
 * MESMA rota (`POST /message-templates/:id/midias`). Não existe coluna, bucket
 * nem rota próprios do áudio: era o desenho anterior, e o preço dele era um
 * segundo caminho de mídia ao lado do primeiro.
 *
 * Por isso `tipo` NÃO é campo do modelo: quem responde o que o recurso leva é
 * `lib/inbox/resposta-rapida.ts`, lendo a lista `midias` — e, dentro dela, o
 * CAMINHO do arquivo (que a rota escolheu pelos bytes), nunca uma coluna que
 * outra escrita pode contradizer.
 */
import { type MidiaDeTemplate } from "@/lib/templates/midias";

/**
 * O subconjunto de `message_templates` que o compositor precisa conhecer — e o
 * contrato que a barra de recursos e o slash-menu COMPARTILHAM: os dois passam o
 * mesmo objeto ao mesmo `applyTemplate`, e é isso que faz a mídia do recurso
 * seguir o caminho já provado da fila de anexos.
 *
 * `midias` é opcional de propósito, pela mesma razão de `MessageTemplate`:
 * linha anterior à migration 0643 (e fixture anterior a ela) chega sem a chave,
 * e a ausência é "recurso de texto".
 *
 * ── O TIPO do recurso saiu daqui (#3009) ──────────────────────────────────
 *
 * Este módulo exportava `TIPOS_DE_RECURSO` ("texto" | "audio"), o vocabulário
 * do seletor de modo do formulário, e `ehRecursoDeAudio`. Com texto, imagem e
 * áudio independentes e combináveis, "de que tipo é este recurso" virou sete
 * respostas possíveis — e uma constante de dois valores obrigava cada tela a
 * refazer a conta. Quem responde agora é `lib/inbox/resposta-rapida.ts`, lido
 * pela barra, pelo envio e pelo cadastro. Aqui fica o DADO do recurso e a
 * marcação da barra; o tipo é leitura dele.
 */
export interface Recurso {
  id: string;
  title: string;
  body: string;
  midias?: readonly MidiaDeTemplate[] | null;
  /**
   * A MARCAÇÃO "Mostrar na barra do Inbox" (#3282) — `message_templates.mostrar_na_barra`.
   *
   * Opcional e lida como ligada por ausência, pela mesma razão de `midias`: linha
   * anterior à migration 0742 e fixture sem a chave são "aparece na barra", que é
   * o comportamento de sempre. Só o `false` EXPLÍCITO esconde.
   */
  mostrar_na_barra?: boolean | null;
  /**
   * O GRUPO do recurso (#3245) — `message_templates.grupo_id`.
   *
   * Opcional e lido como "sem grupo" por ausência, pela mesma razão das outras
   * duas: linha anterior à migration 0808 e fixture sem a chave aparecem na
   * lista plana, que é o comportamento de sempre. A barra só desenha seções
   * quando existe PELO MENOS UM grupo cadastrado (`grupos.length > 0`).
   */
  grupo_id?: string | null;
}

/**
 * OS RECURSOS QUE A BARRA DO INBOX MOSTRA (#3282).
 *
 * A régua é "ausência = mostra": `mostrar_na_barra` é `true` por padrão, e uma
 * organização que nunca mexeu na marcação (nem fixture anterior à coluna, que
 * chega SEM a chave) continua com tudo na barra, como hoje. Só o `false`
 * explícito tira o botão — e ele continua no atalho `/`, que chama esta função
 * não: o `/` lista TODAS as respostas de propósito.
 *
 * Função pura e exportada porque é ELA que o teste da barra prende; o filtro não
 * pode morar dentro do JSX sem um lugar único onde a sabotagem o desligue.
 */
export function recursosDaBarra(recursos: readonly Recurso[]): Recurso[] {
  return recursos.filter((recurso) => recurso.mostrar_na_barra !== false);
}

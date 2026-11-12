"use client";

/**
 * O QUE ESTE ASSISTENTE CONSULTA ANTES DE RESPONDER (0181).
 *
 * Até aqui não existia superfície nenhuma para isto: o acervo pertencia ao
 * agente e a única tela do produto resolvia o agente por `is_default` — como
 * TODO agente criado pela interface nasce `is_default: false`, cadastrar
 * material para qualquer assistente que não fosse o semeado no bootstrap era
 * impossível pela tela, e o indexador ainda o gravava no agente errado.
 *
 * Três coisas que esta seção faz de propósito, no molde de `FunisDoAgente`:
 *
 *  1. **Nomeia o estado vazio.** Nenhum material marcado é LEGÍTIMO (é o
 *     default, e é falha fechada), mas quem publica e não marca nada concluiria
 *     que quebrou. A frase diz o que acontece, não o que falta.
 *  2. **Avisa quando existe acervo e ele está todo de fora.** É o caso que
 *     produz o pior silêncio: a organização pagou para preparar material, o
 *     assistente atende, e responde de improviso sobre um assunto que está
 *     escrito.
 *  3. **Mostra o material que ainda não foi preparado.** Marcar um material que
 *     não virou trecho nenhum é uma promessa que não se cumpre — ele aparece na
 *     lista e o agente não acha nada nele.
 *  4. **Devolve à tela o material ARQUIVADO que ficou marcado (issue #774).**
 *     O vínculo material-agente não pode travar o ARQUIVAMENTO: quem arquiva está
 *     certo, e é a tela do agente que precisa se adaptar. Antes, o acervo chegava
 *     já filtrado por `is_active` e o id marcado não tinha caixinha nenhuma para
 *     desmarcar — o dono ficava com o salvar recusando ("um dos materiais marcados
 *     não existe mais, ou foi arquivado") e sem caminho de volta pela tela.
 *     Arquivado E marcado agora APARECE, com selo e com o desmarcar a um clique;
 *     arquivado e NÃO marcado continua fora, e não conta como material do
 *     assistente em nenhum aviso.
 */
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  lerModoDeConhecimento,
  type ModoDeConhecimento,
} from "@/lib/agent-engine/agent/modo-de-conhecimento";

export interface MaterialDoAcervo {
  id: string;
  name: string;
  source_type: string;
  chunks_count: number;
  last_index_status: string | null;
  /**
   * `false` = arquivado no acervo.
   *
   * Opcional de propósito: a página só carrega a coluna de quem está marcado e
   * ficou fora da lista viva. AUSENTE quer dizer material vivo, nunca arquivado —
   * o contrário esconderia material de quem não manda a coluna.
   */
  is_active?: boolean;
}

interface Props {
  materiais: MaterialDoAcervo[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /**
   * `ai_agents.config.knowledge_mode` como está no banco (#4358) — a MESMA
   * leitura do motor (`lerModoDeConhecimento`), para a tela não inventar um
   * vocabulário próprio. Ausente/fora do vocabulário = `busca`.
   */
  modoInicial?: unknown;
  /**
   * Id do agente. O modo mora em `config` do AGENTE, não da versão, então ele
   * grava por PATCH imediato (como o limiar de sentimento e o servidor externo)
   * e só tem como existir depois que o agente foi criado. Sem id, o seletor não
   * aparece: prometer o salvamento num agente novo seria mentir para quem está
   * preenchendo o formulário.
   */
  agentId?: string;
}

export function BasesDoAgente({
  materiais,
  value,
  onChange,
  disabled = false,
  modoInicial,
  agentId,
}: Props) {
  const t = useT();
  const marcados = new Set(value);
  const [modo, setModo] = React.useState<ModoDeConhecimento>(() =>
    lerModoDeConhecimento({ knowledge_mode: modoInicial }),
  );
  const [salvandoModo, setSalvandoModo] = React.useState(false);

  /**
   * Troca o modo e grava no config do agente. Otimista de propósito: a
   * explicação do modo escolhido aparece na hora. Se o PATCH falhar, volta ao
   * valor gravado — a tela nunca fica dizendo um modo que o banco não tem, que
   * é o mesmo defeito que esta entrega veio consertar (a tela prometia uma
   * consulta que o motor não fazia).
   */
  async function trocarModo(proximo: ModoDeConhecimento): Promise<void> {
    if (proximo === modo || !agentId) return;
    const anterior = modo;
    setModo(proximo);
    setSalvandoModo(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { knowledge_mode: proximo },
      });
      toast.success(t("Modo de consulta salvo — vale a partir da próxima mensagem."));
    } catch (err) {
      setModo(anterior);
      showApiError(err);
    } finally {
      setSalvandoModo(false);
    }
  }

  function alternar(id: string, marcado: boolean): void {
    const proximo = new Set(marcados);
    if (marcado) proximo.add(id);
    else proximo.delete(id);
    onChange([...proximo]);
  }

  // Arquivado só entra na lista quando está MARCADO — é o que devolve ao dono a
  // caixinha para desmarcar. Arquivado e não marcado fica fora: ele não é mais
  // material deste assistente e não pode reaparecer como se fosse.
  const visiveis = materiais.filter((m) => m.is_active !== false || marcados.has(m.id));
  // O acervo VIVO é a régua dos avisos e da contagem: um arquivado não pode
  // virar "material que este assistente deixou de ler" nem entrar no "ainda não
  // foi preparado" — foi arquivado de propósito, e cobrar preparo dele seria
  // pedir que o dono consertasse uma decisão dele mesmo.
  const ativos = materiais.filter((m) => m.is_active !== false);
  const arquivadosMarcados = visiveis.filter((m) => m.is_active === false);
  const semPreparo = ativos.filter((m) => marcados.has(m.id) && (m.chunks_count ?? 0) === 0);
  const acervoTodoDeFora = ativos.length > 0 && value.length === 0;

  function desmarcarArquivados(): void {
    const arquivados = new Set(arquivadosMarcados.map((m) => m.id));
    onChange(value.filter((id) => !arquivados.has(id)));
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("O que ele consulta antes de responder")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Marque o material do seu negócio que este assistente pode ler. Quem decide, a cada mensagem, é o modelo: ele pode responder sem consultar nada. Para cobrar a consulta, escreva nas instruções dele que ele consulte o material antes de responder.",
          )}
        </p>
      </div>

      {/* Como o turno lê esse material (#4358). O campo já existia na
          configuração desde a 1.104.0 e não tinha porta na tela; sem isto, a
          única saída de `busca` era editar o JSON. */}
      {agentId ? (
        <div
          className="space-y-2 border-t border-border pt-3"
          data-testid="modo-de-conhecimento-secao"
        >
          <div className="space-y-1">
            <Label htmlFor="knowledge_mode">{t("Como ele consulta esse material")}</Label>
            <select
              id="knowledge_mode"
              data-testid="modo-de-conhecimento"
              value={modo}
              onChange={(e) => void trocarModo(e.target.value as ModoDeConhecimento)}
              disabled={disabled || salvandoModo}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="busca">{t("Busca por assunto")}</option>
              <option value="leitura_direta">{t("Leitura direta")}</option>
            </select>
          </div>
          <p
            data-testid="modo-de-conhecimento-explicacao"
            className="text-xs text-muted-foreground"
          >
            {modo === "leitura_direta"
              ? t(
                  "A lista dos materiais (nome e resumo) entra no contexto de toda mensagem, sem depender da decisão do modelo; ele abre o material inteiro quando precisa. Não usa serviço de busca por vetores — só a mesma chave do modelo da conversa. Sem material marcado, ele volta sozinho à busca por assunto.",
                )
              : t(
                  "O agente recebe a ferramenta de busca e escolhe, a cada mensagem, se usa. Ele pode responder sem consultar — as instruções do agente são o lugar de cobrar a consulta.",
                )}
          </p>
        </div>
      ) : null}

      {visiveis.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="agente-sem-acervo">
          {t("Você ainda não cadastrou nenhum material.")}{" "}
          <Link
            href="/app/ai/knowledge/sources"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Comece pelo que ele mais vai precisar")}
          </Link>{" "}
          {t("— as perguntas que se repetem, e a política que você mais explica.")}
        </p>
      ) : (
        <div className="space-y-2" data-testid="agente-bases">
          {visiveis.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              {/* `input` nativo, como o ToolPicker e o FunisDoAgente ao lado: o
                  repo não tem componente de checkbox, e introduzir um só para
                  esta seção criaria duas aparências para o mesmo controle na
                  MESMA página. */}
              <input
                id={`base-${m.id}`}
                data-testid={`base-${m.id}`}
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                checked={marcados.has(m.id)}
                onChange={(e) => alternar(m.id, e.target.checked)}
                disabled={disabled}
                aria-label={m.name}
              />
              <Label htmlFor={`base-${m.id}`} className="text-sm font-normal">
                {m.name}
                {/* Singular e plural viram CHAVES separadas em vez de um sufixo
                    concatenado: em português o plural de "trecho" é +s, em
                    espanhol "fragmento"/"fragmentos" muda a palavra inteira, e
                    um `${…}s` no fim não tem como dizer isso. */}
                <span className="ml-2 text-xs text-muted-foreground">
                  {(m.chunks_count ?? 0) > 0
                    ? `${m.chunks_count} ${m.chunks_count === 1 ? t("trecho") : t("trechos")}`
                    : t("ainda não preparado")}
                </span>
                {m.is_active === false ? (
                  <span
                    data-testid={`base-${m.id}-arquivado`}
                    className="ml-2 text-xs font-medium text-warning-fg"
                  >
                    {t("arquivado no acervo")}
                  </span>
                ) : null}
              </Label>
            </div>
          ))}
        </div>
      )}

      {value.length === 0 && visiveis.length > 0 ? (
        <p data-testid="agente-sem-base-marcada" className="text-xs text-muted-foreground">
          {t(
            "Sem nenhum material marcado, ele conversa normalmente — mas responde só com o que o modelo já sabe, e a ferramenta de busca nem entra na conversa dele.",
          )}
        </p>
      ) : null}

      {acervoTodoDeFora ? (
        <p data-testid="agente-acervo-de-fora" className="text-xs text-warning-fg">
          {t("Você tem")} {ativos.length} {ativos.length === 1 ? t("material") : t("materiais")}{" "}
          {t(
            "no acervo e este assistente não lê nenhum. Ele vai responder de improviso sobre assuntos que já estão escritos.",
          )}
        </p>
      ) : null}

      {arquivadosMarcados.length > 0 ? (
        <p data-testid="agente-base-arquivada-marcada" className="text-xs text-warning-fg">
          {arquivadosMarcados.length === 1
            ? t("Um material marcado aqui foi arquivado no acervo — o agente não lê mais ele.")
            : t(
                "Materiais marcados aqui foram arquivados no acervo — o agente não lê mais eles.",
              )}{" "}
          <button
            type="button"
            data-testid="agente-base-arquivada-desmarcar"
            className="font-medium text-foreground underline underline-offset-4"
            onClick={desmarcarArquivados}
            disabled={disabled}
          >
            {t("Desmarque para voltar a salvar.")}
          </button>
        </p>
      ) : null}

      {semPreparo.length > 0 ? (
        <p data-testid="agente-base-sem-preparo" className="text-xs text-warning-fg">
          {semPreparo.length === 1
            ? `"${semPreparo[0]?.name}" ${t("está marcado mas ainda não foi preparado — o agente não vai achar nada nele.")}`
            : `${semPreparo.length} ${t("materiais marcados ainda não foram preparados — o agente não vai achar nada neles.")}`}{" "}
          <Link
            href="/app/ai/knowledge/sources"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Ver o acervo")}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

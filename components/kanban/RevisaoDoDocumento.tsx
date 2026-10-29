"use client";

import { useCallback, useEffect, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * O DOCUMENTO LIDO PELA IA, ESPERANDO UMA PESSOA — NA TELA DO CARD (#3316).
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO FECHA ═══
 *
 * O #3415 entregou a fila de revisão como API: `GET`/`POST
 * `/api/v1/leads/[id]/field-proposals` existiam, tinham teste de rota e
 * NENHUM consumidor na tela. Na prática a funcionalidade não existia para quem
 * atende — a pessoa anexava o voucher, a IA propunha, e o card ficava como
 * estava, com uma fila invisível que ninguém podia decidir. "Existe rota" e
 * "existe na tela" são coisas diferentes, e o mantenedor mediu a diferença.
 *
 * Este componente é o consumidor, e ele vive DENTRO do dossiê do negócio
 * (`LeadDossier` → seção "Dados do negócio"), acima do formulário dos campos —
 * que é o lugar onde a pergunta "o que este voucher diz?" já é feita. Numa lista
 * fora de contexto (uma inbox de sugestões), a única informação disponível seria
 * o valor solto; para julgar "o localizador é esse mesmo?" é preciso ver o card,
 * o trecho do documento e o arquivo.
 *
 * ═══ O QUE ELE NÃO FAZ, DE PROPÓSITO ═══
 *
 *  1. **Não aparece quando não há nada pendente** — seção vazia permanente
 *     ensina a ignorar aquele espaço da tela.
 *  2. **Não esconde o trecho** — confirmar sem ver de onde veio é ato de fé, e o
 *     botão ficaria mais fácil de clicar do que de conferir.
 *  3. **Não some ao falhar** — a proposta continua na tela com o erro visível.
 *     Sumir daria a impressão de decidido; e o 409 (vencida, ou decidida por um
 *     colega) é justamente o caso em que a pessoa precisa entender o que houve.
 *  4. **Não grava sozinho** — nada é escrito no card sem o clique, e quem grava
 *     é o servidor (`updateLeadHandler`, com a régua do funil de hoje).
 */

interface Proposta {
  id: string;
  campo: string;
  rotulo: string;
  tipo?: string;
  opcoes?: { value: string; label: string }[];
  valor_atual: unknown;
  valor_proposto: unknown;
  trecho: string | null;
  documento: { id: string; nome: string; url: string } | null;
  expires_at: string;
}

interface Props {
  leadId: string;
  /** Só quem pode editar o card pode decidir; abaixo disso a fila é leitura. */
  podeDecidir: boolean;
  /** O valor que o servidor confirmou, para atualizar só este campo do card. */
  aoDecidir?: (confirmado: CampoConfirmadoDoDocumento) => void;
}

export interface CampoConfirmadoDoDocumento {
  leadId: string;
  campo: string;
  valor: unknown;
}

/**
 * O valor como a pessoa o lê, do jeito que veio (jsonb): número com separador
 * do idioma, lista por vírgula, booleano em palavra.
 *
 * `String(valor)` direto mostraria `["a","b"]` e `true` — o mesmo cuidado que a
 * irmã de contatos tem com a data, por outra razão: aqui o que se lê é o que
 * vai ser gravado, e representação de máquina não se confere.
 */
function valorParaExibir(valor: unknown): string {
  if (valor === null || valor === undefined) return "—";
  if (Array.isArray(valor)) return valor.map((v) => String(v)).join(", ");
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  if (typeof valor === "number") return valor.toLocaleString();
  return String(valor);
}

/** O texto do input de correção: some a representação de máquina, fica o dado. */
function valorEditavel(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (Array.isArray(valor)) return valor.map((v) => String(v)).join(", ");
  if (typeof valor === "boolean") return valor ? "true" : "false";
  return String(valor);
}

export function RevisaoDoDocumento({ leadId, podeDecidir, aoDecidir }: Props) {
  const t = useT();
  const [itens, setItens] = useState<Proposta[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [correcao, setCorrecao] = useState<Record<string, string>>({});

  /**
   * `preservarErro` existe por causa de um caso concreto: um 409 ("venceu pelo
   * prazo", "já foi decidida") precisa FICAR na tela — é a explicação de por que
   * o clique não valeu. Sem o parâmetro, recarregar a fila logo depois de
   * mostrar a mensagem a apagava, e a pessoa via o botão voltar sem entender
   * nada (foi o que o teste do 409 pegou).
   */
  const carregar = useCallback(async (preservarErro = false) => {
    try {
      const r = await fetch(`/api/v1/leads/${leadId}/field-proposals`, { cache: "no-store" });
      if (!r.ok) throw new Error("falhou");
      const body = (await r.json()) as { data: { propostas: Proposta[] } };
      setItens(body.data.propostas);
      if (!preservarErro) setErro(null);
    } catch {
      // Não esvazia a lista: uma fila que some por falha de rede diz "não há
      // nada pendente", que é mentira.
      setErro(t("Não foi possível carregar os dados do documento agora."));
    }
  }, [leadId, t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function decidir(id: string, decision: "accept" | "dismiss"): Promise<void> {
    setOcupado(id);
    setErro(null);
    const digitado = correcao[id];
    const proposta = (itens ?? []).find((p) => p.id === id);
    // Só manda `valor` quando a pessoa REALMENTE mudou o texto: reenviar o
    // mesmo valor como "correção" faria o servidor tratar o que a IA leu como
    // decisão humana, e o audit perderia a diferença (`corrigido_pela_pessoa`).
    const valor =
      digitado !== undefined && proposta && digitado !== valorEditavel(proposta.valor_proposto)
        ? digitado
        : undefined;
    try {
      const r = await fetch(`/api/v1/leads/${leadId}/field-proposals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(valor !== undefined ? { valor } : {}) }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        // A mensagem do servidor é a que explica o 409 ("venceu pelo prazo",
        // "já foi decidida") — e é exatamente o caso em que a pessoa precisa
        // entender por que o clique não valeu, em vez de tentar de novo.
        setErro(
          body?.error?.message
            ? t(body.error.message)
            : t("Não foi possível registrar a decisão."),
        );
        // A lista recarrega (a proposta vencida já não deve aparecer), mas a
        // frase do servidor fica: é ela que explica o que aconteceu.
        await carregar(true);
        return;
      }
      setCorrecao((atual) => {
        const proximo = { ...atual };
        delete proximo[id];
        return proximo;
      });
      const confirmacao = decision === "accept"
        ? (await r.json()) as { data: { campo: string; valor: unknown } }
        : null;
      await carregar();
      if (confirmacao) aoDecidir?.({ leadId, ...confirmacao.data });
    } catch {
      setErro(t("Não foi possível registrar a decisão."));
    } finally {
      setOcupado(null);
    }
  }

  // Nada pendente e nada errado: a seção não existe.
  if (!erro && (itens === null || itens.length === 0)) return null;

  return (
    <div
      data-peca="revisao-do-documento"
      className="mb-4 rounded-md border border-warning-fg/30 bg-warning-bg/40 p-3"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{t("Dados lidos no documento")}</p>
        <Badge variant="warning">
          {itens?.length ?? 0} {t("aguardando você")}
        </Badge>
      </div>
      <p className="mb-3 text-xs text-text-muted">
        {t("Nada foi gravado no card ainda. Confira o trecho do documento e decida campo a campo.")}
      </p>

      {erro && <p className="mb-3 text-sm text-error-fg">{erro}</p>}

      <ul className="space-y-3">
        {(itens ?? []).map((p) => (
          <li key={p.id} data-proposta={p.campo} className="rounded-md border bg-background p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs uppercase tracking-wide text-text-muted">{p.rotulo}</span>
              <span className="font-medium">{valorParaExibir(p.valor_proposto)}</span>
              {/* O valor atual fica à vista: sem ele, "confirmar" não diz o que
                  vai ser substituído. */}
              <span className="text-xs text-text-muted">
                ({t("hoje:")} {valorParaExibir(p.valor_atual)})
              </span>
            </div>

            {p.trecho && (
              <blockquote className="mt-2 border-l-2 pl-3 text-sm text-text-muted">
                “{p.trecho}”
              </blockquote>
            )}

            {p.documento && (
              <a
                href={p.documento.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {t("Abrir o documento")}: {p.documento.nome}
              </a>
            )}

            {podeDecidir && (
              <div className="mt-3 space-y-2">
                {/* Corrigir antes de confirmar: a IA lê errado, e o caminho de
                    consertar tinha de estar na MESMA linha do valor — mandar a
                    pessoa para o formulário abaixo faria ela perder o trecho. */}
                <Input
                  aria-label={`${t("Corrigir")} ${p.rotulo}`}
                  value={correcao[p.id] ?? valorEditavel(p.valor_proposto)}
                  onChange={(e) =>
                    setCorrecao((atual) => ({ ...atual, [p.id]: e.target.value }))
                  }
                  disabled={ocupado === p.id}
                  className="h-8 text-sm"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={ocupado === p.id}
                    onClick={() => void decidir(p.id, "accept")}
                  >
                    {ocupado === p.id ? t("Salvando…") : t("Está certo, salvar")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ocupado === p.id}
                    onClick={() => void decidir(p.id, "dismiss")}
                  >
                    {t("Descartar")}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

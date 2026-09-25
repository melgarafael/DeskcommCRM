"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * O QUE A IA OUVIU E ESPERA UMA PESSOA CONFIRMAR (spec 17 §4b).
 *
 * Fica NA FICHA DO CONTATO, e não numa caixa de avisos separada, por uma razão
 * de decisão: para julgar "o e-mail é esse mesmo?" é preciso ver o que já está
 * gravado, o histórico e quem é a pessoa. Numa lista fora de contexto, a única
 * informação disponível é o valor solto — e decisão sem contexto vira clique
 * automático, que é o oposto do que esta fila existe para produzir.
 *
 * Três coisas que este componente NÃO faz, de propósito:
 *
 *  1. **Não aparece quando não há nada pendente.** Seção vazia permanente ensina
 *     a ignorar aquele espaço da tela.
 *  2. **Não mostra o valor sem o trecho.** Confirmar sem ver o que a pessoa
 *     escreveu é um ato de fé, e o botão ficaria mais fácil de clicar do que de
 *     conferir.
 *  3. **Não some sozinho ao errar.** Falha de rede mantém a proposta na tela com
 *     o erro visível — sumir daria a impressão de decidido.
 */

interface Proposta {
  id: string;
  campo: string;
  valor_proposto: string;
  valor_anterior: string | null;
  trecho: string | null;
  expires_at: string;
}

const NOME_DO_CAMPO: Record<string, string> = {
  email: "E-mail",
  name: "Nome",
  phone_number: "Telefone",
  birthdate: "Data de nascimento",
};

/**
 * `birthdate` chega como `AAAA-MM-DD` e vira `dd/MM/aaaa` PELOS PEDAÇOS, como na
 * ficha: `new Date("1990-09-14")` nasce à meia-noite UTC e, no fuso da tela
 * (UTC-3), mostraria o dia anterior a quem está confirmando.
 */
function valorParaExibir(campo: string, valor: string): string {
  return campo === "birthdate" ? valor.split("-").reverse().join("/") : valor;
}

interface Props {
  contactId: string;
  /** Só quem pode editar a ficha pode decidir. Abaixo disso, nem renderiza. */
  podeDecidir: boolean;
  /** Chamado após uma confirmação aceita, para a ficha recarregar o dado novo. */
  aoDecidir?: () => void;
}

export function PropostasDeDado({ contactId, podeDecidir, aoDecidir }: Props) {
  const t = useT();
  const [itens, setItens] = useState<Proposta[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/contacts/${contactId}/proposals`, { cache: "no-store" });
      if (!r.ok) throw new Error("falhou");
      const body = (await r.json()) as { data: { items: Proposta[] } };
      setItens(body.data.items);
      setErro(null);
    } catch {
      // Não some da tela: `itens` fica como está e o erro aparece. Uma lista que
      // esvazia por falha de rede diz "não há nada pendente", que é mentira.
      setErro(t("Não foi possível carregar as sugestões agora."));
    }
  }, [contactId, t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function decidir(id: string, decision: "accept" | "dismiss"): Promise<void> {
    setOcupado(id);
    setErro(null);
    try {
      const r = await fetch(`/api/v1/contacts/${contactId}/proposals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        // A mensagem do servidor é a que explica 409 ("já foi decidida", "venceu
        // pelo prazo") — e é justamente o caso em que a pessoa precisa entender
        // por que o clique dela não valeu, em vez de tentar de novo.
        setErro(body?.error?.message ? t(body.error.message) : t("Não foi possível registrar a decisão."));
        await carregar();
        return;
      }
      await carregar();
      if (decision === "accept") aoDecidir?.();
    } catch {
      setErro(t("Não foi possível registrar a decisão."));
    } finally {
      setOcupado(null);
    }
  }

  // Nada pendente e nada errado: a seção não existe.
  if (!erro && (itens === null || itens.length === 0)) return null;
  if (!podeDecidir && (itens === null || itens.length === 0)) return null;

  return (
    <Card className="border-warning-fg/30 bg-warning-bg/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t("O assistente ouviu isto na conversa")}</h2>
        <Badge variant="warning">{itens?.length ?? 0} {t("aguardando você")}</Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("Nada foi salvo ainda. Confira o que a pessoa escreveu e decida.")}
      </p>

      {erro && <p className="mb-3 text-sm text-error-fg">{erro}</p>}

      <ul className="space-y-3">
        {(itens ?? []).map((p) => (
          <li key={p.id} className="rounded-md border bg-background p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {t(NOME_DO_CAMPO[p.campo] ?? p.campo)}
              </span>
              <span className="font-medium">{valorParaExibir(p.campo, p.valor_proposto)}</span>
              {/* O valor atual fica à vista: sem ele, "confirmar" não diz o que
                  vai ser substituído. */}
              {p.valor_anterior && (
                <span className="text-xs text-muted-foreground">
                  ({t("hoje:")} {valorParaExibir(p.campo, p.valor_anterior)})
                </span>
              )}
            </div>

            {p.trecho && (
              <blockquote className="mt-2 border-l-2 pl-3 text-sm text-muted-foreground">
                “{p.trecho}”
              </blockquote>
            )}

            {podeDecidir && (
              <div className="mt-3 flex gap-2">
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
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

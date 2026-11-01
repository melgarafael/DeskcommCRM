"use client";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useCarteiraDoContato, useDefinirCarteira } from "@/hooks/contacts/useCarteiraDoContato";
import { useT } from "@/hooks/i18n/useT";
import { UsersThree } from "@/lib/ui/icons";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

interface Props {
  contactId: string;
}

/**
 * CARTÃO "CARTEIRA" DA FICHA DO CONTATO (#2591, regra 2).
 *
 * Responde uma pergunta só: **de quem é este cliente?** — o que a issue diz que
 * o CRM não sabia, e por que o cliente do vendedor A atendido por B fazia o
 * negócio nascer no nome errado.
 *
 * ─── Ler para todos, mudar para quem TEM o cliente ──────────────────────────
 *
 * Quem atende PRECISA ver o dono (regra 2). Mudar é outra coisa: a issue mediu
 * que a policy de UPDATE de `contacts` não olha papel, então a coluna só se
 * grava pela rota `PATCH /contacts/[id]/carteira`.
 *
 * Até a v1.94 essa rota era `manager`+, e este cartão repetia a régua em
 * `role === "manager"` — o que dava o seletor a todo gerente e NEGAVA ao
 * atendente dono do cliente (#3746). Hoje quem responde é o servidor, no
 * `pode_alterar` do GET: `manager`+ sempre; `agent` no cliente cuja conversa
 * está atribuída a ele ou que já está na carteira dele. A tela só desenha o
 * seletor quando essa resposta é `true`, e continua não sendo ela a guarda —
 * quem recusa o `PATCH` é `lib/carteira/posse.ts`.
 *
 * ─── O nome do dono vem da lista de membros, não da rota ─────────────────────
 *
 * A rota da carteira devolve o id; o nome sai de `useAssignableMembers` (a mesma
 * lista que preenche o seletor). Duas razões: uma fonte de nomes só, e a lista
 * já está em cache quando o seletor abre.
 */
export function CartaoDaCarteira({ contactId }: Props) {
  const t = useT();
  const carteira = useCarteiraDoContato(contactId, true);
  // A capacidade vem do SERVIDOR (#3746): é a mesma régua que o PATCH aplica.
  // Comparar papel aqui daria o seletor a todo gerente e negaria a todo
  // atendente — inclusive ao dono do cliente, que é o defeito que a issue mediu.
  const podeMudar = carteira.data?.pode_alterar === true;
  // A lista de membros serve DUAS coisas: o nome do dono (regra 2 — quem atende
  // precisa ver o NOME de quem é o cliente) e as opções do seletor. Por isso é
  // buscada sempre, não só para gerente+; a rota dela é `agent`+, o mesmo piso de
  // quem vê a ficha.
  const membros = useAssignableMembers(true);
  const definir = useDefinirCarteira(contactId);

  // `__sem_dono__` é o sentinela de "sem dono" no select nativo (a opção de valor
  // vazio existe no HTML, mas o sentinela deixa o estado explícito no código).
  const [selecionado, setSelecionado] = useState<string>("__sem_dono__");
  const donoAtual = carteira.data?.dono_user_id ?? null;

  useEffect(() => {
    if (carteira.data) setSelecionado(carteira.data.dono_user_id ?? "__sem_dono__");
  }, [carteira.data]);

  const membroDoDono = (membros.data ?? []).find((m) => m.user_id === donoAtual) ?? null;
  const nomeDoDono = membroDoDono?.full_name ?? null;
  const conta = carteira.data?.qualificado === true;
  const selecionadoLimpo = selecionado === "__sem_dono__" ? null : selecionado;
  const mudou = selecionadoLimpo !== donoAtual;

  // Erro de leitura não é "sem dono": afirmar ausência sem ter lido seria mentir.
  if (carteira.isError) return null;

  return (
    <Card className="p-4" data-testid="carteira-do-contato">
      <div className="flex items-start gap-3">
        <UsersThree size={20} weight="duotone" aria-hidden className="mt-0.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("Carteira")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("O vendedor dono deste cliente. Sem dono, o atendimento segue o fluxo de sempre.")}
          </p>

          {!carteira.data ? (
            <Skeleton className="mt-3 h-6 w-40" />
          ) : donoAtual ? (
            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="carteira-dono">
              <span className="text-sm">
                {t("Dono da carteira:")}{" "}
                <strong>{nomeDoDono ?? t("Membro da equipe")}</strong>
              </span>
              {!conta && (
                <Badge variant="warning" data-testid="carteira-dono-inativo">
                  {t("Não conta: saiu da equipe ou só lê")}
                </Badge>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground" data-testid="carteira-vazio">
              {t("Sem vendedor dono. O atendimento segue o fluxo de sempre.")}
            </p>
          )}

          {podeMudar && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="carteira-dono">{t("Escolha o vendedor dono")}</Label>
                {/* Select NATIVO, como o das telas de cobrança e agenda: o dono é um
                    punhado de ids e o rótulo é o nome do membro — a lista não pede
                    um combobox com busca, e um `<select>` é alcançável por teclado
                    e leitor de tela sem mais uma camada de JS. */}
                <select
                  id="carteira-dono"
                  className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
                  value={selecionado}
                  data-testid="carteira-seletor"
                  onChange={(e) => setSelecionado(e.target.value)}
                >
                  <option value="__sem_dono__">{t("Sem vendedor dono")}</option>
                  {(membros.data ?? []).map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {rotuloDoMembro(m, t)}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                size="sm"
                disabled={!mudou || definir.isPending}
                data-testid="carteira-salvar"
                onClick={() => definir.mutate(selecionadoLimpo)}
              >
                {definir.isPending ? t("Salvando...") : t("Salvar carteira")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

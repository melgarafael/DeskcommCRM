"use client";

import { useState, useTransition } from "react";

import { updateDestinosInternos } from "@/app/actions/settings/updateDestinosInternos";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";

interface Props {
  readonly listaInicial: readonly string[];
  /** A lista que está na tela veio do `.env`, porque ninguém nunca salvou aqui. */
  readonly vemDoPiso: boolean;
}

/**
 * Uma entrada por linha, com botão de salvar — e NÃO um interruptor que salva
 * ao digitar, como `/admin/cadastro`. A diferença é o que se perde ao errar:
 * lá é um estado de dois valores, reversível com um clique; aqui é uma lista
 * que o operador monta, e salvar a cada tecla gravaria `10.` e `10.1.` no
 * caminho de digitar `10.1.0.0/16`.
 */
export function FormularioDeDestinosInternos({ listaInicial, vemDoPiso }: Props) {
  const t = useT();
  const [texto, setTexto] = useState(listaInicial.join("\n"));
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);
  const [pendente, iniciar] = useTransition();

  function salvar() {
    setErro(null);
    setSalvo(false);
    iniciar(async () => {
      const r = await updateDestinosInternos({ destinos: texto });
      if (r.ok) {
        setSalvo(true);
        return;
      }
      // A entrada recusada volta NOMEADA. "Valor inválido" mandaria o operador
      // conferir dez linhas para achar a que tem um espaço no meio.
      if ("invalidas" in r && r.invalidas && r.invalidas.length > 0) {
        setErro(`${t("Não entendi estas linhas:")} ${r.invalidas.join(", ")}`);
        return;
      }
      setErro(t(ehRecusaDeEscrita(r.error) ? MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error] : "Não deu para salvar. Tente de novo em instantes."));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Endereços liberados")}</CardTitle>
        <CardDescription>
          {t(
            "Por padrão esta instalação não fala com a própria rede: um endereço como 10.0.0.5 ou 192.168.1.20 é recusado antes de qualquer arquivo ou chave sair daqui. O que estiver nesta lista deixa de ser recusado — e só isso: o endereço continua precisando ser https em produção, e continua valendo só para o que a INSTALAÇÃO configura. O endereço que uma empresa escolhe no painel dela segue sem poder apontar para dentro, esteja aqui ou não.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="destinos">{t("Um endereço por linha")}</Label>
          <Textarea
            id="destinos"
            data-testid="destinos-internos"
            rows={6}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={"10.1.2.7\n10.1.0.0/16"}
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Aceita um IP (10.1.2.7) ou uma faixa (10.1.0.0/16). Nome de máquina não entra: o que se confere é o endereço para o qual o nome aponta na hora, e não o nome.",
            )}
          </p>
        </div>

        {/*
          ONDE ESTÁ O QUE VALE. Sem isto, quem tem a lista no `.env` abre a tela,
          vê o conteúdo dele e salva achando que confirmou — e o que fez foi
          congelar aquele valor no banco e desligar o arquivo para sempre.
          Mesma advertência, e mesma razão, de `/admin/google`.
        */}
        {vemDoPiso && listaInicial.length > 0 ? (
          <p
            data-testid="destinos-vem-do-env"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {t(
              "Esta lista ainda vem do arquivo de configuração do servidor, porque nunca foi salva por aqui. Ao salvar, passa a valer o que está nesta tela, e o arquivo deixa de ser consultado.",
            )}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button onClick={salvar} disabled={pendente} data-testid="salvar-destinos">
            {pendente ? t("Salvando…") : t("Salvar")}
          </Button>
          {salvo && !erro ? (
            <span className="text-sm text-muted-foreground" role="status">
              {t("Lista salva.")}
            </span>
          ) : null}
        </div>

        {erro ? (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        ) : null}

        <p className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20">
          {t(
            "Cada endereço aqui é uma porta que este servidor passa a poder abrir para dentro da própria rede, levando junto a chave da instalação. Declare o endereço do serviço que você mesmo colocou lá — nunca uma faixa inteira por conveniência.",
          )}
        </p>
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";

import { updateComportamento } from "@/app/actions/settings/updateComportamento";
import { updateModuloDaInstalacao } from "@/app/actions/settings/updateModuloDaInstalacao";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import type {
  ChaveDeOrcamentoDaInstalacao,
  ComportamentoDaInstalacao,
} from "@/lib/instalacao/comportamento";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

/**
 * Cada interruptor salva na hora, sem botão de confirmar — mesmo desenho do
 * formulário da política de cadastro, e pelo mesmo motivo: é reversível com um
 * clique e o registro de quem trocou (e de qual valor para qual) fica na trilha
 * de auditoria, que é onde a pergunta "por que a IA não parou?" é respondida.
 *
 * A gravação manda o estado INTEIRO das quatro chaves, e não só a que mudou: é
 * um `upsert` de uma linha só, e mandar o estado todo evita que duas telas
 * abertas se sobrescrevam em campos que ninguém tocou.
 */
export function FormularioDeComportamento({ inicial }: { inicial: ComportamentoDaInstalacao }) {
  const t = useT();
  const [valores, setValores] = useState<ComportamentoDaInstalacao>(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function trocar<K extends keyof ComportamentoDaInstalacao>(
    campo: K,
    valor: ComportamentoDaInstalacao[K],
  ) {
    const anterior = valores;
    setErro(null);
    // Otimista, e com volta explícita no erro: sem a volta, uma falha de
    // gravação deixaria a tela dizendo "desligado" com a proteção ligada — o
    // pior estado possível para uma configuração de comportamento.
    setValores({ ...valores, [campo]: valor });
    startTransition(async () => {
      const r = await updateComportamento({ ...valores, [campo]: valor });
      if (!r.ok) {
        setValores(anterior);
        setErro(t("Não deu para salvar. Tente de novo em instantes."));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("O que esta instalação faz")}</CardTitle>
        <CardDescription>
          {t(
            "Cada escolha vale para todas as empresas daqui. Quem cuida do servidor pode declarar um valor no arquivo de ambiente, mas ele só responde até a primeira leitura do banco: a partir daí, manda o que estiver aqui.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="orcamento-de-ia" className="text-base">
              {t("Proteção de gasto de IA")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Decide o que acontece quando o gasto passa do teto que a empresa escolheu. Não liga a proteção de ninguém: só pode afrouxá-la.",
              )}
            </p>
          </div>
          <Select
            value={valores.orcamento_de_ia}
            onValueChange={(v) => trocar("orcamento_de_ia", v as ChaveDeOrcamentoDaInstalacao)}
            disabled={pendente}
          >
            <SelectTrigger id="orcamento-de-ia" className="w-[200px]" aria-label={t("Proteção de gasto de IA")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">{t("Respeita o teto de cada empresa")}</SelectItem>
              <SelectItem value="avisar">{t("Só avisa, nunca para a IA")}</SelectItem>
              <SelectItem value="off">{t("Desligada")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="assinatura-do-webhook" className="text-base">
              {t("Exigir assinatura nas entregas do canal")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Ligado, toda entrega de webhook precisa vir assinada com o segredo da sessão. Desligado por padrão porque nem todo servidor de canal assina: ligar sem que ele assine corta a entrada de mensagens.",
              )}
            </p>
          </div>
          <Switch
            id="assinatura-do-webhook"
            checked={valores.exigir_assinatura_no_webhook}
            onCheckedChange={(v) => trocar("exigir_assinatura_no_webhook", v)}
            disabled={pendente}
            aria-label={t("Exigir assinatura nas entregas do canal")}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="divulgacao-de-pagamento" className="text-base">
              {t("Divulgação de pagamento no atendimento")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Injetar acrescenta o texto de divulgação à primeira mensagem. Vetar bloqueia o envio sem ele e devolve ao modelo a razão, para ele reescrever.",
              )}
            </p>
          </div>
          <Select
            value={valores.divulgacao_de_pagamento}
            onValueChange={(v) =>
              trocar("divulgacao_de_pagamento", v as ComportamentoDaInstalacao["divulgacao_de_pagamento"])
            }
            disabled={pendente}
          >
            <SelectTrigger
              id="divulgacao-de-pagamento"
              className="w-[200px]"
              aria-label={t("Divulgação de pagamento no atendimento")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inject">{t("Injetar")}</SelectItem>
              <SelectItem value="veto">{t("Vetar")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="promessa-semantica" className="text-base">
              {t("Conferência de promessa antes de enviar")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Ligado, cada envio passa por uma conferência de modelo para não prometer o que a empresa não cumpre. Custa uma chamada de modelo por envio.",
              )}
            </p>
          </div>
          <Switch
            id="promessa-semantica"
            checked={valores.promessa_semantica}
            onCheckedChange={(v) => trocar("promessa_semantica", v)}
            disabled={pendente}
            aria-label={t("Conferência de promessa antes de enviar")}
          />
        </div>

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Os MÓDULOS OPCIONAIS da instalação — desligados por padrão, e é aqui, e só
 * aqui, que se ligam (doc 24: liga/desliga de configuração geral tem tela, sem
 * `.env`). Mesmo desenho do cartão de cima: salva no clique, volta no erro.
 */
/** Cada módulo, como ele aparece aqui. O texto diz o que ligar ABRE, não só o nome. */
const MODULOS_NA_TELA: ReadonlyArray<{ modulo: ModuloOpcional; id: string; rotulo: string; descricao: string }> = [
  {
    modulo: "banco_externo",
    id: "modulo-banco-externo",
    rotulo: "Banco de dados externo",
    descricao:
      "Ligado, cada empresa pode conectar o banco de outro sistema (um ERP, outro CRM) para o agente consultar. Isso guarda a senha daquele banco neste servidor e abre conexão com ele. Desligado, a tela, o menu e as ferramentas do agente somem.",
  },
  {
    modulo: "fluxos_atendimento",
    id: "modulo-fluxos-atendimento",
    rotulo: "Fluxos de atendimento",
    descricao:
      "Ligado, cada empresa pode montar roteiros de perguntas que a IA conduz durante a conversa (nome, CPF, interesse…), e as respostas aparecem na ficha do cliente. Desligado, a tela, o menu e o roteiro no atendimento da IA somem.",
  },
];

export function FormularioDeModulos({ ligados }: { ligados: readonly ModuloOpcional[] }) {
  const t = useT();
  const [estado, setEstado] = useState<ReadonlySet<ModuloOpcional>>(new Set(ligados));
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function trocar(modulo: ModuloOpcional, valor: boolean) {
    setErro(null);
    const alternar = (ligar: boolean) =>
      setEstado((atual) => {
        const proximo = new Set(atual);
        if (ligar) proximo.add(modulo);
        else proximo.delete(modulo);
        return proximo;
      });
    alternar(valor);
    startTransition(async () => {
      const r = await updateModuloDaInstalacao({ modulo, ligado: valor });
      if (!r.ok) {
        alternar(!valor);
        setErro(t("Não deu para salvar. Tente de novo em instantes."));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Módulos opcionais")}</CardTitle>
        <CardDescription>
          {t(
            "Recursos que a maioria das instalações não usa. Desligados, eles não aparecem para nenhuma empresa daqui.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {MODULOS_NA_TELA.map((m) => (
          <div key={m.modulo} className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor={m.id} className="text-base">
                {t(m.rotulo)}
              </Label>
              <p className="text-sm text-muted-foreground">{t(m.descricao)}</p>
            </div>
            <Switch
              id={m.id}
              checked={estado.has(m.modulo)}
              onCheckedChange={(valor) => trocar(m.modulo, valor)}
              disabled={pendente}
              aria-label={t(m.rotulo)}
            />
          </div>
        ))}

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

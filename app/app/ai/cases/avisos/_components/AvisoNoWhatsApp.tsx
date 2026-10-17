"use client";
/**
 * "AVISO NO WHATSAPP" — a tela que liga o recurso, prova que ele funciona e diz
 * quando ele NÃO vai disparar.
 *
 * ## As três coisas que esta tela faz, nesta ordem
 *
 * 1. **Diz o estado efetivo** (`AlertasDoAviso`): onze situações em que a
 *    configuração é aceita e nenhum aviso chega. Elas vêm antes do formulário
 *    de propósito — ler "seus números não servem para isso" depois de preencher
 *    tudo é a definição de tela que não avisou.
 * 2. **Salva pelo RPC**, que é quem faz as sete guardas na mesma transação.
 * 3. **Manda um aviso de teste de verdade**, com o preço escrito antes do
 *    clique: ele gasta uma mensagem do número.
 *
 * ## O seletor filtra por CAPACIDADE, nunca por provedor
 *
 * A lista só oferece conexões com `aceitaMensagemLivre`, e essa resposta vem
 * resolvida de `lib/channels/`. Esta tela não sabe — e não pode saber — o nome
 * de nenhum provedor: `pnpm lint:channels` reprova, inclusive em comentário.
 *
 * ## `aviso_numero_de_cliente` é uma PERGUNTA
 *
 * O número de aviso vira interno: tudo o que chegar dele para de virar
 * atendimento. Se ele já é um cliente, confirmar significa que as mensagens
 * dessa pessoa somem do CRM. O RPC recusa uma vez; a tela mostra a consequência
 * e reenvia com a confirmação. Não é um modal: um modal é lido como obstáculo e
 * despachado com um clique, e este é o único aviso da tela que apaga
 * atendimento.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import {
  useAvisoDeCaso,
  useSalvarAvisoDeCaso,
  useTestarAvisoDeCaso,
  type EstadoDoAviso,
} from "@/hooks/ai/useAvisoDeCaso";
import { ApiError } from "@/lib/api/types";
import { normalizarTelefoneDeAviso, telefoneDeAvisoValido } from "@/lib/escalacao/estado-do-aviso";
import { FRASE_DO_ERRO_DO_AVISO } from "@/lib/escalacao/vocabulario-do-aviso";
import { CheckCircle, PaperPlaneTilt, WarningOctagon } from "@/lib/ui/icons";

import { AlertasDoAviso } from "./AlertasDoAviso";
import { EntregasDoAviso } from "./EntregasDoAviso";

/**
 * As duas recusas do teste que NÃO são código de entrega.
 *
 * `espacamento` não existe no vocabulário da tabela de propósito (no motor ele
 * vira adiamento e some), mas aqui há alguém olhando a tela esperando resposta.
 */
const FRASE_EXTRA_DO_TESTE = {
  espacamento:
    "Este número mandou uma mensagem agora há pouco. O WhatsApp exige um intervalo entre elas — tente de novo em alguns segundos.",
} as const;

const RASCUNHO_VAZIO = {
  canal: "", telefone: "", rotulo: "", ligado: false, respostaWhatsappHabilitada: false,
};
type Rascunho = typeof RASCUNHO_VAZIO;

function rascunhoDoEstado(estado: EstadoDoAviso | undefined): Rascunho {
  if (!estado?.config) return RASCUNHO_VAZIO;
  return {
    canal: estado.config.channel_session_id ?? "",
    telefone: estado.config.telefone,
    rotulo: estado.config.rotulo ?? "",
    ligado: estado.config.ligado,
    respostaWhatsappHabilitada: estado.config.resposta_whatsapp_habilitada,
  };
}

export function AvisoNoWhatsApp() {
  const t = useT();
  const { data: estado, isLoading, error } = useAvisoDeCaso();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !estado) {
    return (
      <Card className="flex items-start gap-3 p-4">
        <WarningOctagon className="mt-0.5 h-5 w-5 shrink-0 text-destructive" weight="duotone" />
        <p className="text-sm">
          {t(
            "Não foi possível abrir esta tela agora. Atualize a página; se continuar, avise quem instalou o sistema.",
          )}
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AlertasDoAviso avisos={estado.avisos} />

      {/* ⚠️ `key` e não `useEffect`: o formulário é CONTROLADO, e preenchê-lo de
          dentro de um efeito é `setState` em cascata (o ESLint do projeto acusa,
          com razão). Com a chave, ele nasce já preenchido a partir do servidor e
          RENASCE quando o servidor confirma uma gravação — que é exatamente
          quando o rascunho deve ser descartado. Enquanto ninguém salva, o que a
          pessoa está digitando não é atropelado por nenhuma re-consulta. */}
      <FormularioDoAviso key={estado.config?.atualizado_em ?? "sem-configuracao"} estado={estado} />

      {/* F1 da revisão: o aviso sai na ABERTURA do caso e não se repete. Sem esta
          frase, a equipe conclui que o sistema parou de avisar quando o cliente
          responde — e passa a não confiar no que chega. */}
      <p className="text-xs text-muted-foreground">
        {t(
          "O aviso sai quando o assistente abre o caso. Quando o cliente responde e o caso volta a esperar você, o aviso não se repete — acompanhe pela Central de alertas.",
        )}
      </p>

      <EntregasDoAviso entregas={estado.entregas} laco={estado.laco} />
    </div>
  );
}

/**
 * O formulário — montado só quando há estado, e reiniciado por `key` a cada
 * gravação confirmada. Ver o comentário na chave acima.
 */
function FormularioDoAviso({ estado }: { estado: EstadoDoAviso }) {
  const t = useT();
  const salvar = useSalvarAvisoDeCaso();
  const testar = useTestarAvisoDeCaso();

  const [rascunho, setRascunho] = useState<Rascunho>(() => rascunhoDoEstado(estado));
  /** A pergunta do número que já é cliente. `null` = não foi feita. */
  const [confirmarContato, setConfirmarContato] = useState<string | null>(null);

  const oferecidas = estado.conexoes.filter((c) => c.aceitaMensagemLivre);
  const telefoneOk = telefoneDeAvisoValido(rascunho.telefone);
  const podeSalvar = rascunho.canal !== "" && telefoneOk && !salvar.isPending;
  /**
   * O switch, e por que ele NÃO é `estado.pode_ligar` sozinho nem um `||` com o
   * rascunho.
   *
   * `pode_ligar` responde sobre o que está SALVO; o rascunho é o que a pessoa
   * está digitando agora, e ela precisa conseguir ligar junto com a primeira
   * gravação. Mas as duas condições não são alternativas: um `||` destravaria o
   * switch assim que houvesse conexão e número **mesmo sem endereço público** —
   * e aí o aviso nasceria ligado com um link que não abre nada, que é
   * exatamente o que o estado bloqueante existe para impedir.
   *
   * Então: o veto do servidor (endereço público) vale SEMPRE, e sobre ele o
   * rascunho precisa ter uma conexão que serve e um número completo.
   */
  const semEnderecoPublico = estado.avisos.some((a) => a.codigo === "sem_endereco_publico");
  const canalServe = oferecidas.some((c) => c.id === rascunho.canal);
  const podeLigar = !semEnderecoPublico && canalServe && telefoneOk;
  const jaSalvo = Boolean(estado.config?.channel_session_id);

  async function enviar(confirma: boolean) {
    try {
      await salvar.mutateAsync({
        channel_session_id: rascunho.canal,
        telefone: rascunho.telefone,
        rotulo: rascunho.rotulo.trim() === "" ? null : rascunho.rotulo.trim(),
        ligado: rascunho.ligado,
        resposta_whatsapp_habilitada: rascunho.respostaWhatsappHabilitada,
        ...(confirma ? { confirma_contato: true } : {}),
      });
      setConfirmarContato(null);
      toast.success(t("Aviso salvo."));
    } catch (erro) {
      if (erro instanceof ApiError && erro.code === "aviso_numero_de_cliente") {
        setConfirmarContato(erro.message);
        return;
      }
      toast.error(
        erro instanceof ApiError
          ? erro.message
          : t("Não foi possível salvar o aviso. Tente de novo."),
      );
    }
  }

  async function mandarTeste() {
    try {
      const r = await testar.mutateAsync();
      if (r.enviado) {
        toast.success(t("Aviso de teste enviado. Confira o WhatsApp desse número."));
        return;
      }
      const codigo = r.codigo;
      const frase =
        codigo && codigo in FRASE_EXTRA_DO_TESTE
          ? FRASE_EXTRA_DO_TESTE[codigo as keyof typeof FRASE_EXTRA_DO_TESTE]
          : codigo && codigo in FRASE_DO_ERRO_DO_AVISO
            ? FRASE_DO_ERRO_DO_AVISO[codigo as keyof typeof FRASE_DO_ERRO_DO_AVISO]
            : null;
      toast.error(frase ? t(frase) : t("O aviso de teste não saiu."));
    } catch (erro) {
      toast.error(
        erro instanceof ApiError ? erro.message : t("Não foi possível mandar o teste agora."),
      );
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="conexao">{t("Conexão que envia os avisos")}</Label>
        <Select
          value={rascunho.canal}
          onValueChange={(v) => setRascunho((r) => ({ ...r, canal: v }))}
          disabled={oferecidas.length === 0}
        >
          <SelectTrigger id="conexao" className="w-full sm:w-96">
            <SelectValue placeholder={t("Escolha um número conectado")} />
          </SelectTrigger>
          <SelectContent>
            {oferecidas.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.nome}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("Só aparecem aqui os números que conseguem mandar uma mensagem a qualquer hora.")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="telefone">{t("Número que recebe os avisos")}</Label>
        <Input
          id="telefone"
          inputMode="tel"
          className="w-full sm:w-72"
          placeholder="+5531999998888"
          value={rascunho.telefone}
          onChange={(e) =>
            setRascunho((r) => ({ ...r, telefone: normalizarTelefoneDeAviso(e.target.value) }))
          }
          aria-invalid={rascunho.telefone !== "" && !telefoneOk}
        />
        <p className="text-xs text-muted-foreground">
          {t("Comece pelo código do país. Um celular do Brasil fica assim: +55, DDD e o número.")}
        </p>
        {rascunho.telefone !== "" && !telefoneOk ? (
          <p className="text-xs text-destructive" data-testid="telefone-invalido">
            {t("Esse número ainda não está completo.")}
          </p>
        ) : null}
      </div>

      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id="resposta-whatsapp-habilitada"
          checked={rascunho.respostaWhatsappHabilitada}
          disabled={!jaSalvo || salvar.isPending}
          onCheckedChange={(v) => setRascunho((r) => ({ ...r, respostaWhatsappHabilitada: v }))}
          aria-label={t("Responder casos por este WhatsApp")}
        />
        <div className="space-y-1">
          <Label htmlFor="resposta-whatsapp-habilitada" className="text-sm font-medium">
            {t("Responder casos por este WhatsApp")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("Permite usar RESPONDER ou PERGUNTAR no número que recebe os avisos. Desligado por padrão.")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rotulo">{t("Como chamar esse número (opcional)")}</Label>
        <Input
          id="rotulo"
          className="w-full sm:w-72"
          maxLength={60}
          placeholder={t("Plantão da Ana")}
          value={rascunho.rotulo}
          onChange={(e) => setRascunho((r) => ({ ...r, rotulo: e.target.value }))}
        />
      </div>

      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id="ligado"
          checked={rascunho.ligado}
          disabled={!podeLigar}
          onCheckedChange={(v) => setRascunho((r) => ({ ...r, ligado: v }))}
          aria-label={t("Receber avisos no WhatsApp")}
        />
        <div className="space-y-1">
          <Label htmlFor="ligado" className="text-sm font-medium">
            {t("Receber avisos no WhatsApp")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "O aviso sai na hora, inclusive fora do horário comercial — sua equipe não é cliente.",
            )}
          </p>
        </div>
      </div>

      {confirmarContato ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
          data-testid="confirmar-numero-de-cliente"
        >
          <p className="text-sm font-medium">{confirmarContato}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Esse número passa a ser só da equipe: o que ele mandar deixa de virar atendimento.",
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" onClick={() => void enviar(true)}>
              {t("Usar mesmo assim")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmarContato(null)}>
              {t("Escolher outro número")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void enviar(false)} disabled={!podeSalvar}>
          {salvar.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button
          variant="outline"
          onClick={() => void mandarTeste()}
          disabled={!jaSalvo || testar.isPending}
        >
          <PaperPlaneTilt className="mr-2 h-4 w-4" />
          {testar.isPending ? t("Enviando…") : t("Enviar aviso de teste")}
        </Button>
        {testar.data?.enviado ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle className="h-4 w-4" weight="duotone" />
            {t("Enviado para")} {testar.data.destinoMascarado}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "O teste manda uma mensagem de verdade e conta no limite diário desse número. Salve antes de testar.",
        )}
      </p>
    </Card>
  );
}

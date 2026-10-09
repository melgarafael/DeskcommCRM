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
  canal: "",
  telefone: "",
  rotulo: "",
  ligado: false,
  sem_link: false,
  repetir_lembretes_whatsapp: false,
  minutos_lembrete_equipe: ["3", "6", "9"],
};
type Rascunho = typeof RASCUNHO_VAZIO;
const MINUTOS_PADRAO = [3, 6, 9] as const;
const MAX_MINUTOS_CONFIGURAVEIS = 10;

type ErroDosMinutos = "quantidade" | "inteiro" | "limite" | "duplicado" | "ordem";

function validarMinutos(entradas: string[]): {
  valores: number[] | null;
  erro: ErroDosMinutos | null;
  indiceComErro: number | null;
} {
  if (entradas.length < 1 || entradas.length > MAX_MINUTOS_CONFIGURAVEIS) {
    return { valores: null, erro: "quantidade", indiceComErro: null };
  }

  const valores: number[] = [];
  for (const [indice, entrada] of entradas.entries()) {
    if (entrada.trim() === "" || !Number.isInteger(Number(entrada))) {
      return { valores: null, erro: "inteiro", indiceComErro: indice };
    }
    const valor = Number(entrada);
    if (valor < 1 || valor > 1440) {
      return { valores: null, erro: "limite", indiceComErro: indice };
    }
    if (valores.includes(valor)) {
      return { valores: null, erro: "duplicado", indiceComErro: indice };
    }
    if (valores.length > 0 && valores[valores.length - 1]! >= valor) {
      return { valores: null, erro: "ordem", indiceComErro: indice };
    }
    valores.push(valor);
  }
  return { valores, erro: null, indiceComErro: null };
}

function proximoMinuto(entradas: string[]): number {
  const usados = new Set(
    entradas.map(Number).filter((valor) => Number.isInteger(valor) && valor >= 1 && valor <= 1440),
  );
  const maior = Math.max(0, ...usados);
  const sugerido = maior + 3;
  if (sugerido <= 1440 && !usados.has(sugerido)) return sugerido;
  for (let valor = 1; valor <= 1440; valor += 1) {
    if (!usados.has(valor)) return valor;
  }
  return 1440;
}

function rascunhoDoEstado(estado: EstadoDoAviso | undefined): Rascunho {
  if (!estado?.config) return RASCUNHO_VAZIO;
  return {
    canal: estado.config.channel_session_id ?? "",
    telefone: estado.config.telefone,
    rotulo: estado.config.rotulo ?? "",
    ligado: estado.config.ligado,
    sem_link: estado.config.sem_link ?? false,
    repetir_lembretes_whatsapp: estado.config.repetir_lembretes_whatsapp ?? false,
    minutos_lembrete_equipe: (estado.config.minutos_lembrete_equipe ?? [...MINUTOS_PADRAO]).map(
      String,
    ),
  };
}

export function AvisoNoWhatsApp() {
  const t = useT();
  const consulta = useAvisoDeCaso();
  const { data: estado, isLoading, error } = consulta;

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

      <p className="text-xs text-muted-foreground">
        {t(
          "O aviso de abertura e os reforços são opções independentes. Os reforços valem enquanto qualquer caso aguarda a equipe.",
        )}
      </p>

      <EntregasDoAviso
        entregas={estado.entregas}
        laco={estado.laco}
        atualizando={consulta.isFetching}
        aoAtualizar={() => void consulta.refetch()}
      />
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
  const minutosValidados = validarMinutos(rascunho.minutos_lembrete_equipe);
  const podeSalvar =
    rascunho.canal !== "" && telefoneOk && minutosValidados.valores !== null && !salvar.isPending;
  /** A URL é obrigatória para links; o modo local precisa só de canal e destino. */
  const semEnderecoPublico = estado.avisos.some((a) => a.codigo === "sem_endereco_publico");
  const canalServe = oferecidas.some((c) => c.id === rascunho.canal);
  const podeLigar = (!semEnderecoPublico || rascunho.sem_link) && canalServe && telefoneOk;
  const jaSalvo = Boolean(estado.config?.channel_session_id);
  const alteracoesPendentes = JSON.stringify(rascunho) !== JSON.stringify(rascunhoDoEstado(estado));
  const podeTestar = jaSalvo && !alteracoesPendentes && !salvar.isPending && !testar.isPending;

  async function enviar(confirma: boolean) {
    try {
      await salvar.mutateAsync({
        channel_session_id: rascunho.canal,
        telefone: rascunho.telefone,
        rotulo: rascunho.rotulo.trim() === "" ? null : rascunho.rotulo.trim(),
        ligado: rascunho.ligado,
        sem_link: rascunho.sem_link,
        repetir_lembretes_whatsapp: rascunho.repetir_lembretes_whatsapp,
        minutos_lembrete_equipe: minutosValidados.valores ?? [...MINUTOS_PADRAO],
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

      <section
        className="flex flex-col gap-3 rounded-lg border p-3"
        aria-labelledby="cadencia-titulo"
      >
        <div className="space-y-1">
          <h2 id="cadencia-titulo" className="text-sm font-medium">
            {t("Minutos dos alertas")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "A Central cria lembretes nos minutos configurados desde que o caso passa a aguardar a equipe. Enquanto aguarda resposta do cliente, o relógio fica pausado. Com “Reforçar lembretes no WhatsApp” ativo, cada marco também chega à equipe por WhatsApp. Configure de 1 a 10 minutos distintos, em ordem crescente, entre 1 minuto e 24 horas.",
            )}
          </p>
        </div>
        <ol className="flex flex-col gap-2" data-testid="minutos-lembrete-editor">
          {rascunho.minutos_lembrete_equipe.map((minuto, indice) => {
            const inputId = `minutos-lembrete-${indice}`;
            const indiceInvalido = minutosValidados.indiceComErro === indice;
            return (
              <li key={inputId} className="flex items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={inputId}>
                    {t("Lembrete")} {indice + 1} ({t("minutos desde o início da espera")})
                  </Label>
                  <Input
                    id={inputId}
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    inputMode="numeric"
                    className="w-36"
                    value={minuto}
                    aria-invalid={indiceInvalido}
                    aria-describedby={
                      minutosValidados.erro ? "erro-minutos-lembrete" : "dica-minutos-lembrete"
                    }
                    onChange={(e) =>
                      setRascunho((r) => ({
                        ...r,
                        minutos_lembrete_equipe: r.minutos_lembrete_equipe.map((valor, i) =>
                          i === indice ? e.target.value : valor,
                        ),
                      }))
                    }
                    data-testid={`minutos-lembrete-${indice}`}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rascunho.minutos_lembrete_equipe.length <= 1}
                  aria-label={`${t("Remover lembrete")} ${indice + 1}`}
                  onClick={() =>
                    setRascunho((r) => ({
                      ...r,
                      minutos_lembrete_equipe: r.minutos_lembrete_equipe.filter(
                        (_, i) => i !== indice,
                      ),
                    }))
                  }
                  data-testid={`remover-minuto-${indice}`}
                >
                  {t("Remover")}
                </Button>
              </li>
            );
          })}
        </ol>
        {minutosValidados.erro ? (
          <p id="erro-minutos-lembrete" role="alert" className="text-xs text-destructive">
            {t(
              {
                quantidade: "Mantenha de 1 a 10 lembretes.",
                inteiro: "Informe um número inteiro de minutos em cada lembrete.",
                limite: "Cada lembrete deve ficar entre 1 e 1440 minutos.",
                duplicado: "Cada minuto pode aparecer uma vez só.",
                ordem: "Coloque os minutos em ordem crescente.",
              }[minutosValidados.erro],
            )}
          </p>
        ) : (
          <p id="dica-minutos-lembrete" className="text-xs text-muted-foreground">
            {t("A Central mantém o alerta pendente até a equipe resolver o caso.")}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rascunho.minutos_lembrete_equipe.length >= MAX_MINUTOS_CONFIGURAVEIS}
            onClick={() =>
              setRascunho((r) => {
                const atual = r.minutos_lembrete_equipe;
                const novo = String(proximoMinuto(atual));
                const todosNumericos = atual.every((valor) => /^\d+$/.test(valor));
                const minutos = [...atual, novo];
                if (todosNumericos) minutos.sort((a, b) => Number(a) - Number(b));
                return { ...r, minutos_lembrete_equipe: minutos };
              })
            }
            data-testid="adicionar-minuto-lembrete"
          >
            {t("Adicionar minuto")}
          </Button>
        </div>
      </section>

      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id="sem-link"
          checked={rascunho.sem_link}
          onCheckedChange={(sem_link) =>
            setRascunho((r) => ({ ...r, sem_link, ligado: sem_link ? r.ligado : false }))
          }
          aria-label={t("Sem link — resolver neste computador")}
        />
        <div>
          <Label htmlFor="sem-link">{t("Sem link — resolver neste computador")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("O aviso informa a pendência. Abra Casos neste computador para responder.")}
          </p>
        </div>
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

      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id="repetir-lembretes-whatsapp"
          checked={rascunho.repetir_lembretes_whatsapp}
          onCheckedChange={(v) => setRascunho((r) => ({ ...r, repetir_lembretes_whatsapp: v }))}
          aria-label={t("Reforçar lembretes no WhatsApp")}
        />
        <div className="space-y-1">
          <Label htmlFor="repetir-lembretes-whatsapp" className="text-sm font-medium">
            {t("Reforçar lembretes no WhatsApp")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Enviar reforços à equipe nos minutos configurados acima enquanto um caso aguarda ação humana. O relógio pausa enquanto aguarda resposta do cliente; se atrasar, envia no máximo o marco atual, sem rajada.",
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
        <Button variant="outline" onClick={() => void mandarTeste()} disabled={!podeTestar}>
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

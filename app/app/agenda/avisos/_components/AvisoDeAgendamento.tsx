"use client";
/**
 * "AVISO DE AGENDAMENTO" — a tela que liga o aviso, escolhe para onde ele vai
 * e prova que ele sai.
 *
 * O desenho é o da tela do aviso de caso
 * (`app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx`):
 *
 * - **o formulário renasce por `key`** quando o servidor confirma a gravação,
 *   e não por `useEffect` (o ESLint acusa `setState` em cascata);
 * - **`aviso_numero_de_cliente` é uma pergunta**, mostrada com a consequência
 *   e reenviada com a confirmação;
 * - **o teste manda de verdade**, com o preço escrito antes do clique.
 *
 * O que é próprio desta tela é a opção "usar o mesmo número do aviso de caso",
 * que vem marcada quando o aviso de caso já tem número. Ela é uma REFERÊNCIA:
 * trocar o número do aviso de caso troca também o destino destes avisos.
 *
 * O seletor filtra por CAPACIDADE (`aceitaMensagemLivre`), nunca por provedor —
 * `pnpm lint:channels` reprova nome de provedor fora de `lib/channels/`.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useAvisoDeAgendamento,
  useGruposDaConexao,
  useSalvarAvisoDeAgendamento,
  useTestarAvisoDeAgendamento,
} from "@/hooks/agenda/useAvisoDeAgendamento";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { useT } from "@/hooks/i18n/useT";
import {
  SEM_GRUPO,
  conexaoQueEnviaDoRascunho,
  mudarRascunhoDoAviso,
  numeroPareceDeForaDoBrasil,
  oQueFaltaParaLigar,
  type RascunhoDoAvisoDeAgendamento,
} from "@/lib/agenda/rascunho-do-aviso-de-agendamento";
import type { EstadoDaTelaDoAvisoDeAgendamento } from "@/lib/agenda/tela-do-aviso-de-agendamento";
import {
  FRASE_DO_STATUS_DE_AGENDAMENTO,
  type StatusDaEntregaDeAgendamento,
} from "@/lib/agenda/vocabulario-do-aviso-de-agendamento";
import { ApiError } from "@/lib/api/types";
import { normalizarTelefoneDeAviso, telefoneDeAvisoValido } from "@/lib/escalacao/estado-do-aviso";
import { FRASE_DO_ERRO_DO_AVISO } from "@/lib/escalacao/vocabulario-do-aviso";
import { CheckCircle, PaperPlaneTilt, WarningOctagon } from "@/lib/ui/icons";

const FRASE_DO_ESPACAMENTO =
  "Este número mandou uma mensagem agora há pouco. O WhatsApp exige um intervalo entre elas — tente de novo em alguns segundos.";

const TITULO_DO_EVENTO: Record<string, string> = {
  "appointment.created": "Novo agendamento",
  "appointment.rescheduled": "Remarcado",
  "appointment.cancelled": "Cancelado",
};

type Rascunho = RascunhoDoAvisoDeAgendamento;

function rascunhoDoEstado(estado: EstadoDaTelaDoAvisoDeAgendamento): Rascunho {
  if (!estado.config) {
    return { usaNumeroDoCaso: estado.aviso_de_caso !== null, canal: "", telefone: "", grupo: SEM_GRUPO, ligado: false };
  }
  return {
    usaNumeroDoCaso: estado.config.usa_numero_do_aviso_de_caso,
    canal: estado.config.channel_session_id ?? "",
    telefone: estado.config.telefone ?? "",
    grupo: estado.config.grupo ?? SEM_GRUPO,
    ligado: estado.config.ligado,
  };
}

export function AvisoDeAgendamento() {
  const t = useT();
  const { data: estado, isLoading, error } = useAvisoDeAgendamento();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
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
      <FormularioDoAviso key={estado.config?.atualizado_em ?? "sem-configuracao"} estado={estado} />
      <p className="text-xs text-muted-foreground">
        {t(
          "Das 22h às 7h não sai aviso, para não acordar ninguém: o que for marcado nesse horário aparece no resumo das 7h. O horário é o da empresa.",
        )}
      </p>
      <EntregasDoAviso estado={estado} />
    </div>
  );
}

function FormularioDoAviso({ estado }: { estado: EstadoDaTelaDoAvisoDeAgendamento }) {
  const t = useT();
  const salvar = useSalvarAvisoDeAgendamento();
  const testar = useTestarAvisoDeAgendamento();
  const telefoneExemplo = useTelefoneExemplo();
  const [rascunho, setRascunho] = useState<Rascunho>(() => rascunhoDoEstado(estado));
  const [confirmarContato, setConfirmarContato] = useState<string | null>(null);

  const oferecidas = estado.conexoes.filter((c) => c.aceitaMensagemLivre);
  const temAvisoDeCaso = estado.aviso_de_caso !== null;
  const usaCaso = rascunho.usaNumeroDoCaso && temAvisoDeCaso;
  const telefoneOk = telefoneDeAvisoValido(rascunho.telefone);
  const falta = oQueFaltaParaLigar({
    usaNumeroDoCaso: usaCaso,
    conexaoOferecida: oferecidas.some((c) => c.id === rascunho.canal),
    telefoneOk,
  });
  const destinoOk = falta === null;
  const podeSalvar = destinoOk && !salvar.isPending;
  const jaSalvo = estado.config !== null;
  const conexaoDoCaso = estado.conexoes.find((c) => c.id === estado.aviso_de_caso?.channel_session_id);
  const conexaoQueEnvia = conexaoQueEnviaDoRascunho(rascunho, estado.aviso_de_caso);
  const grupos = useGruposDaConexao(conexaoQueEnvia);
  // Trocar a conexão que envia zera o grupo: ele era da conexão anterior (R1, issue #1).
  const mudar = (mudanca: Partial<Rascunho>) =>
    setRascunho((r) => mudarRascunhoDoAviso(r, mudanca, estado.aviso_de_caso));

  async function enviar(confirma: boolean) {
    try {
      await salvar.mutateAsync({
        usa_numero_do_aviso_de_caso: usaCaso,
        ...(usaCaso ? {} : { channel_session_id: rascunho.canal, telefone: rascunho.telefone }),
        grupo: rascunho.grupo === SEM_GRUPO ? null : rascunho.grupo,
        ligado: rascunho.ligado,
        ...(confirma ? { confirma_contato: true } : {}),
      });
      setConfirmarContato(null);
      toast.success(t("Aviso salvo."));
    } catch (erro) {
      if (erro instanceof ApiError && erro.code === "aviso_numero_de_cliente") {
        setConfirmarContato(erro.message);
        return;
      }
      toast.error(erro instanceof ApiError ? erro.message : t("Não foi possível salvar o aviso. Tente de novo."));
    }
  }

  const fraseDoMotivo = (codigo: string | undefined) =>
    codigo === "espacamento"
      ? t(FRASE_DO_ESPACAMENTO)
      : codigo && codigo in FRASE_DO_ERRO_DO_AVISO
        ? t(FRASE_DO_ERRO_DO_AVISO[codigo as keyof typeof FRASE_DO_ERRO_DO_AVISO])
        : t("O aviso de teste não saiu.");

  async function mandarTeste() {
    try {
      const r = await testar.mutateAsync();
      if (r.enviado) {
        toast.success(
          r.grupo?.enviado
            ? t("Aviso de teste enviado ao número e ao grupo. Confira o WhatsApp.")
            : t("Aviso de teste enviado. Confira o WhatsApp desse número."),
        );
      } else {
        toast.error(fraseDoMotivo(r.codigo));
        if (r.grupo?.enviado) toast.success(t("Aviso de teste enviado ao grupo. Confira o WhatsApp."));
      }
      if (r.grupo && !r.grupo.enviado) {
        toast.error(`${t("O teste não chegou ao grupo.")} ${fraseDoMotivo(r.grupo.codigo)}`);
      }
    } catch (erro) {
      toast.error(erro instanceof ApiError ? erro.message : t("Não foi possível mandar o teste agora."));
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id="usa-numero-do-caso"
          checked={usaCaso}
          disabled={!temAvisoDeCaso || salvar.isPending}
          onCheckedChange={(v) => mudar({ usaNumeroDoCaso: v })}
          aria-label={t("Usar o mesmo número do aviso de caso")}
        />
        <div className="space-y-1">
          <Label htmlFor="usa-numero-do-caso" className="text-sm font-medium">
            {t("Usar o mesmo número do aviso de caso")}
          </Label>
          <p className="text-xs text-muted-foreground" data-testid="numero-do-caso">
            {temAvisoDeCaso
              ? `${t("Os avisos vão para")} ${estado.aviso_de_caso?.destino_mascarado}${
                  conexaoDoCaso ? `, ${t("enviados por")} ${conexaoDoCaso.nome}` : ""
                }. ${t("Se você trocar esse número no aviso de caso, estes avisos acompanham.")}`
              : t("O aviso de caso ainda não tem número. Escolha abaixo um número só para a agenda.")}
          </p>
        </div>
      </div>

      {!usaCaso ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conexao">{t("Conexão que envia os avisos")}</Label>
            <Select
              value={rascunho.canal}
              onValueChange={(v) => mudar({ canal: v })}
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
              {oferecidas.length === 0
                ? t("Nenhum número conectado consegue mandar estes avisos. Conecte um WhatsApp em Conexões.")
                : t("Só aparecem aqui os números que conseguem mandar uma mensagem a qualquer hora.")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="telefone">{t("Número que recebe os avisos")}</Label>
            <Input
              id="telefone"
              inputMode="tel"
              className="w-full sm:w-72"
              placeholder={telefoneExemplo}
              value={rascunho.telefone}
              onChange={(e) => setRascunho((r) => ({ ...r, telefone: normalizarTelefoneDeAviso(e.target.value) }))}
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
            {numeroPareceDeForaDoBrasil(rascunho.telefone, telefoneExemplo) ? (
              <p className="text-xs text-warning-fg" data-testid="telefone-fora-do-brasil">
                {t("Esse número não começa com +55. Ele é de fora do Brasil? Se for, pode seguir; se não, comece por +55 e o DDD.")}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grupo">{t("Grupo do WhatsApp que também recebe os avisos")}</Label>
        <Select
          value={rascunho.grupo}
          onValueChange={(v) => setRascunho((r) => ({ ...r, grupo: v }))}
          disabled={!conexaoQueEnvia || grupos.isLoading}
        >
          <SelectTrigger id="grupo" className="w-full sm:w-96" data-testid="grupo-do-aviso">
            <SelectValue placeholder={t("Nenhum grupo")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SEM_GRUPO}>{t("Nenhum grupo")}</SelectItem>
            {(grupos.data ?? [])
              .filter((g) => g.presente || g.chatId === rascunho.grupo)
              .map((g) => (
                <SelectItem key={g.chatId} value={g.chatId}>
                  {g.subject ?? g.chatId}
                </SelectItem>
              ))}
            {rascunho.grupo !== SEM_GRUPO &&
            rascunho.grupo === estado.config?.grupo &&
            !grupos.data?.some((g) => g.chatId === rascunho.grupo) ? (
              <SelectItem value={rascunho.grupo}>{t("Grupo salvo")}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {grupos.isError
            ? t("Não foi possível listar os grupos desta conexão agora. Confira se ela está conectada.")
            : t("Opcional. A equipe vê no grupo os mesmos avisos e o resumo das 7h, sem ninguém repassar.")}
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id="ligado"
          checked={rascunho.ligado}
          disabled={!destinoOk}
          onCheckedChange={(v) => setRascunho((r) => ({ ...r, ligado: v }))}
          aria-label={t("Receber avisos de agendamento no WhatsApp")}
        />
        <div className="space-y-1">
          <Label htmlFor="ligado" className="text-sm font-medium">
            {t("Receber avisos de agendamento no WhatsApp")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Chega o primeiro nome do cliente, o serviço, o dia e a hora, quem atende e de onde veio: IA, equipe ou Google Agenda.",
            )}
          </p>
          {falta ? (
            <p className="text-xs text-warning-fg" data-testid="o-que-falta-para-ligar">
              {falta === "conexao_e_numero"
                ? t("Para ligar, escolha a conexão que envia e preencha o número que recebe os avisos.")
                : falta === "conexao"
                  ? t("Para ligar, escolha a conexão que envia os avisos.")
                  : t("Para ligar, preencha o número completo que recebe os avisos.")}
            </p>
          ) : null}
        </div>
      </div>

      {confirmarContato ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
          data-testid="confirmar-numero-de-cliente"
        >
          <p className="text-sm font-medium">{confirmarContato}</p>
          <p className="text-xs text-muted-foreground">
            {t("Esse número passa a ser só da equipe: o que ele mandar deixa de virar atendimento.")}
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
        <Button variant="outline" onClick={() => void mandarTeste()} disabled={!jaSalvo || testar.isPending}>
          <PaperPlaneTilt className="mr-2 h-4 w-4" />
          {testar.isPending ? t("Enviando…") : t("Enviar teste")}
        </Button>
        {testar.data?.enviado || testar.data?.grupo?.enviado ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="teste-enviado-para">
            <CheckCircle className="h-4 w-4" weight="duotone" />
            {[
              testar.data.enviado ? `${t("Enviado para")} ${testar.data.destinoMascarado ?? ""}` : null,
              testar.data.grupo?.enviado
                ? `${testar.data.enviado ? t("e para o grupo") : t("Enviado para o grupo")} ${
                    grupos.data?.find((g) => g.chatId === estado.config?.grupo)?.subject ?? ""
                  }`
                : null,
            ]
              .filter(Boolean)
              .join(" ")
              .trim()}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("O teste manda uma mensagem de verdade e conta no limite diário desse número. Salve antes de testar.")}
      </p>
    </Card>
  );
}

/** No relógio da empresa; fuso inválido cai no do navegador em vez de quebrar a lista. */
function dataEHora(instante: Date, fuso: string): string {
  try {
    return instante.toLocaleString(undefined, { timeZone: fuso, dateStyle: "short", timeStyle: "short" });
  } catch {
    return instante.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  }
}

function EntregasDoAviso({ estado }: { estado: EstadoDaTelaDoAvisoDeAgendamento }) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="entregas-do-aviso-de-agendamento">
      <h2 className="text-sm font-semibold">{t("Últimos avisos")}</h2>
      {estado.entregas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Nenhum aviso ainda. Quando um horário for marcado com o aviso ligado, ele aparece aqui.")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {estado.entregas.map((e) => {
            const quando = new Date(e.enviado_em ?? e.created_at);
            const titulo =
              e.tipo === "resumo" ? t("Resumo do dia") : t(TITULO_DO_EVENTO[e.evento ?? ""] ?? "Aviso");
            const status = t(FRASE_DO_STATUS_DE_AGENDAMENTO[e.status as StatusDaEntregaDeAgendamento] ?? "Aviso");
            const erro =
              e.erro_codigo && e.erro_codigo in FRASE_DO_ERRO_DO_AVISO
                ? t(FRASE_DO_ERRO_DO_AVISO[e.erro_codigo as keyof typeof FRASE_DO_ERRO_DO_AVISO])
                : null;
            return (
              <li key={e.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{titulo}</span>
                  <span className="text-xs text-muted-foreground">
                    {dataEHora(quando, estado.fuso)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {status}
                  {e.destino_mascarado ? ` · ${e.destino_mascarado}` : ""}
                </span>
                {erro ? <span className="text-xs text-destructive">{erro}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

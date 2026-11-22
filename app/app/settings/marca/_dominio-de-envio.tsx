"use client";

/** Card da conta conectada: estado oficial da Resend e observação DNS separados.
 * O servidor resolve o From da organização ativa; a tela não escolhe domínio.
 */
import { useState, useTransition } from "react";

import {
  conferirDominioDeEnvio,
  type ResultadoDaConferenciaDoDominio,
} from "@/app/actions/settings/conferirDominioDeEnvio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  DiagnosticoDoDominioDeEnvio,
  EstadoDoRegistro,
  TipoDeRegistro,
} from "@/lib/email/dominio-de-envio";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** As recusas usam códigos próprios; mensagem bruta do provedor não vira texto da tela. */
/** O que o `t()` recebe quando o código não está no mapa — nunca uma chave vazia. */
const ERRO_DESCONHECIDO = "Não foi possível conferir agora. Tente de novo em instantes.";

/**
 * O marcador do carimbo de hora. Fica em constante de MÓDULO porque a frase é um
 * literal do dicionário com um buraco: montar a chave por interpolação
 * (`t(`Conferido em ${x}`)`) sairia em português para quem escolheu espanhol.
 */
const MARCA_DE_QUANDO = "{quando}";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não tem nenhuma organização ativa. Aceite um convite ou contate o admin.",
  forbidden_role: "Só um administrador da organização pode conferir o domínio.",
  mfa_required: "Confirme o segundo fator nesta sessão e tente de novo.",
  dominio_invalido: "O domínio informado pela conta não pôde ser conferido.",
  conta_nao_conectada: "Conecte a conta Resend da empresa para conferir o domínio de envio.",
  conta_indisponivel:
    "Não foi possível ler a conta de e-mail da empresa. Confira a conexão em Configurações › Marca e tente de novo.",
  chave_recusada: "A Resend não aceitou esta chave. Confira se você copiou a chave da API dela.",
  permissao_insuficiente:
    "Esta chave não permite consultar domínios. Crie uma chave Full Access na Resend e tente de novo.",
  consulta_indisponivel: "Não consegui consultar a Resend agora. Tente de novo em instantes.",
  dominio_nao_verificado:
    "O domínio da conta não foi encontrado na Resend. Confira a conexão da empresa.",
  sem_endereco: "Use um endereço de e-mail como contato@suaempresa.com",
  envio_desabilitado:
    "O envio está desativado para este domínio na Resend. Ative-o no painel da Resend e tente de novo.",
};

const ROTULO_DO_TIPO: Record<TipoDeRegistro, string> = {
  spf: "SPF: quem pode entregar",
  dkim: "DKIM: assinatura da mensagem",
  mx: "MX de retorno: as voltas",
  dmarc: "DMARC: o que fazer quando falha",
};

const ROTULO_DO_ESTADO: Record<EstadoDoRegistro, string> = {
  ok: "Confere com a Resend",
  atencao: "Atenção",
  ausente: "Ausente",
  conflitante: "Diferente do esperado",
  indisponivel: "Consulta indisponível",
};

/** A cor do selo por estado — `ausente` e `conflitante` são a mesma parede. */
const CLASSE_DO_ESTADO: Record<EstadoDoRegistro, string> = {
  ok: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  atencao: "border-amber-600/40 text-amber-700 dark:text-amber-400",
  ausente: "border-destructive/40 text-destructive",
  conflitante: "border-destructive/40 text-destructive",
  indisponivel: "border-amber-600/40 text-amber-700 dark:text-amber-400",
};

export function DominioDeEnvio({
  dominioInicial,
  idioma,
  contaIndisponivel = false,
}: {
  /** Derivado do From da conta; Reply-To pode pertencer a outro domínio. */
  readonly dominioInicial: string | null;
  readonly idioma: Idioma;
  readonly contaIndisponivel?: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  // Só as mensagens próprias conhecidas são traduzidas; DNS e dados livres ficam literais.
  const mensagensDoDiagnostico: Readonly<Record<string, string>> = {
    "Não foi possível consultar este registro. Tente de novo antes de alterar o DNS.": t(
      "Não foi possível consultar este registro. Tente de novo antes de alterar o DNS.",
    ),
    "Nenhum registro encontrado neste nome.": t("Nenhum registro encontrado neste nome."),
    "O valor publicado difere do informado pela Resend. Confira no painel antes de alterar.": t(
      "O valor publicado difere do informado pela Resend. Confira no painel antes de alterar.",
    ),
    "Nenhum DMARC encontrado neste nome. Confira também a política do domínio principal.": t(
      "Nenhum DMARC encontrado neste nome. Confira também a política do domínio principal.",
    ),
    "Há mais de um registro DMARC neste nome.": t("Há mais de um registro DMARC neste nome."),
    "O registro DMARC não tem p=none, p=quarantine ou p=reject válido.": t(
      "O registro DMARC não tem p=none, p=quarantine ou p=reject válido.",
    ),
    "O DMARC consultado declara pct abaixo de 100. Confira o valor publicado.": t(
      "O DMARC consultado declara pct abaixo de 100. Confira o valor publicado.",
    ),
    "O DMARC publicado usa p=none: monitora, sem pedir rejeição das mensagens.": t(
      "O DMARC publicado usa p=none: monitora, sem pedir rejeição das mensagens.",
    ),
    "O DMARC consultado não informa rua= para relatórios.": t(
      "O DMARC consultado não informa rua= para relatórios.",
    ),
    "O DMARC consultado declara alinhamento estrito (adkim=s ou aspf=s).": t(
      "O DMARC consultado declara alinhamento estrito (adkim=s ou aspf=s).",
    ),
    "A Resend não informou registros de envio para este domínio. Confira o painel da conta.": t(
      "A Resend não informou registros de envio para este domínio. Confira o painel da conta.",
    ),
  };
  const [diagnostico, setDiagnostico] = useState<DiagnosticoDoDominioDeEnvio | null>(null);
  // Guarda só o código; a frase da interface vem do mesmo dicionário.
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  function conferir(evento: React.FormEvent) {
    evento.preventDefault();
    iniciar(async () => {
      const resultado: ResultadoDaConferenciaDoDominio = await conferirDominioDeEnvio();
      if (!resultado.ok) {
        setDiagnostico(null);
        setErro(resultado.error);
        return;
      }
      setErro(null);
      setDiagnostico(resultado.diagnostico);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Domínio de envio")}</CardTitle>
        <CardDescription>
          {t(
            "Os registros esperados vêm da conta Resend conectada. A conferência compara o DNS e não garante a entrega na caixa de entrada.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={conferir}>
          <p className="min-w-64 flex-1 font-mono text-sm">
            {dominioInicial ??
              (contaIndisponivel
                ? t(
                    "Não foi possível ler a conta de e-mail da empresa. Confira a conexão em Configurações › Marca e tente de novo.",
                  )
                : t("Conecte a conta Resend da empresa para conferir o domínio de envio."))}
          </p>
          <Button type="submit" disabled={pendente || (!dominioInicial && !contaIndisponivel)}>
            {pendente ? t("Conferindo…") : t("Conferir")}
          </Button>
        </form>

        {erro ? (
          <p className="text-sm text-destructive" role="alert">
            {t(ERRO_EM_PORTUGUES[erro] ?? ERRO_DESCONHECIDO)}
          </p>
        ) : null}

        {diagnostico ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={
                  diagnostico.estadoNaResend === "verified" && diagnostico.envioHabilitado
                    ? CLASSE_DO_ESTADO.ok
                    : CLASSE_DO_ESTADO.conflitante
                }
              >
                {diagnostico.estadoNaResend === "verified" && diagnostico.envioHabilitado
                  ? t("Domínio verificado na Resend")
                  : t("Verificação precisa de atenção na Resend")}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">{diagnostico.dominio}</span>
              <span className="text-xs text-muted-foreground">
                {t("Conferido em {quando}").replace(
                  MARCA_DE_QUANDO,
                  new Date(diagnostico.conferidoEm).toLocaleString(idioma),
                )}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t("Registro")}</th>
                    <th className="py-1 pr-3 font-medium">{t("Nome")}</th>
                    <th className="py-1 pr-3 font-medium">{t("Situação")}</th>
                    <th className="py-1 font-medium">{t("Encontrado")}</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostico.registros.map((registro) => (
                    <tr
                      key={`${registro.tipo}:${registro.tipoDns}:${registro.nome}`}
                      className="border-t align-top"
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {t(ROTULO_DO_TIPO[registro.tipo])}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs break-all">
                        {registro.tipoDns}: {registro.nome}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Badge variant="outline" className={CLASSE_DO_ESTADO[registro.estado]}>
                          {t(ROTULO_DO_ESTADO[registro.estado])}
                        </Badge>
                      </td>
                      <td className="py-2 font-mono text-xs break-all">
                        <p>{registro.encontrado ?? t("Ausente")}</p>
                        <p className="text-muted-foreground">
                          {t("Esperado")}:{" "}
                          {registro.tipo === "dmarc"
                            ? t("Política DMARC definida por quem administra o domínio")
                            : registro.esperado}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {diagnostico.bloqueios.length > 0 ? (
              <section className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{t("Pendências do DNS")}</h3>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {diagnostico.bloqueios.map((pendencia, index) => (
                    <li key={`${pendencia.nome}:${index}`}>
                      <span className="font-mono">{pendencia.nome}</span>:{" "}
                      {mensagensDoDiagnostico[pendencia.mensagem] ?? pendencia.mensagem}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {diagnostico.avisos.length > 0 ? (
              <section className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{t("Avisos")}</h3>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {diagnostico.avisos.map((frase) => (
                    <li key={frase}>{mensagensDoDiagnostico[frase] ?? frase}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

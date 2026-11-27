"use client";

/**
 * O que cada etapa do funil informa ao Google Ads (migration 0436).
 *
 * Uma ou mais contas por etapa ABERTA de cada funil: ligada, a regra manda a ação de
 * conversão escolhida quando um negócio entra ali. Ganho é a compra (cartão da
 * conexão, logo acima) e perda não é conversão — por isso nenhuma das duas
 * aparece aqui.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { salvarRegrasDeConversaoGoogle } from "@/app/actions/settings/salvarRegrasDeConversaoGoogle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  CANAIS_DE_ENTRADA,
  CATEGORIAS_DE_CONVERSAO,
  type CanalDeEntrada,
  type CategoriaDeConversao,
  type RegraDeConversaoGoogle,
} from "@/lib/conversoes/regras-google";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { CriarAcaoNoGoogle } from "./_criarAcaoGoogle";

export interface EtapaAberta {
  id: string;
  nome: string;
  funil: string;
  /** Primeira etapa aberta do funil — onde o lead nasce. */
  primeira: boolean;
}

interface Rascunho {
  chave: string;
  descartavel: boolean;
  stageId: string;
  destino: "padrao" | "especifica";
  googleCustomerId: string;
  googleLoginCustomerId: string;
  enabled: boolean;
  label: string;
  googleActionId: string;
  category: CategoriaDeConversao;
  includedInConversions: boolean;
  channel: CanalDeEntrada;
}

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed:
    "Toda etapa ligada precisa de nome e ID da ação. Use cada conta de destino uma única vez por etapa.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar estas regras.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  etapa_invalida: "Uma das etapas não existe mais ou foi fechada. Atualize a página.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export interface ContaSugeridaGoogle {
  customerId: string;
  label: string;
  loginCustomerId: string | null;
}

function novoRascunho(
  stageId: string,
  chave: string,
  destino: Rascunho["destino"] = "padrao",
): Rascunho {
  return {
    chave,
    descartavel: false,
    stageId,
    destino,
    googleCustomerId: "",
    googleLoginCustomerId: "",
    enabled: false,
    label: "",
    googleActionId: "",
    category: "DEFAULT",
    includedInConversions: true,
    channel: "todos",
  };
}

function destinoValido(r: Rascunho) {
  return (
    r.destino === "padrao" ||
    (/^\d{10}$/.test(r.googleCustomerId) &&
      (!r.googleLoginCustomerId || /^\d{10}$/.test(r.googleLoginCustomerId)))
  );
}

/** A sugestão para uma etapa, pelo lugar e pelo nome. Só preenche; não liga ação nenhuma. */
function recomendado(etapa: EtapaAberta): Pick<Rascunho, "label" | "category"> | null {
  const nome = etapa.nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (etapa.primeira) return { label: "Novo lead", category: "CONTACT" };
  if (/qualific|problema|interess|diagnost/.test(nome))
    return { label: "Lead qualificado", category: "QUALIFIED_LEAD" };
  if (/orcament|proposta|cotac/.test(nome))
    return { label: "Orçamento enviado", category: "REQUEST_QUOTE" };
  if (/agend|consulta|visita|reuniao/.test(nome))
    return { label: "Agendamento", category: "BOOK_APPOINTMENT" };
  return null;
}

export function RegrasDeConversaoGoogle({
  etapas,
  regras,
  idioma,
  podeCriarAcao,
  contaPadraoId,
  contaPadraoMcc,
  contasSugeridas = [],
}: {
  etapas: EtapaAberta[];
  regras: RegraDeConversaoGoogle[];
  idioma: Idioma;
  /** A instalação tem developer token e a conta autorizou o escopo do Google Ads. */
  podeCriarAcao: boolean;
  contaPadraoId?: string | null;
  contaPadraoMcc?: string | null;
  /** Apenas nomes e IDs; uma conexão de relatório não autoriza o envio. */
  contasSugeridas?: ContaSugeridaGoogle[];
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const proximaChave = useRef(0);
  const [rascunhos, setRascunhos] = useState<Rascunho[]>(() =>
    etapas.flatMap((e) => {
      const daEtapa = regras.filter((r) => r.stageId === e.id);
      const paraRascunho = (r: RegraDeConversaoGoogle): Rascunho => ({
        ...novoRascunho(e.id, r.id),
        ...r,
        chave: r.id,
        destino: r.googleCustomerId ? "especifica" : "padrao",
        googleCustomerId: r.googleCustomerId ?? "",
        googleLoginCustomerId: r.googleLoginCustomerId ?? "",
      });
      if (daEtapa.length === 0) return [novoRascunho(e.id, `padrao-${e.id}`)];
      return [
        ...daEtapa.filter((r) => !r.googleCustomerId),
        ...daEtapa.filter((r) => r.googleCustomerId),
      ].map(paraRascunho);
    }),
  );
  const ligadas = etapas.filter((e) =>
    rascunhos.some((r) => r.stageId === e.id && r.enabled),
  ).length;

  function mudar(chave: string, parcial: Partial<Rascunho>) {
    setRascunhos((atual) => atual.map((r) => (r.chave === chave ? { ...r, ...parcial } : r)));
  }

  function mudarDestino(chave: string, parcial: Partial<Rascunho>) {
    mudar(chave, { ...parcial, googleActionId: "" });
  }

  function acaoCriada(antes: Rascunho, id: string, nome: string) {
    // Uma criação em andamento pode terminar depois da troca de conta.
    setRascunhos((atual) =>
      atual.map((r) =>
        r.chave === antes.chave &&
        r.destino === antes.destino &&
        r.googleCustomerId === antes.googleCustomerId &&
        r.googleLoginCustomerId === antes.googleLoginCustomerId
          ? { ...r, googleActionId: id, label: r.label || nome }
          : r,
      ),
    );
  }

  function adicionarConta(etapa: EtapaAberta) {
    const novo = novoRascunho(etapa.id, `nova-${proximaChave.current++}`, "especifica");
    setRascunhos((atual) => [
      ...atual,
      { ...novo, ...recomendado(etapa), enabled: true, descartavel: true },
    ]);
  }

  function usarRecomendado() {
    setRascunhos((atual) => {
      return atual.map((r) => {
        const e = etapas.find((e) => e.id === r.stageId);
        const sugestao = e && recomendado(e);
        if (!sugestao) return r;
        return {
          ...r,
          enabled: true,
          label: r.label || sugestao.label,
          category: r.label ? r.category : sugestao.category,
        };
      });
    });
    toast.message(
      t("Etapas recomendadas ligadas. Informe ou crie a ação de conversão de cada uma e salve."),
    );
  }

  function salvar() {
    const paraSalvar = rascunhos.filter(
      (r) => r.enabled || r.destino === "padrao" || r.googleCustomerId,
    );
    if (paraSalvar.some((r) => !destinoValido(r))) {
      toast.error(t("Informe os 10 dígitos da conta de destino e, se houver, do MCC."));
      return;
    }
    startTransition(async () => {
      const resultado = await salvarRegrasDeConversaoGoogle(
        paraSalvar.map((r) => {
          return {
            stage_id: r.stageId,
            google_customer_id: r.destino === "especifica" ? r.googleCustomerId : null,
            google_login_customer_id:
              r.destino === "especifica" ? r.googleLoginCustomerId || null : null,
            enabled: r.enabled,
            label: r.label,
            google_action_id: r.googleActionId,
            category: r.category,
            included_in_conversions: r.includedInConversions,
            channel: r.channel,
          };
        }),
      );
      if (resultado.ok) {
        const chavesSalvas = new Set(paraSalvar.map((r) => r.chave));
        setRascunhos((atual) =>
          atual.map((r) => (chavesSalvas.has(r.chave) ? { ...r, descartavel: false } : r)),
        );
        toast.success(t("Regras salvas."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  if (etapas.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        {t("Crie um funil com etapas para escolher o que cada etapa informa ao Google Ads.")}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-6" data-testid="regras-google-por-etapa">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="font-medium">{t("O que cada etapa do funil informa ao Google Ads")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Quanto mais cedo você avisa, mais dados a campanha tem para aprender — mas só a venda ensina o Google a buscar quem compra. Cada etapa ligada envia a sua ação de conversão uma vez por negócio, quando ele entra ali.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground" data-testid="etapas-enviando">
            {ligadas} {t("de")} {etapas.length} {t("etapas enviando")}
          </span>
          <Button type="button" variant="outline" onClick={usarRecomendado}>
            {t("Usar o recomendado")}
          </Button>
        </div>
      </div>

      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        {t(
          "Todas as regras usam a autorização de envio da conexão Google acima. Ela precisa ter acesso a cada conta de destino. Conectar uma conta para relatórios não autoriza o envio de conversões.",
        )}
      </p>
      {contasSugeridas.length > 0 && (
        <datalist id="contas-google-sugeridas">
          {contasSugeridas.map((c) => (
            <option key={c.customerId} value={c.customerId}>
              {c.label}
            </option>
          ))}
        </datalist>
      )}
      <ul className="flex flex-col gap-3">
        {etapas.map((e) => (
          <li key={e.id} className="flex flex-col gap-3" data-testid={`etapa-google-${e.id}`}>
            {rascunhos
              .filter((r) => r.stageId === e.id)
              .map((r, indice) => {
                const idDom = indice === 0 ? e.id : `${e.id}-${r.chave}`;
                const customerId = r.destino === "especifica" ? r.googleCustomerId : contaPadraoId;
                const mcc = r.destino === "especifica" ? r.googleLoginCustomerId : contaPadraoMcc;
                const nomeDaConta = contasSugeridas.find((c) => c.customerId === customerId)?.label;
                return (
                  <div
                    key={r.chave}
                    className="rounded-md border p-4"
                    data-testid={`regra-${idDom}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{e.nome}</p>
                        <p className="text-xs text-muted-foreground">
                          {e.funil}
                          {" · "}
                          {r.enabled
                            ? `${r.label || t("sem nome")} · ${
                                CATEGORIAS_DE_CONVERSAO.find((c) => c.valor === r.category)
                                  ?.rotulo ?? r.category
                              }`
                            : t("não envia conversão")}
                        </p>
                        <p
                          className="mt-1 text-xs text-muted-foreground"
                          data-testid={`destino-${idDom}`}
                        >
                          {r.destino === "padrao" ? t("Conta padrão") : t("Conta específica")}
                          {" · "}
                          {customerId || t("Conta não informada")}
                          {nomeDaConta && nomeDaConta !== customerId ? ` · ${nomeDaConta}` : ""}
                          {" · "}
                          {mcc ? `MCC ${mcc}` : t("Acesso direto")}
                        </p>
                      </div>
                      {r.descartavel && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            setRascunhos((atual) => atual.filter((item) => item.chave !== r.chave))
                          }
                        >
                          {t("Descartar")}
                        </Button>
                      )}
                      <Switch
                        aria-label={t("Enviar conversão nesta etapa")}
                        checked={r.enabled}
                        onCheckedChange={(v) => mudar(r.chave, { enabled: v })}
                      />
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor={`destino-conta-${idDom}`}>{t("Conta de destino")}</Label>
                        <select
                          id={`destino-conta-${idDom}`}
                          className="rounded-md border bg-background p-2 text-sm"
                          value={r.destino}
                          onChange={(ev) =>
                            mudarDestino(r.chave, {
                              destino: ev.target.value as Rascunho["destino"],
                              googleCustomerId: "",
                              googleLoginCustomerId: "",
                            })
                          }
                        >
                          <option value="padrao">{t("Conta padrão")}</option>
                          <option value="especifica">{t("Conta específica")}</option>
                        </select>
                      </div>
                      {r.destino === "especifica" && (
                        <>
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`conta-${idDom}`}>{t("ID da conta de destino")}</Label>
                            <Input
                              id={`conta-${idDom}`}
                              inputMode="numeric"
                              maxLength={14}
                              list="contas-google-sugeridas"
                              placeholder="1234567890"
                              value={r.googleCustomerId}
                              onChange={(ev) => {
                                const id = ev.target.value.replace(/\D/g, "").slice(0, 10);
                                const sugestao = contasSugeridas.find((c) => c.customerId === id);
                                mudarDestino(r.chave, {
                                  googleCustomerId: id,
                                  googleLoginCustomerId: sugestao?.loginCustomerId ?? "",
                                });
                              }}
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`mcc-${idDom}`}>
                              {t("ID da conta administradora (MCC, opcional)")}
                            </Label>
                            <Input
                              id={`mcc-${idDom}`}
                              inputMode="numeric"
                              maxLength={14}
                              value={r.googleLoginCustomerId}
                              placeholder="1234567890"
                              onChange={(ev) =>
                                mudarDestino(r.chave, {
                                  googleLoginCustomerId: ev.target.value
                                    .replace(/\D/g, "")
                                    .slice(0, 10),
                                })
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              {t("Use 10 dígitos. Deixe o MCC vazio para acesso direto à conta.")}
                            </p>
                          </div>
                        </>
                      )}
                    </div>

                    {r.enabled && (
                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`nome-${idDom}`}>{t("Nome da conversão")}</Label>
                          <Input
                            id={`nome-${idDom}`}
                            value={r.label}
                            maxLength={100}
                            onChange={(ev) => mudar(r.chave, { label: ev.target.value })}
                            placeholder={t("ex.: Lead qualificado")}
                          />
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`acao-${idDom}`}>{t("Ação de conversão (ID)")}</Label>
                          <div className="flex gap-2">
                            <Input
                              id={`acao-${idDom}`}
                              inputMode="numeric"
                              value={r.googleActionId}
                              onChange={(ev) =>
                                mudar(r.chave, {
                                  googleActionId: ev.target.value.replace(/\D/g, ""),
                                })
                              }
                              placeholder="123456789"
                            />
                            <CriarAcaoNoGoogle
                              idioma={idioma}
                              habilitado={
                                podeCriarAcao &&
                                destinoValido(r) &&
                                (r.destino !== "padrao" || contaPadraoId !== null)
                              }
                              googleCustomerId={
                                r.destino === "especifica" ? r.googleCustomerId : null
                              }
                              googleLoginCustomerId={
                                r.destino === "especifica" ? r.googleLoginCustomerId || null : null
                              }
                              motivoDesabilitado={
                                !destinoValido(r)
                                  ? t(
                                      "Informe os 10 dígitos da conta de destino e, se houver, do MCC.",
                                    )
                                  : r.destino === "padrao" && contaPadraoId === null
                                    ? t(
                                        "Informe a conta padrão na conexão Google acima ou escolha uma conta específica.",
                                      )
                                    : undefined
                              }
                              nome={r.label}
                              categoria={r.category}
                              incluirEmConversoes={r.includedInConversions}
                              onCriada={(id, nomeFinal) => acaoCriada(r, id, nomeFinal)}
                            />
                          </div>
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`categoria-${idDom}`}>
                            {t("Categoria da conversão")}
                          </Label>
                          <select
                            id={`categoria-${idDom}`}
                            className="rounded-md border bg-background p-2 text-sm"
                            value={r.category}
                            onChange={(ev) =>
                              mudar(r.chave, { category: ev.target.value as CategoriaDeConversao })
                            }
                          >
                            {CATEGORIAS_DE_CONVERSAO.map((c) => (
                              <option key={c.valor} value={c.valor}>
                                {t(c.rotulo)}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-muted-foreground">
                            {t("É como o Google agrupa a conversão nos relatórios e nos lances.")}
                          </p>
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`canal-${idDom}`}>{t("Canal de entrada")}</Label>
                          <select
                            id={`canal-${idDom}`}
                            className="rounded-md border bg-background p-2 text-sm"
                            value={r.channel}
                            onChange={(ev) =>
                              mudar(r.chave, { channel: ev.target.value as CanalDeEntrada })
                            }
                          >
                            {CANAIS_DE_ENTRADA.map((c) => (
                              <option key={c.valor} value={c.valor}>
                                {t(c.rotulo)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-3 md:col-span-2">
                          <Switch
                            id={`incluida-${idDom}`}
                            checked={r.includedInConversions}
                            onCheckedChange={(v) => mudar(r.chave, { includedInConversions: v })}
                          />
                          <Label htmlFor={`incluida-${idDom}`}>
                            {t('Incluir na coluna "Conversões" (os lances otimizam por ela)')}
                          </Label>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            <div>
              <Button type="button" variant="outline" onClick={() => adicionarConta(e)}>
                {t("Adicionar conta nesta etapa")}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        {t(
          "A regra usa o clique do próprio negócio e vale para mudanças de etapa feitas pela equipe, pela IA ou por automação após a ativação. Uma conta específica sempre exige que o clique identifique a mesma conta. Só a Conta padrão permite enviar sem identificação da conta no clique ou com outra conta, quando há uma única conta cadastrada. Com várias contas, incluindo destinos de regras pausadas, o clique precisa identificar a conta de destino.",
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "Se uma conversão não sair, confira a pendência no Histórico de envios. Pausar uma regra preserva seus campos e o histórico.",
        )}
      </p>
      <div>
        <Button type="button" onClick={salvar} disabled={isPending}>
          {isPending ? t("Salvando...") : t("Salvar regras")}
        </Button>
      </div>
    </Card>
  );
}

"use client";
/**
 * A fila de encaixe: prazos da organização, inscrição e resposta à oferta.
 *
 * Os prazos nascem em branco de propósito (doc 208): não há valor sugerido, e o
 * recurso só liga depois de a organização escolher os três.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

type Config = {
  ativa: boolean;
  prazo_maximo_minutos: number;
  margem_antes_minutos: number;
  prazo_minimo_minutos: number;
};

type Inscricao = {
  id: string;
  contato: string | null;
  servico: string | null;
  status: "waiting" | "offered";
  urgencia: number;
  oferta_expira_em: string | null;
};

type Estado = { config: Config | null; fila: Inscricao[] };
type Tipo = { id: string; name: string };
type Contato = { id: string; name: string | null; display_name: string | null; phone_number: string | null };

const CHAVE = ["agenda", "lista-de-espera"];
const CAMPOS_DE_PRAZO = ["prazo_maximo_minutos", "margem_antes_minutos", "prazo_minimo_minutos"] as const;

function Prazos({ config }: { config: Config | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [ativa, setAtiva] = useState(config?.ativa ?? false);
  const [prazos, setPrazos] = useState<Record<string, string>>({
    prazo_maximo_minutos: config ? String(config.prazo_maximo_minutos) : "",
    margem_antes_minutos: config ? String(config.margem_antes_minutos) : "",
    prazo_minimo_minutos: config ? String(config.prazo_minimo_minutos) : "",
  });
  const faltaPrazo = CAMPOS_DE_PRAZO.some((campo) => prazos[campo] === "");
  const rotulos = {
    prazo_maximo_minutos: t("Prazo máximo da oferta (minutos)"),
    margem_antes_minutos: t("Folga antes do horário (minutos)"),
    prazo_minimo_minutos: t("Prazo mínimo para oferecer (minutos)"),
  };

  const salvar = useMutation({
    mutationFn: () =>
      apiClient.patch("/api/v1/agenda/lista-de-espera", {
        ativa,
        prazo_maximo_minutos: Number(prazos.prazo_maximo_minutos),
        margem_antes_minutos: Number(prazos.margem_antes_minutos),
        prazo_minimo_minutos: Number(prazos.prazo_minimo_minutos),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
    onError: (erro) => showApiError(erro),
  });

  return (
    <section className="max-w-xl space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">{t("Prazos desta organização")}</h2>
      <p className="text-sm text-text-muted">
        {t("Não há valor padrão. A lista de espera só liga depois de você escolher os três.")}
      </p>
      {CAMPOS_DE_PRAZO.map((campo) => (
        <div key={campo} className="space-y-1">
          <Label htmlFor={campo}>{rotulos[campo]}</Label>
          <Input
            id={campo}
            type="number"
            min={0}
            max={1440}
            value={prazos[campo]}
            onChange={(e) => setPrazos({ ...prazos, [campo]: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Switch id="lista_de_espera_ativa" checked={ativa} onCheckedChange={setAtiva} disabled={faltaPrazo} />
        <Label htmlFor="lista_de_espera_ativa">{t("Ligar a lista de espera nesta organização")}</Label>
      </div>
      <Button onClick={() => salvar.mutate()} disabled={faltaPrazo || salvar.isPending}>
        {salvar.isPending ? t("Salvando…") : t("Salvar")}
      </Button>
    </section>
  );
}

function NovaInscricao() {
  const t = useT();
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [contatoId, setContatoId] = useState("");
  const [tipoId, setTipoId] = useState("");
  const [consentimento, setConsentimento] = useState(false);

  const { data: tipos } = useQuery({
    queryKey: ["agenda", "tipos"],
    queryFn: async () => (await apiClient.get<{ data: Tipo[] }>("/api/v1/agenda/tipos")).data,
  });
  const { data: contatos } = useQuery({
    queryKey: ["contatos", "lista-de-espera", busca],
    enabled: busca.trim().length >= 2,
    queryFn: async () =>
      (await apiClient.get<{ data: Contato[] }>(`/api/v1/contacts?search=${encodeURIComponent(busca.trim())}&limit=8`)).data,
  });

  const inscrever = useMutation({
    mutationFn: () =>
      apiClient.post("/api/v1/agenda/lista-de-espera", {
        contact_id: contatoId,
        event_type_id: tipoId,
        consentimento: true,
      }),
    onSuccess: () => {
      setBusca("");
      setContatoId("");
      setConsentimento(false);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (erro) => showApiError(erro),
  });

  return (
    <section className="max-w-xl space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">{t("Inscrever na lista")}</h2>
      <div className="space-y-1">
        <Label htmlFor="espera_busca">{t("Contato")}</Label>
        <Input id="espera_busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={t("Nome ou telefone")} />
        {(contatos ?? []).length > 0 ? (
          <select
            aria-label={t("Contato")}
            className="min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={contatoId}
            onChange={(e) => setContatoId(e.target.value)}
          >
            <option value="">{t("Escolha o contato")}</option>
            {(contatos ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {nomeDoContato(c) ?? c.phone_number ?? t("Contato")}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="espera_tipo">{t("Atendimento")}</Label>
        <select
          id="espera_tipo"
          className="min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={tipoId}
          onChange={(e) => setTipoId(e.target.value)}
        >
          <option value="">{t("Escolha o atendimento")}</option>
          {(tipos ?? []).map((tipo) => (
            <option key={tipo.id} value={tipo.id}>{tipo.name}</option>
          ))}
        </select>
      </div>
      <div className="flex items-start gap-2">
        <input
          id="espera_consentimento"
          type="checkbox"
          className="mt-1 size-4"
          checked={consentimento}
          onChange={(e) => setConsentimento(e.target.checked)}
        />
        <Label htmlFor="espera_consentimento">{t("A pessoa aceitou ser avisada quando abrir uma vaga")}</Label>
      </div>
      <Button
        onClick={() => inscrever.mutate()}
        disabled={!contatoId || !tipoId || !consentimento || inscrever.isPending}
      >
        {t("Inscrever")}
      </Button>
    </section>
  );
}

export function ListaDeEspera({ podeConfigurar, podeOperar }: { podeConfigurar: boolean; podeOperar: boolean }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Estado }>("/api/v1/agenda/lista-de-espera")).data,
  });

  const responder = useMutation({
    mutationFn: ({ id, acao }: { id: string; acao: "aceitar" | "recusar" | "sair" }) =>
      apiClient.post(`/api/v1/agenda/lista-de-espera/${id}`, { acao }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
    onError: (erro) => showApiError(erro),
  });

  if (isLoading || !data) return <p className="text-sm text-text-muted">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4">
      {podeConfigurar ? <Prazos key={JSON.stringify(data.config)} config={data.config} /> : null}
      {data.config?.ativa ? (
        <>
          {podeOperar ? <NovaInscricao /> : null}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{t("Fila")}</h2>
            {data.fila.length === 0 ? (
              <p className="text-sm text-text-muted">{t("Ninguém na fila.")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.fila.map((inscricao) => (
                  <li key={inscricao.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{inscricao.contato ?? t("Contato")}</p>
                      <p className="text-sm text-text-muted">
                        {inscricao.servico ?? t("Atendimento")}
                        {inscricao.status === "offered" && inscricao.oferta_expira_em
                          ? ` · ${t("Oferta até")} ${new Date(inscricao.oferta_expira_em).toLocaleTimeString(tagDoIdioma, { hour: "2-digit", minute: "2-digit" })}`
                          : ""}
                      </p>
                    </div>
                    {podeOperar ? (
                      <div className="flex flex-wrap gap-2">
                        {inscricao.status === "offered" ? (
                          <>
                            <Button size="sm" onClick={() => responder.mutate({ id: inscricao.id, acao: "aceitar" })}>
                              {t("Aceitou")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => responder.mutate({ id: inscricao.id, acao: "recusar" })}>
                              {t("Recusou")}
                            </Button>
                          </>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => responder.mutate({ id: inscricao.id, acao: "sair" })}>
                          {t("Tirar da fila")}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

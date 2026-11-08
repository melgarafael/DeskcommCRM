"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ImportarLeads } from "@/app/app/kanban/_components/ImportarLeads";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChatThread } from "@/components/inbox/ChatThread";
import { Composer } from "@/components/inbox/Composer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useVoiceCall } from "@/components/voice/VoiceCallContext";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { useVoiceSessionStatus } from "@/hooks/voice/useVoiceSessionStatus";
import { apiClient } from "@/lib/api/client";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";
import { copyToClipboard } from "@/lib/clipboard";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  aceitaResultadoDaLigacao,
  caminhoDaLigacao,
  comoTerminou,
  ETAPAS_DA_FILA,
  linhasDoRoteiro,
  ordenarFila,
  RESULTADOS,
  RESULTADOS_DA_LIGACAO,
  ROTULO_DE_NAO_LIGAR,
  type MotivoParaNaoLigar,
  type ResultadoDaLigacao,
} from "@/lib/cold-call/regras";
import { liberarSons, tocarAtendeu, tocarDiscando, tocarEncerrou, tocarRecusada } from "@/lib/cold-call/sons";
import { GuiaDoColdCall, guiaJaVisto } from "./_guia";
import {
  ArrowRight,
  CalendarCheck,
  CalendarPlus,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChartBar,
  Check,
  Clock,
  ClockCounterClockwise,
  Copy,
  Fire,
  ListChecks,
  MagnifyingGlass,
  Pause,
  Phone,
  PhoneOutgoing,
  PhoneX,
  Play,
  Trash,
  Users,
  Voicemail,
  Warning,
  Waveform,
  WhatsappLogo,
  XCircle,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Tentativa {
  resultado: ResultadoDaLigacao | null;
  em: string;
}

interface Lead {
  id: string;
  titulo: string;
  descricao: string | null;
  tags: string[];
  contato_id: string | null;
  tem_foto: boolean;
  /** Bloqueado, pessoal ou anonimizado: fica visível na lista, mas não recebe ligação. */
  nao_ligar: MotivoParaNaoLigar | null;
  contato_nome: string | null;
  telefone: string | null;
  email: string | null;
  endereco: string | null;
  conversa_id: string | null;
  responsavel_id: string | null;
  etapa: string;
  etapa_nome: string;
  tentativas: number;
  ultima_tentativa_em: string | null;
  ultimo_resultado: ResultadoDaLigacao | null;
  historico: Tentativa[];
  criado_em: string;
}

interface Dados {
  funil: { id: string; name: string; slug: string; description: string | null; position: number; is_default: boolean } | null;
  roteiro: string;
  leads: Lead[];
}

const CHAVE = ["cold-call"];
const POR_PAGINA = 12;

function dataEHora(iso: string, idioma: string): string {
  return new Date(iso).toLocaleString(idioma, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function hora(iso: string, idioma: string): string {
  return new Date(iso).toLocaleTimeString(idioma, { hour: "2-digit", minute: "2-digit" });
}

/** Como quem liga se apresenta no roteiro: o primeiro nome, ou o começo do e-mail. */
function primeiroNome(usuario: { full_name: string | null; email: string }): string {
  const nome = (usuario.full_name ?? "").trim() || usuario.email.split("@")[0]!;
  const primeiro = nome.split(/[\s._-]+/)[0]!;
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase() || "?";
}

function Iniciais({ nome, tamanho = "size-8" }: { nome: string; tamanho?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent-soft text-[11px] font-bold text-accent",
        tamanho,
      )}
      aria-hidden
    >
      {iniciais(nome)}
    </span>
  );
}

/**
 * O resultado da ligação, na coluna do contato. Para quem não recebe ligação (bloqueado,
 * pessoal, anonimizado) ele fica desabilitado e diz por quê: o servidor recusaria com 403.
 */
export function SeletorDoResultado({
  valor,
  aoMudar,
  naoLigar,
}: {
  valor: ResultadoDaLigacao | null;
  aoMudar: (resultado: ResultadoDaLigacao | null) => void;
  naoLigar: MotivoParaNaoLigar | null;
}) {
  const t = useT();
  const aceita = aceitaResultadoDaLigacao(naoLigar);
  return (
    <>
      <label className="mt-3 block text-xs text-text-muted" htmlFor="resultado-cold-call">
        {t("Resultado Cold Call")}
      </label>
      <select
        id="resultado-cold-call"
        value={aceita ? (valor ?? "") : ""}
        disabled={!aceita}
        aria-describedby={naoLigar ? "resultado-cold-call-motivo" : undefined}
        onChange={(e) => aoMudar((e.target.value || null) as ResultadoDaLigacao | null)}
        className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-elevated/40 px-2 text-sm text-text outline-hidden transition-colors focus:border-accent disabled:opacity-50"
        data-testid="resultado-cold-call"
      >
        <option value="">--</option>
        {RESULTADOS_DA_LIGACAO.map((id) => (
          <option key={id} value={id}>
            {t(RESULTADOS[id].rotulo)}
          </option>
        ))}
      </select>
      {naoLigar && (
        <p id="resultado-cold-call-motivo" className="mt-1 text-xs font-medium text-error" data-testid="motivo-sem-resultado">
          {t("Não ligar")} · {t(ROTULO_DE_NAO_LIGAR[naoLigar])}
        </p>
      )}
    </>
  );
}

/** Quem não recebe ligação chega sem telefone (a rota não manda): a tela diz "Não ligar", não "Sem telefone". */
function telefoneNaTela(lead: Lead, t: (texto: string) => string): string {
  return lead.nao_ligar ? t("Não ligar") : (lead.telefone ?? t("Sem telefone"));
}

function FotoDoLead({ lead, tamanho = "size-8" }: { lead: Lead; tamanho?: string }) {
  return (
    <Avatar className={cn("shrink-0", tamanho)}>
      {lead.tem_foto && lead.contato_id ? (
        <AvatarImage src={`/api/v1/contacts/${lead.contato_id}/avatar`} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback className="bg-transparent">
        <Iniciais nome={lead.titulo} tamanho={tamanho} />
      </AvatarFallback>
    </Avatar>
  );
}

export function ColdCall() {
  const t = useT();
  const org = useActiveOrg();
  const qc = useQueryClient();
  const podeGerenciar = !!org && ROLE_RANK[org.role] >= ROLE_RANK.manager;
  const [sessao, setSessao] = useState<string[] | null>(null);
  const [editando, setEditando] = useState(false);
  const [guia, setGuia] = useState(false);

  // Depois de montar: o servidor não enxerga o armazenamento do navegador.
  useEffect(() => {
    if (!guiaJaVisto()) setGuia(true);
  }, []);

  const consulta = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Dados }>("/api/v1/cold-call")).data,
  });

  const criar = useMutation({
    mutationFn: () => apiClient.post("/api/v1/cold-call", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: showApiError,
  });

  const dados = consulta.data;

  if (consulta.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <h1>{t("Cold Call")}</h1>
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  if (consulta.isError || !dados) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1>{t("Cold Call")}</h1>
        <p className="text-sm text-text-muted">{t("Não consegui carregar a fila de ligações.")}</p>
        <Button variant="outline" onClick={() => void consulta.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  if (!dados.funil) {
    return (
      <div className="flex flex-col gap-4">
        <h1>{t("Cold Call")}</h1>
        <section className="flex max-w-2xl flex-col items-start gap-4 rounded-2xl border border-border/70 bg-surface p-6">
          <span className="flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Phone size={24} weight="duotone" aria-hidden />
          </span>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-text">{t("Monte sua fila de ligações")}</h2>
            <p className="mt-1 text-sm leading-relaxed text-text-muted">
              {t("Criamos um funil só para o cold call, com as etapas e um roteiro para editar. Depois é importar a lista e começar a ligar, um lead por vez.")}
            </p>
          </div>
          {podeGerenciar ? (
            <Button onClick={() => criar.mutate()} disabled={criar.isPending} data-testid="criar-funil-cold-call">
              {t("Criar funil de cold call")}
            </Button>
          ) : (
            <p className="text-sm text-text-muted">{t("Peça a quem administra o CRM para criar o funil.")}</p>
          )}
        </section>
      </div>
    );
  }

  if (sessao) {
    return <Sessao roteiro={dados.roteiro} leads={dados.leads} ordemInicial={sessao} aoSair={() => setSessao(null)} />;
  }

  return (
    <>
      <Fila
        leads={dados.leads}
        funil={dados.funil}
        podeGerenciar={podeGerenciar}
        aoComecar={setSessao}
        aoEditarRoteiro={() => setEditando(true)}
        aoAbrirGuia={() => setGuia(true)}
      />
      {editando && <EditorDoRoteiro roteiro={dados.roteiro} aoFechar={() => setEditando(false)} />}
      {guia && <GuiaDoColdCall aoFechar={() => setGuia(false)} />}
    </>
  );
}

function Fila({
  leads,
  funil,
  podeGerenciar,
  aoComecar,
  aoEditarRoteiro,
  aoAbrirGuia,
}: {
  leads: Lead[];
  funil: NonNullable<Dados["funil"]>;
  podeGerenciar: boolean;
  aoComecar: (ids: string[]) => void;
  aoEditarRoteiro: () => void;
  aoAbrirGuia: () => void;
}) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const qc = useQueryClient();
  const [etapa, setEtapa] = useState("fila");
  const [busca, setBusca] = useState("");
  const [titular, setTitular] = useState("");
  const [pagina, setPagina] = useState(0);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [removendo, setRemovendo] = useState<Lead | null>(null);
  const membros = useTeamMembers({ enabled: podeGerenciar });

  const nomes = useMemo(() => {
    const mapa = new Map<string, string>();
    for (const m of membros.data?.data ?? []) mapa.set(m.user_id, m.full_name || m.email || "");
    return mapa;
  }, [membros.data]);

  const fila = useMemo(() => ordenarFila(leads), [leads]);
  const etapas = useMemo(() => {
    const vistas = new Map<string, string>();
    for (const l of leads) vistas.set(l.etapa, l.etapa_nome);
    return [...vistas.entries()];
  }, [leads]);

  const visiveis = useMemo(() => {
    const base = etapa === "fila" ? fila : etapa === "todos" ? leads : leads.filter((l) => l.etapa === etapa);
    // A busca ignora caixa E acento (#4167): `sao joao` acha "São João".
    // O telefone passa pela mesma régua e continua igual — dígito não tem acento.
    const termo = termoSemAcento(busca.trim());
    return base.filter(
      (l) =>
        (!termo ||
          termoSemAcento(l.titulo).includes(termo) ||
          (l.telefone ?? "").includes(termo)) &&
        (!titular || l.responsavel_id === titular),
    );
  }, [busca, etapa, fila, leads, titular]);

  const paginas = Math.max(1, Math.ceil(visiveis.length / POR_PAGINA));
  const atual = Math.min(pagina, paginas - 1);
  const daPagina = visiveis.slice(atual * POR_PAGINA, (atual + 1) * POR_PAGINA);
  const tudoMarcado = daPagina.length > 0 && daPagina.every((l) => marcados.has(l.id));

  const remover = useMutation({
    mutationFn: (lead: Lead) =>
      apiClient.post("/api/v1/cold-call/resultado", { lead_id: lead.id, resultado: "removido" }),
    onSuccess: () => {
      setRemovendo(null);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: showApiError,
  });

  const comecar = () => {
    const ordem = fila.filter((l) => !l.nao_ligar && (marcados.size === 0 || marcados.has(l.id))).map((l) => l.id);
    if (ordem.length > 0) aoComecar(ordem);
  };

  const classeDoFiltro =
    "h-10 rounded-lg border border-border bg-surface-elevated/40 px-3 text-sm text-text outline-hidden focus:border-accent";

  return (
    <div className="flex flex-col gap-4" data-testid="fila-de-ligacoes">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border/70 pb-3">
        <h1>{t("Cold Call")}</h1>
        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label={t("Cold Call")}>
          <span className="border-b-2 border-accent px-3 py-1.5 font-semibold text-accent">{t("Ações manuais")}</span>
          {podeGerenciar && (
            <button type="button" onClick={aoEditarRoteiro} className="px-3 py-1.5 text-text-muted hover:text-text" data-testid="editar-roteiro">
              {t("Roteiro")}
            </button>
          )}
          <Link href={`/app/pipelines/${funil.id}`} className="px-3 py-1.5 text-text-muted hover:text-text">
            {t("Funil")}
          </Link>
          <button type="button" onClick={aoAbrirGuia} className="px-3 py-1.5 text-text-muted hover:text-text" data-testid="abrir-guia">
            {t("Como configurar")}
          </button>
        </nav>
        <div className="ml-auto">
          {/* O QueryClient não refaz a consulta no foco, e o staleTime é de 30 s: sem isto a fila
              seguia "(0)" depois de importar, até recarregar a página. */}
          <ImportarLeads funis={[funil]} onImportado={() => void qc.invalidateQueries({ queryKey: CHAVE })} />
        </div>
      </header>

      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-text">{t("Ações manuais")}</h2>
          <p className="mt-0.5 text-sm text-text-muted">
            {t("Ligações para fazer, um contato por vez, com o roteiro e o resultado de cada uma.")}
          </p>
        </div>
        <Button onClick={comecar} disabled={!fila.some((l) => !l.nao_ligar)} data-testid="vamos-comecar">
          <Play size={16} className="mr-2" weight="fill" aria-hidden /> {t("Vamos começar")}
        </Button>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 p-3">
          <select
            value={etapa}
            onChange={(e) => {
              setEtapa(e.target.value);
              setPagina(0);
            }}
            aria-label={t("Etapa")}
            className={classeDoFiltro}
            data-testid="filtro-etapa"
          >
            <option value="fila">{t("Fila de ligações")} ({fila.length})</option>
            <option value="todos">{t("Todos")} ({leads.length})</option>
            {etapas.map(([slug, nome]) => (
              <option key={slug} value={slug}>
                {nome} ({leads.filter((l) => l.etapa === slug).length})
              </option>
            ))}
          </select>
          <div className="relative min-w-52 flex-1 sm:max-w-72">
            <MagnifyingGlass size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-text-muted" aria-hidden />
            <Input
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setPagina(0);
              }}
              placeholder={t("Buscar por nome ou telefone")}
              aria-label={t("Buscar por nome ou telefone")}
              className="h-10 pl-9"
            />
          </div>
          {podeGerenciar && (
            <select
              value={titular}
              onChange={(e) => {
                setTitular(e.target.value);
                setPagina(0);
              }}
              aria-label={t("Selecionar responsável")}
              className={classeDoFiltro}
            >
              <option value="">{t("Selecionar responsável")}</option>
              {[...nomes.entries()].map(([id, nome]) => (
                <option key={id} value={id}>
                  {nome}
                </option>
              ))}
            </select>
          )}
          {marcados.size > 0 && (
            <span className="ml-auto text-sm text-text-muted">
              {marcados.size} {t("selecionados")}
            </span>
          )}
        </div>

        {visiveis.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <Phone size={32} className="text-text-muted" weight="duotone" aria-hidden />
            <p className="font-semibold text-text">
              {leads.length === 0 ? t("Nenhum lead para ligar ainda") : t("Nada nesta lista")}
            </p>
            {leads.length === 0 && (
              <p className="max-w-md text-sm text-text-muted">
                {t("Importe uma planilha: os leads entram na etapa Na fila, prontos para a primeira ligação.")}
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-border/70 text-xs font-medium text-text-muted">
                <tr>
                  <th className="w-10 py-3 pl-4">
                    <input
                      type="checkbox"
                      checked={tudoMarcado}
                      aria-label={t("Selecionar todos")}
                      className="size-4 accent-[var(--color-accent)]"
                      onChange={() =>
                        setMarcados((atuais) => {
                          const novo = new Set(atuais);
                          for (const l of daPagina) {
                            if (tudoMarcado) novo.delete(l.id);
                            else novo.add(l.id);
                          }
                          return novo;
                        })
                      }
                    />
                  </th>
                  <th className="px-3 py-3 font-medium">{t("Contatos")}</th>
                  <th className="px-3 py-3 font-medium">{t("Campanha/fluxo")}</th>
                  <th className="px-3 py-3 font-medium">{t("Atribuído a")}</th>
                  <th className="px-3 py-3 font-medium">{t("Tipo")}</th>
                  <th className="px-3 py-3 font-medium">{t("Status")}</th>
                  <th className="px-3 py-3 font-medium">{t("Data da adição")}</th>
                  <th className="w-10 px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {daPagina.map((lead) => {
                  const naFila = ETAPAS_DA_FILA.includes(lead.etapa);
                  const dono = lead.responsavel_id ? nomes.get(lead.responsavel_id) : null;
                  return (
                    <tr key={lead.id} className="border-b border-border/40 last:border-0 hover:bg-surface-elevated/50" data-testid="linha-da-fila">
                      <td className="py-2.5 pl-4">
                        <input
                          type="checkbox"
                          checked={marcados.has(lead.id)}
                          aria-label={`${t("Selecionar")} ${lead.titulo}`}
                          className="size-4 accent-[var(--color-accent)]"
                          onChange={() =>
                            setMarcados((atuais) => {
                              const novo = new Set(atuais);
                              if (novo.has(lead.id)) novo.delete(lead.id);
                              else novo.add(lead.id);
                              return novo;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          disabled={!naFila}
                          className="flex items-center gap-2.5 text-left font-medium text-text enabled:hover:text-accent"
                          onClick={() => {
                            const resto = fila.filter((l) => l.id !== lead.id && !l.nao_ligar).map((l) => l.id);
                            aoComecar([lead.id, ...resto]);
                          }}
                        >
                          <FotoDoLead lead={lead} />
                          <span>
                            <span className="block">{lead.titulo}</span>
                            <span className="block text-xs font-normal tabular-nums text-text-muted">
                              {telefoneNaTela(lead, t)}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-text">
                        <span className="inline-flex items-center gap-1.5">
                          <Phone size={14} weight="fill" className="text-accent" aria-hidden /> {t("Cold Call")}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-text">
                        {dono ? (
                          <span className="inline-flex items-center gap-2">
                            <Iniciais nome={dono} tamanho="size-6" /> {dono}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-text">{t("Ligação")}</td>
                      <td className="px-3 py-2.5 text-text">
                        {lead.nao_ligar ? (
                          <span className="font-medium text-error" data-testid="nao-ligar">
                            {t("Não ligar")} · {t(ROTULO_DE_NAO_LIGAR[lead.nao_ligar])}
                          </span>
                        ) : lead.tentativas === 0 && lead.etapa === "na-fila" ? (
                          t("Não iniciada")
                        ) : (
                          t(lead.etapa_nome)
                        )}
                        {lead.tentativas > 0 && (
                          <span className="ml-1.5 text-xs tabular-nums text-text-muted">· {lead.tentativas}x</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-text-muted">{dataEHora(lead.criado_em, idioma)}</td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          title={t("Tirar da fila")}
                          aria-label={`${t("Tirar da fila")}: ${lead.titulo}`}
                          onClick={() => setRemovendo(lead)}
                          // 44 px de alvo no celular, como o Button size="icon"; compacto só a partir de lg.
                          className="flex size-11 items-center justify-center rounded-md text-text-muted hover:text-error lg:size-8"
                        >
                          <Trash size={17} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {visiveis.length > 0 && (
          <footer className="flex items-center justify-end gap-2 border-t border-border/60 p-3">
            <span className="mr-auto pl-1 text-xs tabular-nums text-text-muted">
              {t("Página")} {atual + 1} {t("de")} {paginas}
            </span>
            <Button variant="outline" size="sm" disabled={atual === 0} onClick={() => setPagina(atual - 1)}>
              <CaretLeft size={14} className="mr-1" aria-hidden /> {t("Anterior")}
            </Button>
            <Button variant="outline" size="sm" disabled={atual >= paginas - 1} onClick={() => setPagina(atual + 1)}>
              {t("Próxima")} <CaretRight size={14} className="ml-1" aria-hidden />
            </Button>
          </footer>
        )}
      </section>

      {removendo && (
        <Dialog open onOpenChange={(aberto) => !aberto && setRemovendo(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("Tirar da fila?")}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-text-muted">
              «{removendo.titulo}» {t("sai da fila e o lead é marcado como perdido no funil. Nada é apagado, e o histórico continua lá.")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRemovendo(null)}>
                {t("Cancelar")}
              </Button>
              <Button onClick={() => remover.mutate(removendo)} disabled={remover.isPending} data-testid="confirmar-remocao">
                {t("Tirar da fila")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function EditorDoRoteiro({ roteiro, aoFechar }: { roteiro: string; aoFechar: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [texto, setTexto] = useState(roteiro);
  const salvar = useMutation({
    mutationFn: () => apiClient.patch("/api/v1/cold-call", { roteiro: texto }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
      toast.success(t("Roteiro salvo."));
      aoFechar();
    },
    onError: showApiError,
  });
  return (
    <Dialog open onOpenChange={(aberto) => !aberto && aoFechar()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Roteiro de cold call")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-text-muted">
          {t("Use [nome da empresa] e [seu nome]: na ligação, eles viram o nome do lead e o seu.")}
        </p>
        <p className="text-sm text-text-muted">
          {t("Use # para títulos, [Marca] no começo da fala para a situação, e as lacunas [nome do negócio] e [seu nome].")}
        </p>
        <Textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={16}
          aria-label={t("Roteiro de cold call")}
          data-testid="texto-do-roteiro"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={aoFechar}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => salvar.mutate()} disabled={salvar.isPending || !texto.trim()} data-testid="salvar-roteiro">
            {t("Salvar")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Sanfona({ titulo, icone, aberta = false, children }: { titulo: string; icone?: ReactNode; aberta?: boolean; children: ReactNode }) {
  const [aberto, setAberto] = useState(aberta);
  return (
    <section>
      <button
        type="button"
        aria-expanded={aberto}
        onClick={() => setAberto(!aberto)}
        className="flex w-full items-center justify-between gap-2 rounded-lg py-1.5 text-sm font-semibold text-text transition-colors hover:text-accent"
      >
        <span className="flex items-center gap-1.5">
          {icone}
          {titulo}
        </span>
        <CaretDown size={15} className={cn("text-text-muted transition-transform duration-200", aberto && "rotate-180")} aria-hidden />
      </button>
      {aberto && <div className="pt-2 text-sm">{children}</div>}
    </section>
  );
}

function CampoDoContato({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div className="mb-2.5 last:mb-0">
      <p className="text-xs text-text-muted">{rotulo}</p>
      <p className="break-words text-text">{valor}</p>
    </div>
  );
}

/**
 * A temperatura sai do que já aconteceu nas ligações, e não de um palpite: pediu reunião
 * é quente, follow-up é morno, quem ainda não foi tentado é novo.
 */
function temperaturaDoLead(lead: Lead): { rotulo: string; destaque: boolean } {
  if (lead.etapa === "reuniao-pedida") return { rotulo: "Lead quente", destaque: true };
  if (lead.etapa === "follow-up") return { rotulo: "Lead morno", destaque: true };
  if (lead.tentativas > 0) return { rotulo: "Lead frio", destaque: false };
  return { rotulo: "Lead novo", destaque: false };
}

const CARTAO = "rounded-2xl border border-border/60 bg-surface";

/** Altura de cada barra da onda: fixa, para o desenho não mudar a cada render. */
const ONDAS = Array.from({ length: 41 }, (_, i) => {
  const centro = 1 - Math.abs(i - 20) / 21;
  return Math.round(12 + centro * 62 * (0.45 + 0.55 * Math.abs(Math.sin(i * 1.7))));
});

function OndasDeAudio({ ativa }: { ativa: boolean }) {
  return (
    <div className={cn("cc-ondas flex h-14 items-center justify-center gap-[3px]", ativa && "cc-ondas-ativa")} aria-hidden>
      {ONDAS.map((altura, i) => (
        <span
          key={i}
          className="cc-onda w-[2px] rounded-full bg-accent"
          style={{ height: `${altura}%`, animationDelay: `${(i % 9) * 90}ms`, opacity: ativa ? 0.95 : 0.3 }}
        />
      ))}
    </div>
  );
}

const ICONES_DOS_RESULTADOS: Record<string, typeof Phone> = {
  nao_atendeu: PhoneX,
  caixa_postal: Voicemail,
  follow_up: CalendarCheck,
  reuniao: CalendarPlus,
  sem_interesse: XCircle,
  numero_errado: Warning,
};

type AbaDoRoteiro = "roteiro" | "abertura" | "tarefas" | "historico";

function Sessao({
  roteiro,
  leads,
  ordemInicial,
  aoSair,
}: {
  roteiro: string;
  leads: Lead[];
  ordemInicial: string[];
  aoSair: () => void;
}) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const qc = useQueryClient();
  const usuario = useUser();
  const { data: voz } = useVoiceSessionStatus();
  // A ordem fica presa ao começar: quem acabou de ser tentado não volta para a frente no meio.
  const [ordem] = useState(ordemInicial);
  const [posicao, setPosicao] = useState(0);
  const [resultado, setResultado] = useState<ResultadoDaLigacao | null>(null);
  const [nota, setNota] = useState("");
  const [feitas, setFeitas] = useState(0);
  const [abaDoRoteiro, setAbaDoRoteiro] = useState<AbaDoRoteiro>("roteiro");
  // Em notebook não cabem quatro colunas: Resumo e Roteiro dividem o mesmo espaço, por abas.
  const [ladoDireito, setLadoDireito] = useState<"resumo" | "roteiro">("resumo");
  const [resumoAberto, setResumoAberto] = useState(true);
  const [removendo, setRemovendo] = useState(false);
  const lead = leads.find((l) => l.id === ordem[posicao]) ?? null;
  const organizacao = useActiveOrg();

  const ligacao = useLigacao(lead);

  const proximo = () => {
    ligacao.limpar();
    setResultado(null);
    setNota("");
    setAbaDoRoteiro("roteiro");
    setRemovendo(false);
    setPosicao((p) => p + 1);
  };

  const salvar = useMutation({
    mutationFn: (r: ResultadoDaLigacao) =>
      apiClient.post("/api/v1/cold-call/resultado", { lead_id: lead!.id, resultado: r, nota: nota.trim() || undefined }),
    onSuccess: (_d, r) => {
      if (r !== "removido") setFeitas((n) => n + 1);
      void qc.invalidateQueries({ queryKey: CHAVE });
      proximo();
    },
    onError: showApiError,
  });

  const seguir = () => {
    if (resultado && aceitaResultadoDaLigacao(lead?.nao_ligar)) salvar.mutate(resultado);
    else proximo();
  };

  const linhas = useMemo(
    () => (lead ? linhasDoRoteiro(roteiro, { negocio: lead.titulo, quemLiga: primeiroNome(usuario), suaEmpresa: organizacao?.name }) : []),
    [lead, roteiro, usuario, organizacao?.name],
  );
  const linhasDaAba = useMemo(() => {
    if (abaDoRoteiro !== "abertura") return linhas;
    const segundoTitulo = linhas.findIndex((l, i) => i > 0 && l.tipo === "titulo");
    return segundoTitulo > 0 ? linhas.slice(0, segundoTitulo) : linhas;
  }, [abaDoRoteiro, linhas]);

  const conversao = useMemo(() => {
    const tentados = leads.filter((l) => l.tentativas > 0).length;
    const reunioes = leads.filter((l) => l.etapa === "reuniao-pedida").length;
    return tentados > 0 ? Math.round((reunioes / tentados) * 100) : 0;
  }, [leads]);

  if (!lead) {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="sessao-concluida">
        <h1>{t("Cold Call")}</h1>
        <section className={cn(CARTAO, "flex w-full max-w-xl flex-col items-start gap-3 p-6")}>
          <h2 className="text-xl font-bold tracking-tight text-text">{t("Fila concluída")}</h2>
          <p className="text-sm text-text-muted">
            {feitas} {t("ligações registradas nesta sessão.")}
          </p>
          <Button onClick={aoSair}>{t("Voltar para a fila")}</Button>
        </section>
      </div>
    );
  }

  const naLinha = ligacao.fase === "discando" || ligacao.fase === "na-linha";
  const temperatura = temperaturaDoLead(lead);
  const tempo = `${String(Math.floor(ligacao.segundos / 60)).padStart(2, "0")}:${String(ligacao.segundos % 60).padStart(2, "0")}`;
  const vozPronta = !!voz?.configured && !!voz.paired;

  const trocaDeLado = (
    <div className="hidden shrink-0 rounded-lg bg-surface-elevated/60 p-0.5 lg:flex 2xl:hidden" role="tablist" aria-label={t("Painel")}>
      {(
        [
          ["resumo", t("Resumo")],
          ["roteiro", t("Roteiro")],
        ] as const
      ).map(([id, rotulo]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={ladoDireito === id}
          onClick={() => setLadoDireito(id)}
          data-testid={`lado-${id}`}
          className={cn(
            "flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            ladoDireito === id ? "bg-accent text-accent-foreground" : "text-text-muted hover:text-text",
          )}
        >
          {rotulo}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-col gap-3 lg:h-[calc(100dvh-var(--faixas-de-cima,0px)-7rem)]" data-testid="sessao-de-ligacao">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex size-11 items-center justify-center rounded-xl border border-accent/30 bg-accent-soft text-accent">
          <Phone size={22} weight="fill" aria-hidden />
        </span>
        <h1 className="!text-2xl">{t("Cold Call")}</h1>
        <span className="border-b-2 border-accent px-1 pb-1 text-sm font-semibold text-accent">{t("Ligando")}</span>
        <span className="pb-1 text-sm tabular-nums text-text-muted">
          {t("Lead")} {posicao + 1} {t("de")} {ordem.length}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="flex h-10 items-center gap-2 rounded-xl border border-border/70 bg-surface px-3 text-sm text-text" data-testid="status-no-topo">
            <Waveform size={18} className={naLinha ? "text-accent" : "text-text-muted"} aria-hidden />
            <span className={cn("size-2 rounded-full", vozPronta ? "bg-accent" : "bg-text-muted")} aria-hidden />
            {ligacao.fase === "pronta" ? (vozPronta ? t("Online") : t("Discador do aparelho")) : t(ligacao.rotulo)}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="transition-transform active:scale-95"
            onClick={aoSair}
            title={t("Pausar")}
            aria-label={t("Pausar")}
            data-testid="pausar-sessao"
          >
            <Pause size={16} weight="fill" aria-hidden />
          </Button>
          <Button onClick={seguir} disabled={salvar.isPending} className="transition-transform active:scale-[.98]" data-testid="seguir-no-topo">
            {t("Seguinte")} <ArrowRight size={16} className="ml-2" aria-hidden />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(230px,250px)_minmax(0,1fr)_minmax(280px,24vw)] 2xl:grid-cols-[minmax(250px,280px)_minmax(0,1fr)_minmax(280px,300px)_minmax(320px,22vw)]">
        {/* Coluna 1: o contato */}
        <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto [scrollbar-width:thin]">
          <section className={cn(CARTAO, "p-4")}>
            <button type="button" onClick={aoSair} className="mb-3 flex items-center gap-2 text-sm font-semibold text-text transition-colors hover:text-accent">
              <Users size={16} aria-hidden /> {t("Contato Informações")}
            </button>
            <div className="flex items-center gap-3">
              <span className="relative">
                <FotoDoLead lead={lead} tamanho="size-14" />
                <span className="absolute right-0 bottom-0 size-3 rounded-full border-2 border-surface bg-accent" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="truncate font-bold text-text" title={lead.titulo}>
                  {lead.titulo}
                </p>
                <p className="text-sm tabular-nums text-text-muted">{telefoneNaTela(lead, t)}</p>
              </div>
            </div>
            <span
              className={cn(
                "mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                temperatura.destaque ? "border-accent/40 text-accent" : "border-border text-text-muted",
              )}
              data-testid="temperatura-do-lead"
            >
              <Fire size={13} weight="fill" aria-hidden /> {t(temperatura.rotulo)}
            </span>
            {lead.tags.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {lead.tags.map((tag) => (
                  <li key={tag} className="rounded-md border border-border/70 px-2 py-0.5 text-xs text-text-muted">
                    {tag}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-col gap-1 border-t border-border/50 pt-2">
              <Sanfona titulo={t("Contato")}>
                <CampoDoContato rotulo={t("Nome")} valor={lead.contato_nome ?? lead.titulo} />
                <CampoDoContato rotulo={t("E-mail")} valor={lead.email} />
                <CampoDoContato rotulo={t("Endereço")} valor={lead.endereco} />
                {lead.descricao && (
                  <p className="mb-2 whitespace-pre-wrap break-words leading-relaxed text-text-muted">{lead.descricao}</p>
                )}
                {lead.contato_id && (
                  <Link href={`/app/contacts/${lead.contato_id}`} className="text-accent hover:underline">
                    {t("Ver contato")}
                  </Link>
                )}
              </Sanfona>
            </div>

            <div className="mt-2 rounded-xl border border-border/60 bg-surface-elevated/30 px-3 py-2.5">
              <p className="flex items-center justify-between gap-2 text-sm font-medium text-text">
                <span className="flex items-center gap-1.5">
                  <Phone size={15} weight="fill" aria-hidden /> {t("Cold Calls")}
                </span>
                <span className="flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold tabular-nums text-accent-foreground">
                  {lead.tentativas}
                </span>
              </p>
            </div>
            <SeletorDoResultado valor={resultado} aoMudar={setResultado} naoLigar={lead.nao_ligar} />
            <p className="mt-2 text-xs tabular-nums text-text-muted">
              {t("Tentativas")}: {lead.tentativas}
            </p>
          </section>

          <section className={cn(CARTAO, "grid grid-cols-3 divide-x divide-border/50 py-3 text-center")} data-testid="metricas-da-ligacao">
            <div className="px-1">
              <Phone size={18} className="mx-auto text-accent" aria-hidden />
              <p className="mt-1 text-lg font-bold tabular-nums text-text">{lead.tentativas}</p>
              <p className="text-[11px] text-text-muted">{t("Tentativas")}</p>
            </div>
            <div className="px-1">
              <Clock size={18} className="mx-auto text-accent" aria-hidden />
              <p className="mt-1 text-lg font-bold tabular-nums text-text">{tempo}</p>
              <p className="text-[11px] text-text-muted">{t("Duração")}</p>
            </div>
            <div className="px-1" title={t("Leads da fila que pediram reunião, entre os já tentados")}>
              <Check size={18} className="mx-auto text-accent" aria-hidden />
              <p className="mt-1 text-lg font-bold tabular-nums text-text">{conversao}%</p>
              <p className="text-[11px] text-text-muted">{t("Conversão")}</p>
            </div>
          </section>

          <section
            className={cn(
              "shrink-0 rounded-2xl border p-4 text-center transition-colors duration-300",
              naLinha ? "border-accent/40 bg-accent-soft" : "border-border/60 bg-surface",
            )}
            data-testid="cartao-da-ligacao"
          >
            <Waveform size={22} className={cn("mx-auto", naLinha ? "text-accent" : "text-text-muted")} aria-hidden />
            <p className="mt-1 text-sm font-semibold text-text">{naLinha ? t("Ligação em andamento") : t(ligacao.rotulo)}</p>
            <p className="text-xs text-text-muted">
              {naLinha ? t("Mantenha o foco e siga o roteiro.") : t("Quando ligar, o andamento aparece aqui.")}
            </p>
            <OndasDeAudio ativa={naLinha} />
          </section>
        </aside>

        {/* Coluna 2: a conversa */}
        <section className={cn(CARTAO, "flex min-h-[480px] min-w-0 flex-col overflow-hidden lg:min-h-0")} data-testid="conversa-do-lead">
          <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
            <span className="relative">
              <FotoDoLead lead={lead} tamanho="size-10" />
              <span className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full border-2 border-surface bg-accent text-accent-foreground" aria-hidden>
                <WhatsappLogo size={9} weight="fill" />
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-bold text-text" title={lead.titulo}>
                {lead.titulo}
              </h2>
              <p className="flex items-center gap-1 text-xs tabular-nums text-text-muted">
                <Phone size={12} aria-hidden /> {telefoneNaTela(lead, t)}
              </p>
            </div>
          </header>

          {lead.historico.length > 0 && (
            <ul className="flex shrink-0 flex-wrap justify-end gap-1.5 border-b border-border/50 px-4 py-2" data-testid="historico-de-ligacoes">
              {lead.historico.slice(-3).map((h) => (
                <li key={h.em} className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1 text-xs text-text">
                  <Phone size={12} weight="fill" className="text-accent" aria-hidden />
                  {h.resultado && RESULTADOS[h.resultado] ? t(RESULTADOS[h.resultado].rotulo) : t("Ligação")}
                  <span className="tabular-nums text-text-muted">{hora(h.em, idioma)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {lead.conversa_id ? (
              <ChatThread conversationId={lead.conversa_id} contatoId={lead.contato_id} dono={{ userId: null, nome: null }} soNaCaixa />
            ) : (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 p-6 text-center">
                <WhatsappLogo size={30} className="text-text-muted" aria-hidden />
                <p className="text-sm font-medium text-text">{t("Ainda não há conversa com este contato")}</p>
                <p className="max-w-xs text-xs text-text-muted">
                  {t("Quando houver mensagem no WhatsApp, ela aparece aqui, junto com as ligações.")}
                </p>
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-border/60 p-2">
            {lead.conversa_id ? (
              <Composer
                key={lead.conversa_id}
                conversationId={lead.conversa_id}
                contactName={lead.contato_nome}
                contactDisplayName={lead.contato_nome}
                currentContactId={lead.contato_id}
                usuarioId={usuario.id}
              />
            ) : (
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface-elevated/40 px-4 py-3 text-sm text-text-muted">
                {t("Digite uma mensagem...")}
                <span className="ml-auto text-xs">{t("Inicie a conversa pelo Inbox")}</span>
              </div>
            )}
          </div>
        </section>

        {/* Coluna 3: o resumo da chamada */}
        <section
          className={cn(CARTAO, "min-h-0 flex-col gap-3 p-4 max-lg:order-first lg:overflow-y-auto [scrollbar-width:thin]", ladoDireito === "resumo" ? "flex" : "flex lg:hidden 2xl:flex")}
          data-testid="painel-de-chamada"
        >
          {trocaDeLado}
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex min-w-0 items-center gap-2 font-bold text-text">
              <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <PhoneOutgoing size={17} weight="fill" aria-hidden />
              </span>
              {t("Resumo da Chamada")}
            </h2>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setResumoAberto(!resumoAberto)}
                aria-label={resumoAberto ? t("Recolher resumo") : t("Abrir resumo")}
                title={resumoAberto ? t("Recolher resumo") : t("Abrir resumo")}
                className="rounded-md p-1 text-text-muted transition-colors hover:text-text"
              >
                <CaretDown size={15} className={cn("transition-transform duration-200", resumoAberto && "rotate-180")} aria-hidden />
              </button>
            </div>
          </div>

          {resumoAberto && (
            <div className="rounded-xl border border-border/60 bg-surface-elevated/30 p-3">
              <div className="flex gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <ChartBar size={22} weight="fill" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-snug text-text">{lead.titulo}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs tabular-nums text-text-muted">
                    <Phone size={12} aria-hidden /> {telefoneNaTela(lead, t)}
                  </p>
                </div>
              </div>
              <p className="mt-3 flex flex-wrap items-center justify-center gap-2" data-testid="status-da-chamada">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium",
                    ligacao.fase === "encerrada" ? "border-border text-text-muted" : "border-accent/40 text-accent",
                  )}
                >
                  <span className={cn("size-2 rounded-full", ligacao.fase === "encerrada" ? "bg-text-muted" : "bg-accent", naLinha && "animate-pulse")} aria-hidden />
                  {t(ligacao.rotulo)}
                </span>
                {ligacao.fase !== "pronta" && <span className="text-sm font-bold tabular-nums text-text">{tempo}</span>}
                {ligacao.motivo && <span className="text-xs text-text-muted">{ligacao.motivo}</span>}
              </p>
              {!ligacao.viaCrm && !lead.nao_ligar && ligacao.fase === "pronta" && (
                <p className="mt-2 text-center text-[11px] leading-relaxed text-text-muted" data-testid="aviso-sem-telefonia">
                  {t("A ligação pelo CRM ainda não está ligada. Por enquanto, o botão abre o discador do seu aparelho.")}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                {naLinha ? (
                  <Button variant="outline" className="flex-1 border-error/50 text-error transition-transform active:scale-[.98]" onClick={ligacao.desligar} data-testid="desligar">
                    <PhoneX size={16} className="mr-2" aria-hidden /> {t("Desligar")}
                  </Button>
                ) : lead.nao_ligar ? (
                  // Mesma recusa da rota de voz, mostrada antes do clique: o botão existe, e diz por que não liga.
                  <div className="flex flex-1 flex-col items-center gap-1">
                    <Button className="w-full" disabled data-testid="ligar">
                      <Phone size={16} className="mr-2" weight="fill" aria-hidden />
                      {t("Não ligar")}
                    </Button>
                    <span className="text-center text-xs text-text-muted" data-testid="motivo-nao-ligar">
                      {t(ROTULO_DE_NAO_LIGAR[lead.nao_ligar])}
                    </span>
                  </div>
                ) : lead.telefone ? (
                  <Button className="flex-1 transition-transform active:scale-[.98]" onClick={() => void ligacao.ligar()} data-testid="ligar">
                    <Phone size={16} className="mr-2" weight="fill" aria-hidden />
                    {ligacao.fase === "encerrada" ? t("Rediscar") : t("Ligar")}
                  </Button>
                ) : (
                  <span className="flex-1 text-center text-xs text-text-muted">{t("Este lead não tem telefone.")}</span>
                )}
                {lead.telefone && !lead.nao_ligar && (
                  <Button
                    variant="outline"
                    size="icon"
                    title={t("Copiar número")}
                    aria-label={t("Copiar número")}
                    onClick={() => {
                      void copyToClipboard(lead.telefone!).then((copiou) =>
                        copiou ? toast.success(t("Número copiado.")) : toast.error(t("Não consegui copiar o número.")),
                      );
                    }}
                  >
                    <Copy size={16} aria-hidden />
                  </Button>
                )}
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text">{t("Ações Rápidas")}</h3>
            <div className="grid grid-cols-2 gap-2">
              {RESULTADOS_DA_LIGACAO.map((id) => {
                const Icone = ICONES_DOS_RESULTADOS[id] ?? Phone;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={resultado === id}
                    disabled={!aceitaResultadoDaLigacao(lead.nao_ligar)}
                    onClick={() => setResultado(resultado === id ? null : id)}
                    data-testid={`resultado-${id}`}
                    className={cn(
                      "flex min-h-11 items-center gap-1.5 rounded-xl border px-2 py-1.5 text-left text-xs font-medium transition-all duration-150 active:scale-[.97] disabled:pointer-events-none disabled:opacity-50",
                      resultado === id
                        ? "border-transparent bg-accent text-accent-foreground"
                        : "border-border/70 bg-surface-elevated/30 text-text hover:border-accent/50 hover:bg-surface-elevated/60",
                    )}
                  >
                    <Icone size={17} className="shrink-0" aria-hidden />
                    {t(RESULTADOS[id].rotulo)}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm text-text" htmlFor="anotacao-da-ligacao">
              {t("Anotação da ligação (opcional)")}
            </label>
            <Textarea
              id="anotacao-da-ligacao"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              rows={3}
              placeholder={t("Adicione uma observação...")}
              className="min-h-20"
            />
          </div>

          <div className="mt-auto flex items-center gap-2">
            <Button
              className="flex-1 transition-transform active:scale-[.98]"
              onClick={() => resultado && salvar.mutate(resultado)}
              disabled={!resultado || salvar.isPending || !aceitaResultadoDaLigacao(lead.nao_ligar)}
              data-testid="salvar-e-seguir"
            >
              <Check size={16} className="mr-2" aria-hidden /> {t("Salvar")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              title={t("Tirar da fila")}
              aria-label={t("Tirar da fila")}
              onClick={() => setRemovendo(true)}
              data-testid="tirar-da-fila"
            >
              <Trash size={16} aria-hidden />
            </Button>
          </div>
          {resultado === "reuniao" && (
            <Link href="/app/agenda" target="_blank" className="text-center text-sm text-accent hover:underline">
              {t("Abrir a agenda para marcar a reunião")}
            </Link>
          )}
        </section>

        {/* Coluna 4: o roteiro */}
        <aside
          className={cn(CARTAO, "min-h-[320px] min-w-0 flex-col overflow-hidden lg:min-h-0 lg:col-start-3 2xl:col-start-auto", ladoDireito === "roteiro" ? "flex" : "flex lg:hidden 2xl:flex", ladoDireito === "roteiro" && "lg:row-start-1")}
          data-testid="coluna-do-roteiro"
        >
          <div className="shrink-0 px-3 pt-3 empty:hidden lg:block 2xl:hidden max-lg:hidden">{trocaDeLado}</div>
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 pt-2">
            {(
              [
                ["roteiro", t("Roteiro")],
                ["abertura", t("Abertura")],
              ] as const
            ).map(([id, rotulo]) => (
              <button
                key={id}
                type="button"
                onClick={() => setAbaDoRoteiro(id)}
                aria-pressed={abaDoRoteiro === id}
                data-testid={`aba-${id}`}
                className={cn(
                  "border-b-2 px-2 py-2 text-sm font-medium transition-colors",
                  abaDoRoteiro === id ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text",
                )}
              >
                {rotulo}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-0.5 pb-1">
              {(
                [
                  ["tarefas", ListChecks, t("Tarefas")],
                  ["historico", ClockCounterClockwise, t("Ligações")],
                ] as const
              ).map(([id, Icone, rotulo]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={abaDoRoteiro === id}
                  aria-label={rotulo}
                  title={rotulo}
                  onClick={() => setAbaDoRoteiro(id)}
                  data-testid={`aba-${id}`}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors",
                    abaDoRoteiro === id ? "bg-accent-soft text-accent" : "text-text-muted hover:text-text",
                  )}
                >
                  <Icone size={16} aria-hidden />
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-width:thin]">
            {(abaDoRoteiro === "roteiro" || abaDoRoteiro === "abertura") && (
              <div className="flex flex-col gap-4" data-testid="roteiro">
                {linhasDaAba.map((linha, i) =>
                  linha.tipo === "titulo" ? (
                    <h3 key={i} className="mt-3 flex items-center gap-2 text-lg font-bold text-text first:mt-0">
                      {i === 0 && <span className="size-2 rounded-full bg-accent" aria-hidden />}
                      {linha.texto}
                    </h3>
                  ) : (
                    <p key={i} className="text-base leading-relaxed text-text sm:text-[17px]">
                      {linha.marca && <span className="mr-1 font-semibold text-accent">[{linha.marca}]</span>}
                      {linha.texto}
                    </p>
                  ),
                )}
              </div>
            )}
            {abaDoRoteiro === "tarefas" && <TarefasDoContato contatoId={lead.contato_id} />}
            {abaDoRoteiro === "historico" && (
              <div>
                <h2 className="mb-3 font-bold text-text">{t("Ligações")}</h2>
                {lead.historico.length === 0 ? (
                  <p className="text-sm text-text-muted">{t("Nenhuma ligação registrada ainda.")}</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {[...lead.historico].reverse().map((h) => (
                      <li key={h.em} className="rounded-lg border border-border/60 px-3 py-2">
                        <p className="font-medium text-text">
                          {h.resultado && RESULTADOS[h.resultado] ? t(RESULTADOS[h.resultado].rotulo) : t("Ligação")}
                        </p>
                        <p className="text-xs tabular-nums text-text-muted">{dataEHora(h.em, idioma)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {removendo && (
        <Dialog open onOpenChange={(aberto) => !aberto && setRemovendo(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("Tirar da fila?")}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-text-muted">
              «{lead.titulo}» {t("sai da fila e o lead é marcado como perdido no funil. Nada é apagado, e o histórico continua lá.")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRemovendo(false)}>
                {t("Cancelar")}
              </Button>
              <Button onClick={() => salvar.mutate("removido")} disabled={salvar.isPending} data-testid="confirmar-remocao">
                {t("Tirar da fila")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function TarefasDoContato({ contatoId }: { contatoId: string | null }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const consulta = useQuery({
    enabled: !!contatoId,
    queryKey: ["cold-call", "tarefas", contatoId],
    queryFn: async () =>
      (
        await apiClient.get<{ data: { id: string; title: string; due_date: string | null; status: string }[] }>(
          `/api/v1/tasks?contact_id=${contatoId}`,
        )
      ).data,
  });
  const tarefas = consulta.data ?? [];
  return (
    <div data-testid="tarefas-do-contato">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-bold text-text">{t("Tarefas")}</h2>
        <Link href="/app/tasks" className="text-sm text-accent hover:underline">
          + {t("Adicionar")}
        </Link>
      </div>
      {tarefas.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-8 text-center">
          <ListChecks size={26} className="text-text-muted" aria-hidden />
          <p className="text-sm font-medium text-text">{t("Ainda não há tarefas")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {tarefas.map((tarefa) => (
            <li key={tarefa.id} className="rounded-lg border border-border/60 px-3 py-2 text-text">
              {tarefa.title}
              {tarefa.due_date && <p className="text-xs text-text-muted">{dataEHora(tarefa.due_date, idioma)}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Fase = "pronta" | "discando" | "na-linha" | "encerrada";

interface Ligacao {
  fase: Fase;
  rotulo: string;
  segundos: number;
  viaCrm: boolean;
  motivo: string | null;
  ligar: () => Promise<void>;
  desligar: () => void;
  limpar: () => void;
}

/**
 * Uma ligação só: pelo canal de voz do CRM quando ele está pareado, senão pelo discador
 * do aparelho. No discador o CRM não sabe se alguém atendeu, e por isso não finge saber:
 * o rótulo diz que o discador foi aberto, e quem encerra é a pessoa.
 */
function useLigacao(lead: Lead | null): Ligacao {
  const { data: voz, refetch: conferirVoz } = useVoiceSessionStatus();
  const t = useT();
  const { call, startCall, hangUp, ultimoFim } = useVoiceCall();
  const viaCrm = caminhoDaLigacao(voz, lead?.contato_id, lead?.nao_ligar) === "crm";
  const [local, setLocal] = useState<{ inicio: number; fim: number | null } | null>(null);
  const [agora, setAgora] = useState(() => Date.now());

  const daLigacao = call && lead?.contato_id && call.contact_id === lead.contato_id ? call : null;
  const statusVoz = daLigacao?.status;
  const encerradaVoz = statusVoz === "ended";

  let fase: Fase = "pronta";
  let rotulo = "Pronto para ligar";
  let inicioDoRelogio: number | null = null;
  let fimDoRelogio: number | null = null;
  if (daLigacao) {
    if (encerradaVoz) {
      fase = "encerrada";
      rotulo = "Ligação encerrada";
    } else if (daLigacao.answered_at) {
      fase = "na-linha";
      rotulo = "Em ligação";
      inicioDoRelogio = Date.parse(daLigacao.answered_at);
    } else {
      fase = "discando";
      rotulo = "Discando...";
    }
  } else if (local) {
    inicioDoRelogio = local.inicio;
    fimDoRelogio = local.fim;
    fase = local.fim ? "encerrada" : "na-linha";
    rotulo = local.fim ? "Ligação encerrada" : "Discador aberto";
  }

  useEffect(() => {
    if (inicioDoRelogio === null || fimDoRelogio !== null) return;
    const tique = window.setInterval(() => setAgora(Date.now()), 1000);
    return () => window.clearInterval(tique);
  }, [inicioDoRelogio, fimDoRelogio]);

  // Só na ligação pelo CRM: no discador do aparelho, quem faz o som é o próprio celular.
  const faseDoSom = daLigacao ? fase : null;
  const faseAnterior = useRef<Fase | null>(null);
  useEffect(() => {
    const antes = faseAnterior.current;
    faseAnterior.current = faseDoSom;
    if (faseDoSom === "discando") return tocarDiscando();
    if (faseDoSom === "na-linha" && antes === "discando") tocarAtendeu();
  }, [faseDoSom]);

  // O desfecho chega separado da fase: a linha da chamada some assim que ela termina.
  const contatoDoLead = lead?.contato_id;
  useEffect(() => {
    if (!ultimoFim || ultimoFim.contact_id !== contatoDoLead) return;
    const desfecho = comoTerminou(ultimoFim);
    if (desfecho === "recusada") {
      tocarRecusada();
      toast.error(t("O lead recusou a chamada."));
    } else {
      tocarEncerrou();
      if (desfecho === "sem_resposta") toast(t("O telefone tocou e ninguém atendeu."));
    }
    // Um fim, um som: trocar de lead ou de idioma depois não pode tocar de novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimoFim]);

  const segundos = inicioDoRelogio === null ? 0 : Math.max(0, Math.floor(((fimDoRelogio ?? agora) - inicioDoRelogio) / 1000));

  const ligar = useCallback(async () => {
    if (!lead?.telefone || lead.nao_ligar) return;
    liberarSons();
    // O que está na tela pode estar velho: o chip pode ter sido conectado há pouco, ou o status
    // ainda não ter voltado. Antes de cair no discador, pergunta de novo.
    let caminho = caminhoDaLigacao(voz, lead.contato_id, lead.nao_ligar);
    if (caminho !== "crm") {
      const { data: conferida } = await conferirVoz();
      caminho = caminhoDaLigacao(conferida, lead.contato_id, lead.nao_ligar);
    }
    if (caminho === "indefinido") {
      toast.error(t("Não consegui confirmar o canal de voz. Tente ligar de novo."));
      return;
    }
    if (caminho === "crm" && lead.contato_id) {
      void Promise.resolve(startCall(lead.contato_id)).catch(showApiError);
      return;
    }
    // O discador `tel:` não passa pela rota de voz: a recusa dela precisa valer aqui também.
    if (caminho !== "discador") return;
    setAgora(Date.now());
    setLocal({ inicio: Date.now(), fim: null });
    const discador = document.createElement("a");
    discador.href = `tel:${lead.telefone}`;
    discador.click();
    // `t` e `conferirVoz` não decidem nada novo: o que muda a ligação são o lead e o status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, startCall, voz]);

  const desligar = useCallback(() => {
    if (daLigacao) {
      void Promise.resolve(hangUp()).catch(showApiError);
      return;
    }
    setLocal((atual) => (atual ? { ...atual, fim: Date.now() } : atual));
  }, [daLigacao, hangUp]);

  const limpar = useCallback(() => setLocal(null), []);

  return { fase, rotulo, segundos, viaCrm, motivo: daLigacao?.end_reason ?? null, ligar, desligar, limpar };
}

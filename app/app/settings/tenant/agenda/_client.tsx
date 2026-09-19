"use client";
import { AgendasConectadas } from "@/components/agenda/AgendasConectadas";
import { PrazosDePresenca } from "@/components/agenda/PrazosDePresenca";
import { AgendaDosColegas } from "@/components/agenda/AgendaDosColegas";
import { ClientePelaAgenda } from "@/components/agenda/ClientePelaAgenda";
import { DiasBloqueados } from "@/components/agenda/DiasBloqueados";

import { useT } from "@/hooks/i18n/useT";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { LOCAIS_DE_ATENDIMENTO } from "@/lib/agenda/locais";
import {
  TETO_DE_LEMBRETES_EXTRAS,
  deMinutos,
  desempacotarLembretes,
  empacotarLembretes,
  lerPassosDoFormulario,
  minutosLivres,
  paraMinutos,
  type UnidadeDeAntecedencia,
} from "@/lib/agenda/lembretes";
import { apiClient } from "@/lib/api/client";

export interface TipoRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  duration_minutes: number;
  location_kind: string;
  location_details: string | null;
  default_owner_user_id: string | null;
  requires_confirmation: boolean;
  is_active: boolean;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  reminder_extra_offsets_minutes: number[] | null;
  reminder_body: string | null;
  reminder_bodies: Record<string, string> | null;
}

/**
 * As dez do CHECK da tabela, com o nome que o dono do negócio usa.
 *
 * ⚠️ O VALOR é o do banco e o RÓTULO é da tela — e os dois não se misturam. A
 * tabela guarda `reuniao` sem acento porque é chave; quem lê vê "Reunião". Se o
 * rótulo virasse valor, o CHECK recusaria e a recusa apareceria como erro
 * interno para quem está usando.
 */
const CATEGORIAS: Array<{ valor: string; rotulo: string }> = [
  { valor: "consulta", rotulo: "Consulta" },
  { valor: "procedimento", rotulo: "Procedimento" },
  { valor: "retorno", rotulo: "Retorno" },
  { valor: "visita", rotulo: "Visita" },
  { valor: "vistoria", rotulo: "Vistoria" },
  { valor: "reuniao", rotulo: "Reunião" },
  { valor: "call", rotulo: "Call" },
  { valor: "orcamento", rotulo: "Orçamento" },
  { valor: "demonstracao", rotulo: "Demonstração" },
  { valor: "outro", rotulo: "Outro" },
];

// Fonte única: a tela que MARCA precisa do mesmo vocabulário, e copiá-lo para lá
// faria uma das duas mostrar o código cru no dia em que um valor entrasse no
// CHECK do banco. Ver o cabeçalho de `lib/agenda/locais.ts`.
const LOCAIS = LOCAIS_DE_ATENDIMENTO;

const rotuloDe = (lista: ReadonlyArray<{ valor: string; rotulo: string }>, valor: string) =>
  lista.find((c) => c.valor === valor)?.rotulo ?? valor;

interface Rascunho {
  name: string;
  category: string;
  duration_minutes: number;
  location_kind: string;
  default_owner_user_id: string;
}

const VAZIO: Rascunho = {
  name: "",
  category: "consulta",
  duration_minutes: 30,
  location_kind: "in_person",
  default_owner_user_id: "",
};

/**
 * O LEMBRETE DO COMPROMISSO — a lista que faltava.
 *
 * O cron `agenda-reminder` lê `reminder_enabled` e os degraus desde o
 * `99c33257`, e a tela só deixava UM texto compartilhado e no máximo um extra
 * (mais dois escondidos numa caixa de vírgulas). Cada aviso agora é um cartão:
 * antecedência + mensagem. Quantos o operador quiser (teto de segurança no
 * CHECK, não na operação).
 *
 * ⚠️ **CAMPO DESABILITADO NÃO ENTRA NO `FormData`, e isso é o desenho.** Com o
 * aviso desligado o `PATCH` manda `reminder_enabled: false` e OMITE os degraus:
 * a lista guardada fica intacta para quando alguém religar, em vez de ser
 * sobrescrita por um valor que a tela não deixou ninguém escolher.
 */
type CartaoDeLembrete = {
  id: string;
  quantidade: number;
  unidade: UnidadeDeAntecedencia;
  body: string;
};

function LembreteDoCompromisso({ tipo }: { tipo: TipoRow }) {
  const t = useT();
  const [ligado, setLigado] = React.useState(tipo.reminder_enabled);
  const [cartoes, setCartoes] = React.useState<CartaoDeLembrete[]>(() =>
    desempacotarLembretes({
      reminder_minutes_before: tipo.reminder_minutes_before,
      reminder_extra_offsets_minutes: tipo.reminder_extra_offsets_minutes,
      reminder_body: tipo.reminder_body,
      reminder_bodies: tipo.reminder_bodies,
    }).map((p, i) => {
      const u = deMinutos(p.minutes);
      return {
        id: `r${i + 1}`,
        quantidade: u.quantidade,
        unidade: u.unidade,
        body: p.body,
      };
    }),
  );
  // Semente = quantos cartões já nasceram. Passar o valor inicial não lê
  // `.current` no render — é o que o lint recusa em `++seq.current` no
  // inicializador do `useState`.
  const seq = React.useRef(cartoes.length);

  function minutosDe(c: CartaoDeLembrete) {
    return paraMinutos(c.quantidade, c.unidade);
  }

  function atualizar(id: string, patch: Partial<CartaoDeLembrete>) {
    setCartoes((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function mudarUnidade(id: string, unidade: UnidadeDeAntecedencia) {
    setCartoes((cs) =>
      cs.map((c) => {
        if (c.id !== id) return c;
        const minutos = minutosDe(c);
        const quantidade =
          unidade === "dias"
            ? Math.max(1, Math.round(minutos / 1440))
            : unidade === "horas"
              ? Math.max(1, Math.round(minutos / 60))
              : minutos;
        return { ...c, unidade, quantidade };
      }),
    );
  }

  const teto = 1 + TETO_DE_LEMBRETES_EXTRAS;
  const passos = cartoes.map((c) => ({ minutes: minutosDe(c), body: c.body }));

  return (
    <div className="grid gap-3 border-t border-border pt-3">
      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input
          type="checkbox"
          name="reminder_enabled"
          checked={ligado}
          data-testid={`editar-lembrete-${tipo.id}`}
          onChange={(e) => setLigado(e.target.checked)}
          className="size-4 shrink-0 rounded-sm border-border accent-accent"
        />
        {t("Avisar o cliente antes do compromisso, pelo WhatsApp")}
      </label>
      <input
        type="hidden"
        name="reminder_steps"
        value={JSON.stringify(passos)}
        disabled={!ligado}
      />
      <ul className="grid gap-3">
        {cartoes.map((c, i) => {
          const min =
            c.unidade === "dias" ? 1 : c.unidade === "horas" ? 1 : 15;
          const max =
            c.unidade === "dias" ? 7 : c.unidade === "horas" ? 168 : 10080;
          return (
            <li
              key={c.id}
              className="grid gap-2 rounded-md border border-border bg-surface-elevated p-3"
            >
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-22 flex-col gap-1 text-xs text-text-muted">
                  {t("Quanto antes")}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    disabled={!ligado}
                    value={c.quantidade}
                    onChange={(e) =>
                      atualizar(c.id, { quantidade: Number(e.target.value) })
                    }
                    data-testid={
                      i === 0
                        ? `editar-lembrete-minutos-${tipo.id}`
                        : `editar-lembrete-minutos-${tipo.id}-${i}`
                    }
                    className="rounded-md border border-border bg-surface p-2 text-sm text-text disabled:opacity-50"
                  />
                </label>
                <label className="flex min-w-28 flex-col gap-1 text-xs text-text-muted">
                  <span className="sr-only">{t("Unidade")}</span>
                  <select
                    disabled={!ligado}
                    value={c.unidade}
                    onChange={(e) =>
                      mudarUnidade(c.id, e.target.value as UnidadeDeAntecedencia)
                    }
                    data-testid={
                      i === 0
                        ? `editar-lembrete-unidade-${tipo.id}`
                        : `editar-lembrete-unidade-${tipo.id}-${i}`
                    }
                    className="rounded-md border border-border bg-surface p-2 text-sm text-text disabled:opacity-50"
                  >
                    <option value="minutos">{t("minutos")}</option>
                    <option value="horas">{t("horas")}</option>
                    <option value="dias">{t("dias")}</option>
                  </select>
                </label>
                <span className="pb-2 text-xs text-text-muted">{t("antes")}</span>
                {ligado && cartoes.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    data-testid={`editar-lembrete-remover-${tipo.id}-${i}`}
                    onClick={() =>
                      setCartoes((cs) => cs.filter((x) => x.id !== c.id))
                    }
                  >
                    {t("Remover")}
                  </Button>
                ) : null}
              </div>
              <label className="flex flex-col gap-1 text-xs text-text-muted">
                {t("Mensagem deste lembrete")}
                <textarea
                  rows={3}
                  maxLength={1000}
                  disabled={!ligado}
                  value={c.body}
                  onChange={(e) => atualizar(c.id, { body: e.target.value })}
                  placeholder={t("Oi {{nome}}! Passando pra lembrar: {{titulo}}, {{dia}} às {{hora}}.")}
                  data-testid={
                    i === 0
                      ? `editar-lembrete-texto-${tipo.id}`
                      : `editar-lembrete-texto-${tipo.id}-${i}`
                  }
                  className="rounded-md border border-border bg-surface p-2 text-sm text-text disabled:opacity-50"
                />
              </label>
            </li>
          );
        })}
      </ul>
      {ligado && cartoes.length < teto ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          data-testid={`editar-lembrete-adicionar-${tipo.id}`}
          onClick={() => {
            const u = deMinutos(minutosLivres(cartoes.map(minutosDe)));
            setCartoes((cs) => [
              ...cs,
              {
                id: `r${++seq.current}`,
                quantidade: u.quantidade,
                unidade: u.unidade,
                body: "",
              },
            ]);
          }}
        >
          {t("Adicionar lembrete")}
        </Button>
      ) : null}
      <p className="text-[11px] text-text-muted">
        {t("Deixe a mensagem em branco para o texto padrão. Variáveis: {{nome}}, {{titulo}}, {{dia}}, {{hora}}, {{endereco}}.")}
      </p>
    </div>
  );
}

export function TiposDeAgendamentoClient({
  tiposIniciais,
  pessoas,
  podeEditar,
  usuarioAtualId,
  podeConfigurarGoogle,
  clientePelaAgendaLigado,
  podeLigarClientePelaAgenda,
  colegasPodemMexerNaAgendaLigado,
  podeMudarAgendaDosColegas,
}: {
  tiposIniciais: TipoRow[];
  pessoas: Array<{ id: string; papel: string; nome: string }>;
  podeEditar: boolean;
  usuarioAtualId: string;
  podeConfigurarGoogle: boolean;
  /** `organizations.settings.crm.cliente_pela_agenda`, lido pela página. */
  clientePelaAgendaLigado: boolean;
  podeLigarClientePelaAgenda: boolean;
  /** `organizations.settings.colegas_podem_mexer_na_agenda` (migration 0343). */
  colegasPodemMexerNaAgendaLigado: boolean;
  podeMudarAgendaDosColegas: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [criando, setCriando] = React.useState(false);
  /**
   * O RASCUNHO NASCE COM QUEM ESTÁ CRIANDO.
   *
   * O tipo nascia sem dono por padrão DA PRÓPRIA TELA: `VAZIO` trazia
   * `default_owner_user_id: ""`, o POST omitia o campo, a coluna não tem default
   * no banco — e a lista passava a acusar "sem responsável — não aparece para
   * marcar", um estado que a tela mesma fabricou. Foi assim que "Call
   * Estratégica" nasceu inútil na instalação do dono do produto.
   *
   * A migration 0195 não alcança este caso por construção: o trigger dela é
   * `after insert on user_organizations`, guardado ao PRIMEIRO membro ativo. Ele
   * dispara quando entra MEMBRO, nunca quando entra TIPO — e a org do dono já
   * tinha membro havia tempo.
   *
   * O default vive AQUI e não no POST de propósito: forçar o criador na rota
   * transformaria "Definir depois" num controle decorativo, e deixar um tipo sem
   * dono continua sendo escolha legítima de quem opera.
   */
  const [rascunho, setRascunho] = React.useState<Rascunho>(() => ({
    ...VAZIO,
    default_owner_user_id: usuarioAtualId,
  }));
  const [salvando, setSalvando] = React.useState(false);
  const [editandoId, setEditandoId] = React.useState<string | null>(null);

  async function comErro(acao: () => Promise<unknown>, mensagem: string) {
    setSalvando(true);
    try {
      await acao();
      toast.success(mensagem);
      // `refresh` e não estado local: quem sabe o que ficou gravado é o servidor.
      router.refresh();
      return true;
    } catch (err) {
      showApiError(err);
      return false;
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="tipos-de-agendamento-config">
      {podeConfigurarGoogle && <AgendasConectadas />}
      <PrazosDePresenca podeEditar={podeEditar}/>
      <ClientePelaAgenda
        ligadoInicial={clientePelaAgendaLigado}
        podeLigar={podeLigarClientePelaAgenda}
      />
      {/* A opção da issue #978 fica ao lado das outras regras de comportamento
          da agenda: é a mesma pergunta ("como a agenda se comporta nesta
          empresa?"), e separá-la noutra tela esconderia de quem configura que
          ela existe. */}
      <AgendaDosColegas
        ligadoInicial={colegasPodemMexerNaAgendaLigado}
        podeMudar={podeMudarAgendaDosColegas}
      />
      <DiasBloqueados podeEditar={podeEditar}/>
      {podeEditar ? (
        <div>
          {criando ? (
            <form
              data-testid="form-novo-tipo"
              className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const feito = await comErro(
                  () =>
                    apiClient.post("/api/v1/agenda/tipos", {
                      name: rascunho.name.trim(),
                      category: rascunho.category,
                      duration_minutes: Number(rascunho.duration_minutes),
                      location_kind: rascunho.location_kind,
                      ...(rascunho.default_owner_user_id
                        ? { default_owner_user_id: rascunho.default_owner_user_id }
                        : {}),
                    }),
                  t("Tipo de agendamento criado."),
                );
                if (feito) {
                  setCriando(false);
                  setRascunho(VAZIO);
                }
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Nome")}
                <input
                  data-testid="novo-tipo-nome"
                  required
                  minLength={2}
                  value={rascunho.name}
                  onChange={(e) => setRascunho((r) => ({ ...r, name: e.target.value }))}
                  placeholder={t("Retorno")}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Categoria")}
                <select
                  data-testid="novo-tipo-categoria"
                  value={rascunho.category}
                  onChange={(e) => setRascunho((r) => ({ ...r, category: e.target.value }))}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                >
                  {CATEGORIAS.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {t(c.rotulo)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Duração (minutos)")}
                <input
                  data-testid="novo-tipo-duracao"
                  type="number"
                  min={5}
                  max={1440}
                  value={rascunho.duration_minutes}
                  onChange={(e) =>
                    setRascunho((r) => ({ ...r, duration_minutes: Number(e.target.value) }))
                  }
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Onde acontece")}
                <select
                  data-testid="novo-tipo-local"
                  value={rascunho.location_kind}
                  onChange={(e) => setRascunho((r) => ({ ...r, location_kind: e.target.value }))}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                >
                  {LOCAIS.map((l) => (
                    <option key={l.valor} value={l.valor}>
                      {t(l.rotulo)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted sm:col-span-2">
                {/* ⚠️ SEM RESPONSÁVEL NÃO HÁ AGENDA. `lib/agenda/consulta.ts` exige
                    dono para saber de QUEM é a jornada; sem ele a rota devolve
                    `sem_responsavel` e a tela de marcar não oferece horário nenhum.
                    Era exatamente o estado dos três tipos semeados. */}
                {t("Quem atende (sem isto, não há horário para oferecer)")}
                <select
                  data-testid="novo-tipo-dono"
                  value={rascunho.default_owner_user_id}
                  onChange={(e) =>
                    setRascunho((r) => ({ ...r, default_owner_user_id: e.target.value }))
                  }
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                >
                  <option value="">{t("Definir depois")}</option>
                  {pessoas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCriando(false)}>
                  {t("Cancelar")}
                </Button>
                <Button type="submit" size="sm" data-testid="salvar-novo-tipo" disabled={salvando}>
                  {salvando ? t("Criando…") : t("Criar tipo")}
                </Button>
              </div>
            </form>
          ) : (
            <Button size="sm" data-testid="abrir-novo-tipo" onClick={() => setCriando(true)}>
              {t("Novo tipo de agendamento")}
            </Button>
          )}
        </div>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="lista-de-tipos">
        {tiposIniciais.length === 0 ? (
          <li data-testid="sem-tipos" className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            {t("Nenhum tipo de agendamento ainda. Crie o primeiro para que a Agenda tenha o que oferecer.")}
          </li>
        ) : null}
        {tiposIniciais.map((tipo) => (
          <li
            key={tipo.id}
            data-testid={`tipo-${tipo.id}`}
            className={`rounded-lg border border-border bg-surface p-3 ${tipo.is_active ? "" : "opacity-60"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {/* Sem t(): é o nome que quem opera digitou no campo acima, não
                  rótulo do sistema — traduzir trocaria "Retorno" por
                  "Seguimiento" (chave existente, de outro contexto). */}
              <span className="text-sm font-medium text-text">{tipo.name}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted">
                {t(rotuloDe(CATEGORIAS, tipo.category))}
              </span>
              <span className="text-xs tabular-nums text-text-muted">{tipo.duration_minutes} min</span>
              <span className="text-xs text-text-muted">{t(rotuloDe(LOCAIS, tipo.location_kind))}</span>
              {!tipo.default_owner_user_id ? (
                // O aviso existe porque o sintoma é MUDO: sem dono, a tela de
                // marcar simplesmente não mostra horário, sem dizer por quê.
                //
                // E ele É A PORTA quando há como resolver. Antes era um `<span>`
                // inerte: acusava o estado e a única saída era descobrir sozinho
                // que o botão "Editar" abre um seletor de responsável. Acusar sem
                // oferecer caminho é o mesmo defeito do aviso da Agenda que não
                // levava aos horários — dito duas vezes no mesmo produto.
                //
                // Mesmo `data-testid` nos dois ramos: ele é contrato de quem lê a
                // tela, e trocá-lo faria a cerca existente parar de encontrar o
                // aviso sem nada acusar.
                podeEditar ? (
                  <button
                    type="button"
                    data-testid={`sem-dono-${tipo.id}`}
                    onClick={() => setEditandoId(tipo.id)}
                    className="text-xs text-warning underline underline-offset-2"
                  >
                    {t("sem responsável — definir quem atende")}
                  </button>
                ) : (
                  <span data-testid={`sem-dono-${tipo.id}`} className="text-xs text-warning">
                    {t("sem responsável — não aparece para marcar")}
                  </span>
                )
              ) : null}
              {tipo.reminder_enabled ? (
                // O estado tem de aparecer SEM abrir o formulário: um aviso que
                // sai sozinho para o telefone do cliente é a última coisa que
                // pode viver escondida atrás de um clique em "Editar".
                <span
                  data-testid={`lembrete-ligado-${tipo.id}`}
                  className="text-xs tabular-nums text-text-muted"
                >
                  {t("avisa o cliente")}{" "}
                  {[tipo.reminder_minutes_before, ...(tipo.reminder_extra_offsets_minutes ?? [])]
                    .sort((a, b) => b - a)
                    .join(", ")}{" "}
                  min {t("antes")}
                  {tipo.reminder_body ||
                  Object.keys(tipo.reminder_bodies ?? {}).length > 0
                    ? ` · ${t("texto próprio")}`
                    : ""}
                </span>
              ) : null}
              {!tipo.is_active ? <span className="text-xs text-text-subtle">{t("desativado")}</span> : null}
              {podeEditar ? (
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`editar-${tipo.id}`}
                    onClick={() => setEditandoId(editandoId === tipo.id ? null : tipo.id)}
                  >
                    {editandoId === tipo.id ? t("Fechar") : t("Editar")}
                  </Button>
                  {tipo.is_active ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`desativar-${tipo.id}`}
                      disabled={salvando}
                      onClick={() =>
                        void comErro(
                          () => apiClient.delete("/api/v1/agenda/tipos", { id: tipo.id }),
                          "Tipo desativado.",
                        )
                      }
                    >
                      Desativar
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`reativar-${tipo.id}`}
                      disabled={salvando}
                      onClick={() =>
                        void comErro(
                          // Rota PRÓPRIA, e o `as never` que estava aqui saiu.
                          //
                          // Este botão nunca funcionou: mandava `is_active` num
                          // PATCH cujo schema é `criarSchema.partial()`, onde
                          // esse campo não existe. Zod descarta chave
                          // desconhecida em silêncio, o corpo chegava vazio e a
                          // resposta era 422 "Nenhum campo para alterar.". O
                          // cast era o que impedia o typecheck de acusar.
                          () => apiClient.post("/api/v1/agenda/tipos/reativar", { id: tipo.id }),
                          "Tipo reativado.",
                        )
                      }
                    >
                      Reativar
                    </Button>
                  )}
                </span>
              ) : null}
            </div>

            {editandoId === tipo.id ? (
              <form
                data-testid={`form-editar-${tipo.id}`}
                className="mt-3 flex flex-col gap-3 border-t border-border pt-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const dados = new FormData(e.currentTarget);
                  const feito = await comErro(
                    () =>
                      apiClient.patch("/api/v1/agenda/tipos", {
                        id: tipo.id,
                        name: String(dados.get("name") ?? "").trim(),
                        category: String(dados.get("category") ?? tipo.category),
                        duration_minutes: Number(dados.get("duration_minutes") ?? tipo.duration_minutes),
                        // `|| null`, e NÃO omitir quando vazio.
                        //
                        // A tela oferece `<option value="">{t("Sem responsável")}</option>`
                        // logo abaixo, e omitir o campo fazia essa escolha não
                        // chegar ao servidor: depois de definido, o responsável não
                        // podia mais ser removido. Controle que a tela oferece e o
                        // código ignora é o pior dos dois — pior que não existir,
                        // porque quem clica conclui que salvou.
                        //
                        // `alterarSchema` aceita `nullish()`, então o nulo é
                        // contrato, não contorno. O efeito de limpar é a agenda
                        // daquele tipo parar de oferecer horário e o aviso amarelo
                        // voltar — que é o laço de retorno correto.
                        default_owner_user_id:
                          String(dados.get("default_owner_user_id") ?? "") || null,
                        // Caixa desmarcada não aparece no `FormData` — daí a
                        // comparação, e não um `Boolean(...)` do valor ausente.
                        reminder_enabled: dados.get("reminder_enabled") === "on",
                        // O campo desabilitado também não aparece, e omitir é o
                        // certo: desligar o aviso não pode apagar a lista que
                        // alguém escolheu (ver `LembreteDoCompromisso`).
                        ...(dados.get("reminder_enabled") === "on"
                          ? (() => {
                              const emp = empacotarLembretes(
                                lerPassosDoFormulario(
                                  String(dados.get("reminder_steps") ?? ""),
                                ),
                              );
                              return {
                                reminder_minutes_before: emp.principal,
                                reminder_extra_offsets_minutes: emp.extras,
                                reminder_body: emp.corpoPrincipal,
                                reminder_bodies: emp.corposExtras,
                              };
                            })()
                          : {}),
                      }),
                    "Tipo alterado.",
                  );
                  if (feito) setEditandoId(null);
                }}
              >
                <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,18rem)]">
                  <label className="flex flex-col gap-1 text-xs text-text-muted">
                    Nome
                    <input
                      name="name"
                      defaultValue={tipo.name}
                      data-testid={`editar-nome-${tipo.id}`}
                      className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-text-muted">
                    {t("Duração")}
                    <input
                      name="duration_minutes"
                      type="number"
                      min={5}
                      max={1440}
                      defaultValue={tipo.duration_minutes}
                      data-testid={`editar-duracao-${tipo.id}`}
                      className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-text-muted">
                    {t("Quem atende")}
                    <select
                      name="default_owner_user_id"
                      defaultValue={tipo.default_owner_user_id ?? ""}
                      data-testid={`editar-dono-${tipo.id}`}
                      className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                    >
                      <option value="">{t("Sem responsável")}</option>
                      {pessoas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nome}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <LembreteDoCompromisso tipo={tipo} />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" data-testid={`salvar-${tipo.id}`} disabled={salvando}>
                    {salvando ? t("Salvando…") : t("Salvar")}
                  </Button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

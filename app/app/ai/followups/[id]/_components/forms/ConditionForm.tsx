"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { conditionConfigSchema, nodeBranches } from "@/lib/followup/graph-schema";
import {
  CAMPOS_DA_CONDICAO,
  COMBINADORES,
  comparador,
  comparadoresDoCampo,
  fraseDaCondicao,
  opcoes,
  regraValeSempre,
  temFormaDeId,
  type CampoDaCondicao,
  type Combinador,
  type OperadorDaCondicao,
} from "@/lib/followup/vocabulario";
import { Plus, Trash } from "@/lib/ui/icons";
import { etapasPorFunil, nomeDaEtapa } from "@/hooks/followup/useEtapasDeGatilho";
import { useT } from "@/hooks/i18n/useT";

import { useEtapasDoFluxo } from "../EtapasDoFluxo";
import { regraEmBranco } from "../nodes/nodeVisuals";
import type { ConfigOf } from "./shared";

/**
 * Trocar de campo pode deixar o operador órfão: `gte` faz sentido em "passos
 * dados" e nunca é verdadeiro em "etiqueta". Em vez de manter na tela uma
 * escolha que o motor ignora, cai no primeiro operador que o campo novo
 * oferece.
 */
function operadorValidoPara(campo: CampoDaCondicao, atual: OperadorDaCondicao): OperadorDaCondicao {
  if (comparador(campo, atual).oferecido) return atual;
  return comparadoresDoCampo(campo)[0]!.op;
}

type ConditionConfig = ConfigOf<"condition">;
type Check = ConditionConfig["checks"][number];
type Branching = NonNullable<ConditionConfig["branching"]>;

/** Id novo que não colide com os já usados. Opaco de propósito: é a identidade
 *  da saída, e ela não pode mudar quando o usuário reescreve o rótulo. */
function novoIdDeRegra(usados: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidato = `regra-${n}`;
    if (!usados.has(candidato)) return candidato;
  }
}

/** No modo "uma saída por regra" toda regra precisa de id — é o que a aresta referencia. */
function comIdsEstaveis(checks: Check[]): Check[] {
  const usados = new Set(checks.flatMap((c) => (c.id === undefined ? [] : [c.id])));
  return checks.map((c) => {
    if (c.id !== undefined) return c;
    const id = novoIdDeRegra(usados);
    usados.add(id);
    return { ...c, id };
  });
}

export function ConditionForm({
  config,
  onChange,
  ramosLigados = [],
}: {
  config: ConditionConfig;
  onChange: (c: ConditionConfig) => void;
  /** Ramos deste nó que hoje têm aresta — para avisar antes de deixar alguma órfã. */
  ramosLigados?: string[];
}) {
  const t = useT();
  const { etapas, carregando: etapasCarregando, falhou: etapasFalharam, nomes } = useEtapasDoFluxo();
  const funis = etapasPorFunil(etapas);
  const [combinator, setCombinator] = useState(config.combinator);
  const [branching, setBranching] = useState<Branching>(config.branching ?? "combined");
  const [checks, setChecks] = useState(config.checks);
  const [error, setError] = useState<string | null>(null);
  /** Troca de modo pendente de confirmação, com quantas ligações ela deixa órfãs. */
  const [trocaPendente, setTrocaPendente] = useState<{ modo: Branching; orfas: number } | null>(null);

  /**
   * Recebe um OBJETO com o que mudou, e não a lista posicional de campos: era
   * justamente por remontar a config com `{ combinator, checks }` e mais nada
   * que qualquer campo novo morria na primeira edição do nó — o modo se apagava
   * sozinho e as bolinhas sumiam. Campo novo aqui entra como chave, não como
   * mais um parâmetro que alguém esquece de repassar.
   */
  const commit = (next: {
    combinator?: Combinador;
    branching?: Branching;
    checks?: Check[];
  }) => {
    const modo = next.branching ?? branching;
    const candidato: ConditionConfig = {
      combinator: next.combinator ?? combinator,
      // Só é escrito no modo novo: mexer num nó de fluxo antigo não passa a
      // gravar uma chave que ele nunca teve.
      ...(modo === "per_check" ? { branching: modo } : {}),
      checks: next.checks ?? checks,
    };
    const parsed = conditionConfigSchema.safeParse(candidato);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  /** Quantas ligações existentes deixam de ter saída se o nó passar a `modo`. */
  const orfasSe = (modo: Branching): number => {
    const checksDoModo = modo === "per_check" ? comIdsEstaveis(checks) : checks;
    const idsDepois = new Set(
      nodeBranches({ type: "condition", config: { combinator, branching: modo, checks: checksDoModo } }).map(
        (b) => b.id,
      ),
    );
    return ramosLigados.filter((id) => !idsDepois.has(id)).length;
  };

  const aplicarModo = (modo: Branching) => {
    const proximosChecks = modo === "per_check" ? comIdsEstaveis(checks) : checks;
    setBranching(modo);
    setChecks(proximosChecks);
    setTrocaPendente(null);
    commit({ branching: modo, checks: proximosChecks });
  };

  const pedirModo = (modo: Branching) => {
    if (modo === branching) return;
    const orfas = orfasSe(modo);
    if (orfas > 0) {
      setTrocaPendente({ modo, orfas });
      return;
    }
    aplicarModo(modo);
  };

  const porRegra = branching === "per_check";

  const trocarValor = (idx: number, valor: string | number) => {
    const next = checks.map((c, i) => (i === idx ? { ...c, value: valor } : c));
    setChecks(next);
    commit({ checks: next });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="cond-branching">{t("Como as regras decidem o caminho")}</Label>
        <Select value={branching} onValueChange={(v) => pedirModo(v as Branching)}>
          <SelectTrigger id="cond-branching">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="combined">{t("Avaliar as regras juntas (uma saída de sim e uma de não)")}</SelectItem>
            <SelectItem value="per_check">{t("Uma saída por regra")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {trocaPendente && (
        <div className="space-y-2 rounded-sm border border-warning bg-warning-bg p-2" data-testid="cond-troca-aviso">
          <p className="text-xs leading-snug text-warning-fg">
            {t("Trocar de modo deixa")} {trocaPendente.orfas}{" "}
            {trocaPendente.orfas === 1 ? t("ligação sem saída") : t("ligações sem saída")}{" "}
            {t("neste nó. Elas continuam desenhadas, mas param de levar a lugar nenhum até você religá-las.")}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => aplicarModo(trocaPendente.modo)}>
              {t("Trocar mesmo assim")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setTrocaPendente(null)}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      )}

      {/* O combinador só aparece no modo em que ele decide alguma coisa. No modo
          uma-saída-por-regra a regra não vota, ela roteia — e o motor nem lê
          este campo. Mostrar um controle que não tem efeito é o mesmo defeito
          que o subtítulo do card tinha. O texto é o do vocabulário, não meu. */}
      {!porRegra && (
        <div className="space-y-2">
          <Label htmlFor="cond-combinator">{t("Seguir por aqui quando")}</Label>
          <Select
            value={combinator}
            onValueChange={(v) => {
              const next = v as Combinador;
              setCombinator(next);
              commit({ combinator: next });
            }}
          >
            <SelectTrigger id="cond-combinator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {opcoes(COMBINADORES).map(({ valor, rotulo }) => (
                <SelectItem key={valor} value={valor}>
                  {t(rotulo)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-3">
        {checks.map((check, idx) => (
          <div key={check.id ?? idx} className="space-y-2 rounded-sm border border-border p-2" data-testid={`condition-check-${idx}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">{t("Condição")} {idx + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover condição")}
                disabled={checks.length <= 1}
                onClick={() => {
                  const next = checks.filter((_, i) => i !== idx);
                  setChecks(next);
                  commit({ checks: next });
                }}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
            {porRegra && (
              <Input
                aria-label={`${t("Nome da saída")} ${idx + 1}`}
                placeholder={t("Nome desta saída (opcional)")}
                value={check.label ?? ""}
                onChange={(e) => {
                  const texto = e.target.value;
                  const next = checks.map((c, i) =>
                    // Sem texto o campo SOME da regra em vez de virar string vazia:
                    // o schema pede 1 a 60, e um rótulo vazio reprovaria a config
                    // inteira só porque o usuário apagou o que tinha escrito.
                    i === idx ? { ...c, ...(texto === "" ? { label: undefined } : { label: texto }) } : c,
                  );
                  setChecks(next);
                  commit({ checks: next });
                }}
              />
            )}
            <Select
              value={check.field}
              onValueChange={(v) => {
                const campo = v as CampoDaCondicao;
                // O valor NÃO sobrevive à troca de campo: "3" de passos virava a
                // etapa "3", e o id de uma etapa virava uma etiqueta — regra com
                // cara de pronta que nunca decide. Recomeça "a preencher".
                const next = checks.map((c, i) => {
                  if (i !== idx) return c;
                  const trocado = {
                    ...c,
                    field: campo,
                    op: operadorValidoPara(campo, c.op),
                    // A regra de data começa em 0 dias = "hoje ou já passou",
                    // que é o caso que quase todo mundo quer; os outros campos
                    // recomeçam "a preencher".
                    value: campo === "lead_date" ? 0 : "",
                  };
                  // A chave só pertence à regra de data: deixá-la para trás
                  // guardaria `fim_teste` numa regra de etiqueta, e o publish
                  // recusaria uma regra que a tela mostra como pronta.
                  if (campo !== "lead_date") delete (trocado as { key?: string }).key;
                  return trocado;
                });
                setChecks(next);
                commit({ checks: next });
              }}
            >
              <SelectTrigger aria-label={t("Campo")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CAMPOS_DA_CONDICAO) as CampoDaCondicao[]).map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(CAMPOS_DA_CONDICAO[f].rotulo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={check.op}
              onValueChange={(v) => {
                const next = checks.map((c, i) => (i === idx ? { ...c, op: v as OperadorDaCondicao } : c));
                setChecks(next);
                commit({ checks: next });
              }}
            >
              <SelectTrigger aria-label={t("Operador")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {comparadoresDoCampo(check.field).map(({ op, rotulo }) => (
                  <SelectItem key={op} value={op}>
                    {t(rotulo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {CAMPOS_DA_CONDICAO[check.field].tipoDeValor === "etapa" ? (
              // A etapa é ESCOLHIDA, nunca digitada: o motor compara o
              // `stage_id`, e um campo de texto pedia ao dono da clínica que
              // digitasse o nome — "PAGO" —, que nunca casa com nada.
              <ValorDeEtapa
                valor={String(check.value).trim()}
                funis={funis}
                carregando={etapasCarregando}
                falhou={etapasFalharam}
                onEscolher={(stageId) => trocarValor(idx, stageId)}
              />
            ) : CAMPOS_DA_CONDICAO[check.field].tipoDeValor === "dias" ? (
              // DUAS entradas, porque a regra de data tem duas partes: QUAL
              // campo do negócio guarda a data, e QUANTOS dias de prazo. Sem a
              // primeira o publish recusa a regra (`campo_de_data_ausente`).
              <div className="grid gap-2">
                <Input
                  aria-label={t("Campo do negócio com a data")}
                  placeholder={t("Ex.: fim_teste")}
                  value={String((check as { key?: string }).key ?? "")}
                  onChange={(e) => {
                    const next = checks.map((c, i) =>
                      i === idx ? { ...c, key: e.target.value.trim() } : c,
                    );
                    setChecks(next);
                    commit({ checks: next });
                  }}
                />
                <Input
                  aria-label={t("Prazo em dias")}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  placeholder={t("0 = inclui hoje")}
                  value={String(check.value)}
                  // Número no motor, como "passos dados": gravar o texto faria
                  // o prazo nunca ser comparável e a regra responder sempre não.
                  onChange={(e) => {
                    const bruto = e.target.value.trim();
                    trocarValor(idx, /^\d+$/.test(bruto) ? Number(bruto) : bruto);
                  }}
                />
                <p className="text-xs text-text-muted">
                  {t(
                    "O campo é o mesmo nome usado na ficha do negócio. O prazo conta em dias de calendário no fuso da organização; 0 inclui o dia de hoje.",
                  )}
                </p>
              </div>
            ) : CAMPOS_DA_CONDICAO[check.field].tipoDeValor === "numero" ? (
              <Input
                aria-label={t("Valor")}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                placeholder={t("Ex.: 3")}
                value={String(check.value)}
                // Passos é NÚMERO no motor. Gravar o texto digitado fazia
                // `≥ "3"` nunca valer e `≠ "3"` valer sempre.
                onChange={(e) => {
                  const bruto = e.target.value;
                  trocarValor(idx, /^-?\d+$/.test(bruto.trim()) ? Number(bruto) : bruto);
                }}
              />
            ) : (
              <Input
                aria-label={t("Valor")}
                placeholder={t("Valor")}
                value={String(check.value)}
                onChange={(e) => trocarValor(idx, e.target.value)}
              />
            )}
            {/* A frase inteira, para quem não tem certeza do que os três campos
                acima somam — e o aviso quando o motor nunca satisfaz o par. */}
            <p className="text-xs text-text-muted">{fraseDaCondicao(check.field, check.op, check.value, nomes)}</p>
            {comparador(check.field, check.op).aviso && (
              <p className="text-xs text-warning-fg">{t(comparador(check.field, check.op).aviso!)}</p>
            )}
            {regraValeSempre(check.field, check.op, check.value) && (
              <p className="text-xs text-warning-fg" data-testid={`regra-vale-sempre-${idx}`}>
                {t("Esta regra vale para todo contato. A saída dela leva todo mundo, e as saídas seguintes nunca são usadas.")}
              </p>
            )}
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={checks.length >= 10}
        onClick={() => {
          const nova: Check = regraEmBranco();
          const next = porRegra
            ? comIdsEstaveis([...checks, nova])
            : [...checks, nova];
          setChecks(next);
          commit({ checks: next });
        }}
      >
        <Plus size={14} aria-hidden className="mr-1" /> {t("Condição")}
      </Button>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

/**
 * O seletor de etapa da regra, agrupado por funil. O valor gravado que não é
 * etapa ativa aparece como AVISO, não como opção: um fluxo anterior ao seletor
 * guardou o nome digitado ("PAGO"), e a etapa pode ter sido apagada ou arquivada
 * depois de escolhida. Nos dois casos a regra nunca decide nada — o publish
 * recusa, e a tela diz por quê antes.
 */
function ValorDeEtapa({
  valor,
  funis,
  carregando,
  falhou,
  onEscolher,
}: {
  valor: string;
  funis: ReturnType<typeof etapasPorFunil>;
  carregando: boolean;
  falhou: boolean;
  onEscolher: (stageId: string) => void;
}) {
  const t = useT();
  const conhecida = funis.some((f) => f.etapas.some((e) => e.stageId === valor));
  // Lista vazia por FALHA não é lista vazia por não haver etapa: acusar a regra
  // aqui seria culpar o fluxo por uma consulta que caiu.
  const semEtapas = !carregando && !falhou && funis.length === 0;
  const solta = !carregando && !falhou && valor !== "" && !conhecida;

  return (
    <>
      <Select value={conhecida ? valor : ""} onValueChange={onEscolher} disabled={carregando || falhou || semEtapas}>
        <SelectTrigger aria-label={t("Valor")} aria-invalid={solta}>
          <SelectValue placeholder={carregando ? t("Carregando etapas…") : t("Escolha a etapa")} />
        </SelectTrigger>
        <SelectContent>
          {funis.map((funil) => (
            <SelectGroup key={funil.id}>
              <SelectLabel>{funil.nome}</SelectLabel>
              {funil.etapas.map((etapa) => (
                <SelectItem key={etapa.stageId} value={etapa.stageId}>
                  {nomeDaEtapa(etapa)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {falhou && (
        <p className="text-xs text-warning-fg" data-testid="regra-etapas-indisponiveis">
          {t("Não consegui carregar as etapas agora. O que estava escolhido continua salvo — recarregue a página para escolher outra.")}
        </p>
      )}
      {semEtapas && (
        <p className="text-xs text-error-fg">
          {t("Nenhuma etapa ativa encontrada — crie o funil antes de usar esta regra.")}
        </p>
      )}
      {solta && (
        <p className="text-xs text-warning-fg" data-testid="regra-etapa-solta">
          {temFormaDeId(valor)
            ? t("A etapa escolhida não está mais na lista de etapas ativas — foi arquivada ou apagada. Escolha outra.")
            : `“${valor}” ${t("foi digitado à mão e não é uma etapa do funil. Escolha a etapa na lista — do jeito que está, esta regra nunca decide nada.")}`}
        </p>
      )}
    </>
  );
}

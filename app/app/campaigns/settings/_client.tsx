"use client";
/**
 * Configuração de campanhas — as três coisas que valem para TODAS elas.
 *
 * ═══ Por que uma tela e não três ═══
 *
 * "Cadê a tela de configuração das campanhas?" foi a pergunta que a criou. Três
 * telas separadas (padrões, textos, exclusões) seriam três lugares para
 * procurar, e a pessoa que pergunta isso está procurando UM. O que as une é o
 * escopo: nada aqui pertence a uma campanha, tudo vale para a próxima também.
 *
 * ═══ O que NÃO está aqui, e onde está ═══
 *
 * A proteção do NÚMERO — intervalo, janela, teto diário e aquecimento — vive em
 * Conexões › Proteção de envio, porque protege o número inteiro, inclusive o
 * que o agente manda. Esta tela guarda o padrão da CAMPANHA, e campanha só sabe
 * ir mais devagar que o número. O link está escrito na própria seção: mandar
 * alguém procurar é o mesmo defeito que criou esta tela.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useApagarTexto,
  useConfiguracaoDeCampanhas,
  useExclusoes,
  useExcluirNumero,
  useSalvarConfiguracao,
  useSalvarTexto,
  useTextosSalvos,
  useTirarDaExclusao,
} from "@/hooks/campanhas/useConfiguracao";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft } from "@/lib/ui/icons";

export function ConfiguracaoDeCampanhas() {
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <Link
          href="/app/campaigns"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-text"
        >
          <ArrowBendUpLeft size={14} aria-hidden />
          {t("Campanhas")}
        </Link>
      </div>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Configuração de campanhas")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que vale para todas as campanhas, e não para uma só.")}
        </p>
      </header>

      <Padroes />
      <TextosSalvos />
      <ListaDeExclusao />
    </div>
  );
}

function Padroes() {
  const t = useT();
  const q = useConfiguracaoDeCampanhas();
  const salvar = useSalvarConfiguracao();
  const [atribuicao, setAtribuicao] = useState("");
  const [intervalo, setIntervalo] = useState("");
  const [tetoDia, setTetoDia] = useState("");
  const [tetoHora, setTetoHora] = useState("");
  const [inicio, setInicio] = useState("");
  const [fim, setFim] = useState("");
  const [carregado, setCarregado] = useState(false);

  useEffect(() => {
    const c = q.data?.configuracao;
    if (!c || carregado) return;
    setAtribuicao(String(c.atribuicao_horas));
    setIntervalo(txt(c.intervalo_segundos));
    setTetoDia(txt(c.teto_diario));
    setTetoHora(txt(c.teto_horario));
    setInicio(txt(c.janela_inicio_hora));
    setFim(txt(c.janela_fim_hora));
    setCarregado(true);
  }, [q.data, carregado]);

  if (q.isLoading || !carregado) return <Skeleton className="h-64 w-full" />;

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Padrões desta organização")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Campo vazio significa herdar o número. Toda campanha nova nasce com estes valores e pode ficar mais devagar, nunca mais rápida.")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="atribuicao">{t("Contar como resposta até (horas depois do envio)")}</Label>
        <Input
          id="atribuicao"
          type="number"
          min={1}
          max={720}
          value={atribuicao}
          onChange={(e) => setAtribuicao(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          {t("Uma mensagem que chega depois desse prazo é conversa nova, não resposta à campanha. Isso muda o número de respostas que a tela mostra, inclusive das campanhas já enviadas.")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Campo id="p-intervalo" rotulo={t("Intervalo mínimo entre mensagens (segundos)")} valor={intervalo} onChange={setIntervalo} />
        <Campo id="p-dia" rotulo={t("Máximo por dia")} valor={tetoDia} onChange={setTetoDia} />
        <Campo id="p-hora" rotulo={t("Máximo por hora")} valor={tetoHora} onChange={setTetoHora} />
        <div />
        <Campo id="p-inicio" rotulo={t("Enviar só a partir das (hora)")} valor={inicio} onChange={setInicio} />
        <Campo id="p-fim" rotulo={t("Parar de enviar às (hora)")} valor={fim} onChange={setFim} />
      </div>

      <p className="text-sm text-muted-foreground">
        {t("A proteção do número — ritmo, janela e aquecimento que valem para tudo que sai por ele — fica em")}{" "}
        <Link href="/app/connections" className="underline">
          {t("Conexões › Proteção de envio")}
        </Link>
        .
      </p>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={salvar.isPending}
          onClick={() =>
            salvar.mutate({
              atribuicao_horas: Number(atribuicao) || 72,
              intervalo_segundos: num(intervalo),
              teto_diario: num(tetoDia),
              teto_horario: num(tetoHora),
              janela_inicio_hora: num(inicio),
              janela_fim_hora: num(fim),
            })
          }
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar padrões")}
        </Button>
        {salvar.isSuccess && !salvar.isPending && (
          <span className="text-sm text-success-fg">{t("Padrões salvos.")}</span>
        )}
      </div>
    </Card>
  );
}

function TextosSalvos() {
  const t = useT();
  const q = useTextosSalvos();
  const salvar = useSalvarTexto();
  const apagar = useApagarTexto();
  const [nome, setNome] = useState("");
  const [corpo, setCorpo] = useState("");

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Textos salvos")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Copy que você reusa entre campanhas. Mudar um texto aqui não muda mensagem que já foi preparada nem que já foi enviada.")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="t-nome">{t("Nome")}</Label>
        <Input id="t-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t("Ex.: Primeiro contato — produtor")} />
        <Label htmlFor="t-corpo">{t("Texto")}</Label>
        <Textarea id="t-corpo" rows={4} value={corpo} onChange={(e) => setCorpo(e.target.value)} />
        <Button
          size="sm"
          disabled={nome.trim() === "" || corpo.trim() === "" || salvar.isPending}
          onClick={async () => {
            await salvar.mutateAsync({ name: nome.trim(), body: corpo.trim() });
            setNome("");
            setCorpo("");
          }}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar texto")}
        </Button>
      </div>

      <div className="divide-y divide-border">
        {(q.data ?? []).map((texto) => (
          <div key={texto.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="font-medium">{texto.name}</p>
              <p className="truncate text-sm text-muted-foreground">{texto.body}</p>
            </div>
            <Button size="sm" variant="outline" disabled={apagar.isPending} onClick={() => apagar.mutate(texto.id)}>
              {t("Apagar")}
            </Button>
          </div>
        ))}
        {(q.data ?? []).length === 0 && !q.isLoading && (
          <p className="py-2 text-sm text-muted-foreground">{t("Nenhum texto salvo ainda.")}</p>
        )}
      </div>
    </Card>
  );
}

function ListaDeExclusao() {
  const t = useT();
  const q = useExclusoes();
  const excluir = useExcluirNumero();
  const tirar = useTirarDaExclusao();
  const [telefone, setTelefone] = useState("");
  const [motivo, setMotivo] = useState("");

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Lista de exclusão")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Números que nenhuma campanha alcança. Diferente de quem pediu para parar: aqui o atendimento continua normal se a pessoa escrever — isto é uma decisão sua, não dela.")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="x-tel">{t("Telefone com DDI e DDD")}</Label>
          <Input id="x-tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="+5548999990000" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="x-motivo">{t("Motivo (opcional)")}</Label>
          <Input id="x-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </div>
      </div>
      <Button
        size="sm"
        disabled={telefone.trim() === "" || excluir.isPending}
        onClick={async () => {
          await excluir.mutateAsync({ address: telefone.trim(), reason: motivo.trim() || null });
          setTelefone("");
          setMotivo("");
        }}
      >
        {excluir.isPending ? t("Salvando…") : t("Excluir das campanhas")}
      </Button>

      <div className="divide-y divide-border">
        {(q.data ?? []).map((e) => (
          <div key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              {/* Só os últimos dígitos: o número inteiro não volta do servidor. */}
              {t("termina em")} {e.address_tail ?? "—"}
              {e.reason ? ` · ${e.reason}` : ""}
            </span>
            <Button size="sm" variant="outline" disabled={tirar.isPending} onClick={() => tirar.mutate(e.id)}>
              {t("Tirar da lista")}
            </Button>
          </div>
        ))}
        {(q.data ?? []).length === 0 && !q.isLoading && (
          <p className="py-2 text-sm text-muted-foreground">{t("Nenhum número excluído.")}</p>
        )}
      </div>
    </Card>
  );
}

function Campo({
  id,
  rotulo,
  valor,
  onChange,
}: {
  id: string;
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{rotulo}</Label>
      <Input id={id} type="number" min={0} value={valor} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function txt(valor: number | null): string {
  return valor === null || valor === undefined ? "" : String(valor);
}

function num(valor: string): number | null {
  const limpo = valor.trim();
  if (limpo === "") return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

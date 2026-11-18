"use client";

import { useEffect, useState, type ReactNode } from "react";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";

export interface Opcao {
  id: string;
  titulo: string;
  detalhe?: string | null;
}

interface Props {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  titulo: string;
  /** Rota de listagem que aceita `?search=` e devolve `{ data: [...] }`. */
  endpoint: string;
  mapear: (linha: Record<string, unknown>) => Opcao;
  /** Ids que já estão ligados e por isso não aparecem como escolha. */
  ocultar?: string[];
  placeholder: string;
  rotuloConfirmar: string;
  onConfirmar: (escolhida: Opcao) => Promise<string | null>;
  /**
   * "Criar com este texto" quando a busca não acha quem se procura: com nada
   * escolhido e algo digitado, o botão principal vira `rotulo: texto` e cria
   * e liga num passo só (ficha da empresa: pessoa nova; ficha da pessoa:
   * telefone ou e-mail novo; ficha do contato: pessoa nova).
   */
  criarNovo?: {
    rotulo: string;
    acao: (texto: string) => Promise<string | null>;
    /** Só oferece criar quando o texto serve (ex.: telefone ou e-mail válido). */
    aceita?: (texto: string) => boolean;
  };
  /** Texto que já vem na busca ao abrir (ex.: o nome do contato). */
  buscaInicial?: string;
  /** Campos extras do vínculo (cargo, decisor) abaixo da lista. */
  children?: ReactNode;
}

/**
 * Diálogo de busca e escolha das fichas B2B (issue #3198): uma busca, uma
 * lista, uma escolha. As três telas (pessoa, empresa e contato) usam o mesmo
 * diálogo para o vínculo funcionar igual em todas.
 */
export function BuscarEEscolher({
  aberto,
  onAbertoChange,
  titulo,
  endpoint,
  mapear,
  ocultar = [],
  placeholder,
  rotuloConfirmar,
  onConfirmar,
  criarNovo,
  buscaInicial = "",
  children,
}: Props) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [buscaFeita, setBuscaFeita] = useState("");
  const [opcoes, setOpcoes] = useState<Opcao[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [escolhida, setEscolhida] = useState<Opcao | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (aberto) {
      setBusca(buscaInicial);
      setBuscaFeita(buscaInicial.trim());
    } else {
      setBusca("");
      setBuscaFeita("");
      setEscolhida(null);
      setErro(null);
    }
    // Só na abertura: trocar `buscaInicial` com o diálogo aberto não apaga o
    // que a pessoa já digitou.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  useEffect(() => {
    const timer = setTimeout(() => setBuscaFeita(busca.trim()), 250);
    return () => clearTimeout(timer);
  }, [busca]);

  useEffect(() => {
    if (!aberto) return;
    let cancelado = false;
    setCarregando(true);
    // 50 e não 20: os já ligados saem DEPOIS da busca, e uma empresa com muita
    // gente ligada esvaziaria a primeira página.
    const qs = new URLSearchParams({ limit: "50" });
    if (buscaFeita) qs.set("search", buscaFeita);
    void fetch(`${endpoint}?${qs.toString()}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelado) return;
        const linhas = Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
        setOpcoes(linhas.map(mapear).filter((o) => !ocultar.includes(o.id)));
      })
      .catch(() => {
        if (!cancelado) setOpcoes([]);
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => {
      cancelado = true;
    };
    // `mapear` e `ocultar` mudam de identidade a cada render do pai; a busca
    // só precisa refazer quando o texto, a rota ou a abertura mudam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, endpoint, buscaFeita]);

  async function confirmar() {
    if (!escolhida) return;
    setSalvando(true);
    setErro(null);
    const falha = await onConfirmar(escolhida);
    setSalvando(false);
    if (falha) {
      setErro(falha);
      return;
    }
    onAbertoChange(false);
  }

  async function criar() {
    if (!criarNovo || !busca.trim()) return;
    setSalvando(true);
    setErro(null);
    const falha = await criarNovo.acao(busca.trim());
    setSalvando(false);
    if (falha) {
      setErro(falha);
      return;
    }
    onAbertoChange(false);
  }

  // Nada escolhido e algo digitado: o botão principal cria. Espera a busca do
  // texto atual terminar, para não oferecer "criar" a quem a lista ainda vai
  // mostrar.
  const vaiCriar =
    Boolean(criarNovo) &&
    Boolean(busca.trim()) &&
    busca.trim() === buscaFeita &&
    !carregando &&
    (criarNovo?.aceita?.(busca.trim()) ?? true);

  return (
    <Dialog open={aberto} onOpenChange={onAbertoChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="relative">
            <MagnifyingGlass className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                // Busca nova, escolha nova: confirmar não pode ligar um item
                // que já saiu da lista.
                setEscolhida(null);
              }}
              placeholder={placeholder}
              autoComplete="new-password"
              autoFocus
            />
          </div>
          <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label={titulo}>
            {carregando ? (
              <li className="px-2 py-1 text-sm text-muted-foreground">{t("Carregando…")}</li>
            ) : opcoes.length === 0 ? (
              <li className="px-2 py-1 text-sm text-muted-foreground">
                {vaiCriar ? t("Nada encontrado. Confirme para criar.") : t("Nada encontrado.")}
              </li>
            ) : (
              opcoes.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    aria-pressed={escolhida?.id === o.id}
                    onClick={() => setEscolhida(o)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted ${
                      escolhida?.id === o.id ? "border-primary bg-muted" : "border-transparent"
                    }`}
                  >
                    <span className="font-medium">{o.titulo}</span>
                    {o.detalhe ? (
                      <span className="block text-xs text-muted-foreground">{o.detalhe}</span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          {children}
          {erro ? (
            <p className="text-sm text-destructive" role="alert">
              {erro}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onAbertoChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={(!escolhida && !vaiCriar) || salvando}
            onClick={() => void (escolhida ? confirmar() : criar())}
          >
            {salvando
              ? t("Salvando…")
              : escolhida || !vaiCriar
                ? rotuloConfirmar
                : `${criarNovo!.rotulo}: ${busca.trim()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A mensagem de erro que o servidor mandou, ou a frase genérica. */
export async function mensagemDeErro(res: Response, generica: string): Promise<string | null> {
  if (res.ok) return null;
  const json = await res.json().catch(() => null);
  return (json?.error?.message as string | undefined) || generica;
}

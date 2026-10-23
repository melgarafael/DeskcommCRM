"use client";

/**
 * ── O que esta tela é ───────────────────────────────────────────────────────
 *
 * A porta que faltava para o cadastro do servidor MCP externo (#2948). O
 * endereço e a chave que a action `definirServidorMcpExterno` já sabia gravar
 * não tinham NENHUMA tela: quem instalava só conseguia registrar o servidor por
 * fora da interface, e a chave ficava na mão de quem soubesse chamar a action.
 *
 * ── Quem faz o trabalho pesado ──────────────────────────────────────────────
 *
 * Esta tela NÃO reimplementa regra nenhuma: ela chama as duas actions que já
 * existiam e traduz o resultado em frase.
 *
 *   1. Cadastrar e REMOVER são a MESMA action (`definirServidorMcpExterno`):
 *      endereço vazio É o contrato de apagar. O anti-SSRF
 *      (`conferirEndpointSeguro`) e a cifragem da chave moram lá — aqui só se
 *      mostra a recusa com todas as letras.
 *   2. Testar é `listarFerramentasMcpExternas`, que carrega o servidor SALVO
 *      (`carregarServidorMcpExterno`) e devolve o host e o que ele anuncia.
 *
 * ── Por que a chave aparece UMA vez ────────────────────────────────────────
 *
 * A action nunca devolve a chave: ela sai cifrada para as colunas
 * `mcp_externo_chave_*`, e o que volta é `chaveUltimos4`. Isso é decisão do
 * SERVIDOR, não desta tela — e a frase daqui diz o que o operador consegue
 * conferir (o fim da chave), em vez de prometer um texto claro que não existe.
 * O bloco nasce do resultado do SALVAR (não do campo ao vivo), então digitar
 * depois de salvar não o reacende.
 */
import { useState, useTransition } from "react";

import {
  definirServidorMcpExterno,
  type ResultadoRegistroDeServidorMcp,
} from "@/app/actions/settings/definirServidorMcpExterno";
import {
  listarFerramentasMcpExternas,
  type ResultadoDaListagem,
} from "@/app/actions/settings/listarFerramentasMcpExternas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

/** Todo motivo de recusa que as DUAS actions sabem devolver. */
type CodigoDeRecusa =
  | Extract<ResultadoRegistroDeServidorMcp, { ok: false }>["error"]
  | Extract<ResultadoDaListagem, { ok: false }>["error"];

/**
 * A frase de CADA recusa, em português — a chave de tradução é o próprio texto
 * (`lib/i18n/dicionario.ts`).
 *
 * Uma frase por código, e não "Não deu para salvar" para todos, porque os
 * motivos levam a consertos diferentes: `endpoint_inseguro` é o operador
 * trocando o endereço, `forbidden_role` é ele chamando quem é o dono, e
 * `mfa_required` é ele informando o código (a tela leva ao desafio). Um texto genérico mandaria os três
 * tentarem de novo — o único que não conserta nenhum dos três.
 */
export const MENSAGEM_DA_RECUSA: Record<CodigoDeRecusa, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo para continuar.",
  forbidden_role: "Só o dono da instalação cadastra o servidor externo desta empresa.",
  forbidden_tenant: "Não foi possível identificar a empresa ativa desta sessão.",
  mfa_required: "Esta ação exige a verificação em duas etapas.",
  validation_failed: "Confira o endereço e a chave: um dos dois passou do tamanho aceito.",
  endpoint_inseguro:
    "Endereço recusado por segurança: informe um servidor público em https, sem rede interna, sem localhost e sem segredo colado no endereço.",
  upstream_unavailable: "Não foi possível falar com o servidor.",
  erro_ao_gravar: "Não foi possível salvar. Tente de novo em instantes.",
  sem_servidor:
    "Nenhum servidor externo respondeu. Salve o endereço e a chave e teste de novo.",
};

interface FerramentaAnunciada {
  readonly nome: string;
  readonly descricao: string | null;
}

export function CadastroDoServidorMcpExterno() {
  const t = useT();
  const [endpoint, setEndpoint] = useState("");
  const [chave, setChave] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  /** O desfecho que deu certo (salvou, testou ou removeu). */
  const [aviso, setAviso] = useState<string | null>(null);
  /** Os quatro últimos caracteres — SÓ existem logo depois de salvar. */
  const [chaveCriada, setChaveCriada] = useState<string | null>(null);
  const [teste, setTeste] = useState<{ host: string; ferramentas: readonly FerramentaAnunciada[] } | null>(
    null,
  );
  const [pendente, iniciar] = useTransition();

  /** A recusa em frase; a do código leva ao desafio, que entrar de novo não traria. */
  function recusar(codigo: CodigoDeRecusa) {
    if (codigo === "mfa_required") irAoDesafioDeMfa();
    setErro(t(MENSAGEM_DA_RECUSA[codigo]));
  }

  /** Zera o retrato da rodada anterior — nenhuma frase antiga sobrevive a um clique. */
  function limparRetrato() {
    setErro(null);
    setAviso(null);
    setTeste(null);
    setChaveCriada(null);
  }

  function salvar() {
    limparRetrato();
    // Endereço OU chave vazios são o contrato de APAGAR da action — "Salvar"
    // com um dos dois em branco removeria o registro e anunciaria "salva".
    // Apagar tem botão próprio; aqui o vazio é recusa de formulário.
    if (endpoint.trim() === "" || chave.trim() === "") {
      setErro(t("Preencha o endereço e a chave para salvar. Para apagar o registro, use Remover."));
      return;
    }
    iniciar(async () => {
      const r = await definirServidorMcpExterno({ endpoint, chave });
      if (!r.ok) {
        recusar(r.error);
        return;
      }
      // A ÚNICA janela em que a chave é mostrada — e só o fim dela (ver o
      // cabeçalho). O campo é limpo no mesmo passo: deixar o texto ali faria a
      // chave sobreviver na tela sem que ninguém tenha pedido.
      setChaveCriada(r.chaveUltimos4);
      setChave("");
      setAviso(t("Configuração salva. Teste a conexão para ver o que o servidor oferece."));
    });
  }

  function remover() {
    limparRetrato();
    iniciar(async () => {
      // Endereço vazio é o contrato de APAGAR da action — a mesma porta do
      // salvar, com o mesmo gate de permissão e a mesma trilha de auditoria.
      const r = await definirServidorMcpExterno({ endpoint: "", chave: "" });
      if (!r.ok) {
        recusar(r.error);
        return;
      }
      setEndpoint("");
      setChave("");
      setAviso(t("Servidor externo removido. A IA desta empresa não alcança mais o sistema de fora."));
    });
  }

  function testar() {
    limparRetrato();
    iniciar(async () => {
      const r = await listarFerramentasMcpExternas();
      if (!r.ok) {
        recusar(r.error);
        return;
      }
      setTeste({
        host: r.host,
        ferramentas: r.ferramentas.map((f) => ({ nome: f.nome, descricao: f.descricao })),
      });
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Endereço e chave")}</CardTitle>
          <CardDescription>
            {t(
              "O endereço precisa ser um servidor público em https. Rede interna, localhost e segredo colado no endereço são recusados na hora de salvar.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-endpoint">{t("Endereço do servidor MCP")}</Label>
            <Input
              id="mcp-endpoint"
              data-testid="endpoint"
              placeholder="https://erp.example.com/mcp"
              value={endpoint}
              spellCheck={false}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-chave">{t("Chave de acesso")}</Label>
            <Input
              id="mcp-chave"
              data-testid="chave"
              type="password"
              value={chave}
              spellCheck={false}
              onChange={(e) => setChave(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "A chave é gravada cifrada e não é mostrada de novo: depois de salvar, a tela revela só os quatro últimos caracteres.",
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={salvar} disabled={pendente} data-testid="salvar">
              {pendente ? t("Salvando…") : t("Salvar")}
            </Button>
            <Button variant="outline" onClick={testar} disabled={pendente} data-testid="testar">
              {pendente ? t("Testando…") : t("Testar conexão")}
            </Button>
          </div>
          {/*
            A remoção fica SEPARADA do par acima e com a consequência escrita:
            "Remover" ao lado de "Salvar", sem uma linha explicando, é o botão
            que se aperta sem querer num formulário de credencial.
          */}
          <p className="text-xs text-muted-foreground">
            {t(
              "Remover apaga o endereço e a chave desta empresa: a IA deixa de alcançar o servidor de fora.",
            )}
          </p>
          <Button
            variant="ghost"
            className="w-fit text-destructive"
            onClick={remover}
            disabled={pendente}
            data-testid="remover"
          >
            {t("Remover")}
          </Button>
        </CardContent>
      </Card>

      {/* O bloco da chave: nasce do resultado do SALVAR e morre no clique seguinte. */}
      {chaveCriada ? (
        <p
          data-testid="chave-criada"
          role="status"
          className="rounded-md border border-border bg-muted/30 p-3 text-sm"
        >
          {t("Chave gravada. Ela aparece só agora, na criação — termina em")}{" "}
          <code className="font-semibold">{chaveCriada}</code>
        </p>
      ) : null}

      {aviso ? (
        <p data-testid="aviso" role="status" className="text-sm text-muted-foreground">
          {aviso}
        </p>
      ) : null}

      {erro ? (
        <p data-testid="erro" role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}

      {teste ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("O que o servidor oferece")}</CardTitle>
            <CardDescription>
              {t("O servidor respondeu com {n} ferramentas.").replace(
                "{n}",
                String(teste.ferramentas.length),
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {t("Endereço consultado:")} <code>{teste.host}</code>
            </p>
            {/*
              Nome e descrição vêm do SERVIDOR REMOTO: são dado de terceiro, não
              frase deste produto — por isso não passam por `t()`.
            */}
            <ul data-testid="ferramentas" className="flex flex-col gap-1 text-sm">
              {teste.ferramentas.map((f) => (
                <li key={f.nome} className="rounded-md border border-border px-3 py-2">
                  <code className="font-medium">{f.nome}</code>
                  {f.descricao ? (
                    <span className="ml-2 text-muted-foreground">{f.descricao}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

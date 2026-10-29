"use client";

/**
 * As ferramentas do servidor MCP externo que ESTE agente usa (#2147, item 6).
 *
 * O `tool_ids` já aceitava `mcp_externo:<leitura|escrita>:<nome>` desde o
 * cadastro do servidor, e a listagem para o editor já existia
 * (`listarFerramentasMcpExternas`), mas nenhuma tela as oferecia: quem
 * cadastrava o servidor via a ferramenta em Configurações e não tinha onde
 * ligá-la no agente. E o seletor do catálogo mostrava a remota salva como
 * "capacidade que não existe mais", com um botão que a apagava.
 *
 * A marca sai da própria opção: a ferramenta que o servidor DECLAROU só
 * leitura nasce `leitura` (o primeiro id que a listagem oferece); a que não
 * declarou só admite `escrita`, que o CRM recusa durante a conversa com o
 * cliente. Quem não confia na declaração do servidor simplesmente não liga.
 *
 * A listagem passa pela mesma regra do cadastro (dono da instalação): para
 * quem não é, o cartão não aparece — e as remotas já salvas atravessam o
 * formulário intactas, porque o seletor do catálogo nunca as recebe.
 */
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { listarFerramentasMcpExternas } from "@/app/actions/settings/listarFerramentasMcpExternas";
import { lerToolIdRemoto } from "@/lib/mcp/servidor-externo/ids";

interface Props {
  /** Só os ids remotos do `tool_ids` do formulário. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Vagas livres no teto de capacidades do agente, contando catálogo e remotas. */
  vagas: number;
  disabled?: boolean;
}

export function FerramentasDoServidorExterno({ value, onChange, vagas, disabled }: Props) {
  const t = useT();
  const query = useQuery({
    queryKey: ["mcp-externo", "ferramentas-do-editor"],
    queryFn: () => listarFerramentasMcpExternas(),
    staleTime: 60_000,
  });

  const nomesSalvos = new Map<string, string>();
  for (const id of value) {
    const escolha = lerToolIdRemoto(id);
    if (escolha) nomesSalvos.set(escolha.nome, id);
  }

  const resultado = query.data;
  if (query.isLoading || !resultado) return null;
  // Sem permissão para listar (não é o dono da instalação): nada a mostrar. As
  // remotas salvas continuam no `tool_ids`, fora do alcance deste cartão.
  if (!resultado.ok && resultado.error !== "sem_servidor") return null;
  const anunciadas = resultado.ok ? resultado.ferramentas : [];
  if (anunciadas.length === 0 && value.length === 0) return null;

  const porNome = new Set(anunciadas.map((f) => f.nome));
  const naoAnunciadas = [...nomesSalvos.keys()].filter((nome) => !porNome.has(nome));

  function alternar(nome: string, id: string | undefined, ligar: boolean) {
    const semEsta = value.filter((v) => lerToolIdRemoto(v)?.nome !== nome);
    onChange(ligar && id ? [...semEsta, id] : semEsta);
  }

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="ferramentas-do-servidor-externo">
      <h4 className="text-sm font-medium">{t("Ferramentas do servidor externo")}</h4>
      <p className="text-xs text-muted-foreground">
        {resultado.ok
          ? `${t("Consultas ao sistema cadastrado em Configurações › Servidor MCP externo")} (${resultado.host}).`
          : t("O servidor externo não respondeu agora. As ferramentas já ligadas continuam salvas.")}
      </p>
      <ul className="flex flex-col gap-2">
        {anunciadas.map((f) => {
          const ligada = nomesSalvos.has(f.nome);
          const semVaga = !ligada && vagas <= 0;
          const idSwitch = `mcp-externo-${f.nome}`;
          return (
            <li key={f.nome} className="flex items-start gap-3 rounded-md border border-border p-3">
              <Switch
                id={idSwitch}
                checked={ligada}
                onCheckedChange={(v) => alternar(f.nome, f.ids[0], v)}
                disabled={disabled || semVaga}
                aria-label={f.nome}
              />
              <label htmlFor={idSwitch} className="flex flex-col gap-1 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <code className="font-medium">{f.nome}</code>
                  <Badge variant={f.declaradaLeitura ? "secondary" : "outline"}>
                    {f.declaradaLeitura ? t("Só leitura") : t("Escrita")}
                  </Badge>
                </span>
                {/* Descrição vem do servidor remoto: dado de terceiro, sem `t()`. */}
                {f.descricao ? <span className="text-muted-foreground">{f.descricao}</span> : null}
                {f.declaradaLeitura ? null : (
                  <span className="text-xs text-muted-foreground">
                    {t("O servidor não declarou esta ferramenta como só leitura: durante a conversa com o cliente, o CRM recusa usá-la.")}
                  </span>
                )}
              </label>
            </li>
          );
        })}
        {naoAnunciadas.map((nome) => (
          <li
            key={nome}
            className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border p-3 text-sm"
          >
            <span>
              <code className="font-medium">{nome}</code>{" "}
              <span className="text-muted-foreground">
                {resultado.ok
                  ? t("ligada, mas o servidor não oferece mais esta ferramenta.")
                  : t("ligada.")}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => alternar(nome, undefined, false)}
            >
              {t("Desligar")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { marcarTesteFeito, pularTeste } from "@/app/actions/onboarding/marcarTeste";

interface Props {
  nome: string | null;
  agenteId: string | null;
  versaoId: string | null;
}

/** O que o ensaio devolveu — ou por que ele não aconteceu. */
type Desfecho =
  | { tipo: "resposta"; texto: string }
  | { tipo: "erro"; mensagem: string };

const EXEMPLO = "Oi! Vocês atendem hoje? Queria saber o preço.";

export function TestarClient({ nome, agenteId, versaoId }: Props) {
  const [mensagem, setMensagem] = useState(EXEMPLO);
  const [desfecho, setDesfecho] = useState<Desfecho | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [pending, startTransition] = useTransition();

  const funcionario = nome ?? "seu funcionário";

  // Três estados possíveis, e nenhum deles pode virar uma tela vazia: sem
  // agente (a pessoa pulou o treinamento), agente em rascunho (não tem versão
  // publicada, então não há o que executar), e o caso normal.
  const semAgente = !agenteId;
  const rascunho = Boolean(agenteId) && !versaoId;

  async function ensaiar() {
    if (!agenteId || !versaoId) return;
    setCarregando(true);
    setDesfecho(null);
    try {
      const res = await fetch(`/api/v1/ai/agents/${agenteId}/versions/${versaoId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sample_message: mensagem }),
      });
      const json = (await res.json()) as {
        data?: { final_text?: string; status?: string; error_code?: string; error_message?: string };
        error?: { message?: string };
      };
      if (!res.ok) {
        // A causa crua importa: quem instalou numa VPS é quem vai consertar, e
        // "não foi possível testar" não diz se falta chave, saldo ou modelo.
        setDesfecho({
          tipo: "erro",
          mensagem: json.error?.message ?? `O ensaio falhou (HTTP ${res.status}).`,
        });
        return;
      }
      // O ensaio responde 200 mesmo quando o turno FALHA — o resultado traz o
      // status. Ler só o texto e concluir "executou e não devolveu nada" foi o
      // que a tela fez no primeiro percurso real, enquanto a causa verdadeira
      // era outra: a versão não tinha credencial. Mentir sobre a causa manda a
      // pessoa procurar no lugar errado.
      const d = json.data;
      if (d?.status && d.status !== "completed") {
        setDesfecho({
          tipo: "erro",
          mensagem: d.error_message ?? d.error_code ?? `o ensaio terminou como "${d.status}"`,
        });
        return;
      }
      const texto = d?.final_text?.trim();
      setDesfecho(
        texto
          ? { tipo: "resposta", texto }
          : { tipo: "erro", mensagem: "Ele executou, mas não devolveu texto nenhum." },
      );
    } catch (err) {
      setDesfecho({ tipo: "erro", mensagem: err instanceof Error ? err.message : String(err) });
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="space-y-4">
      {semAgente && (
        <div className="rounded-lg border bg-background p-6" role="status">
          <p className="text-sm font-medium">Você ainda não montou seu funcionário.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Sem ninguém treinado, não há o que testar. Dá para voltar ao passo anterior
            agora ou fazer isso depois, em IA › Agentes.
          </p>
        </div>
      )}

      {rascunho && (
        <div className="rounded-lg border bg-background p-6" role="status">
          <p className="text-sm font-medium">
            {funcionario} está como <strong>rascunho</strong> — ainda não foi para o ar.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Rascunho não responde mensagem, então não há o que ensaiar. O passo anterior
            explicou o que falta; você pode resolver depois em IA › Agentes.
          </p>
        </div>
      )}

      {!semAgente && !rascunho && (
        <div className="space-y-4 rounded-lg border bg-background p-6">
          <div className="space-y-2">
            <Label htmlFor="mensagem">Escreva como se fosse um cliente</Label>
            <Textarea
              id="mensagem"
              value={mensagem}
              onChange={(e) => setMensagem(e.target.value)}
              rows={3}
              maxLength={4000}
            />
          </div>
          <div className="flex sm:justify-end">
            <Button
              type="button"
              onClick={ensaiar}
              disabled={carregando || mensagem.trim() === ""}
              className="w-full sm:w-auto"
            >
              {carregando ? "Ele está pensando..." : "Mandar mensagem"}
            </Button>
          </div>

          {desfecho?.tipo === "resposta" && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {funcionario} respondeu
              </p>
              <p className="whitespace-pre-wrap text-sm">{desfecho.texto}</p>
              <p className="text-xs text-muted-foreground">
                Esta conversa não foi enviada a ninguém e não aparece no seu inbox.
              </p>
            </div>
          )}

          {desfecho?.tipo === "erro" && (
            <div
              role="alert"
              className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-950/20"
            >
              <p className="text-sm font-medium">
                Ele não conseguiu responder — e é melhor descobrir isso agora do que com
                um cliente de verdade.
              </p>
              <p className="text-xs text-muted-foreground">
                Motivo: <code className="break-all">{desfecho.mensagem}</code>
              </p>
              <p className="text-sm">
                As causas mais comuns são a chave da empresa de IA sem saldo ou o modelo
                indisponível. Dá para conferir em <strong>IA › Credenciais</strong> e seguir
                daqui mesmo — o que você montou está salvo.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => startTransition(() => void pularTeste())}
        >
          Pular
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              // `respondeu` guarda a diferença entre "vi funcionando" e "passei
              // por aqui" — é o que o resumo final usa para não dizer que está
              // tudo certo quando ninguém viu nada.
              //
              // A action redireciona no servidor (o `redirect` do Next lança),
              // então só chega aqui quem falhou antes disso.
              try {
                await marcarTesteFeito(desfecho?.tipo === "resposta");
              } catch (err) {
                if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT")) throw err;
                toast.error("Não consegui salvar este passo.");
              }
            })
          }
        >
          Continuar
        </Button>
      </div>
    </div>
  );
}

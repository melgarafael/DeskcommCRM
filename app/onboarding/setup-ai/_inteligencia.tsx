"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { salvarChaveDaIa } from "@/app/actions/onboarding/chaveDaIa";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";

/**
 * "O CÉREBRO DELE" — a chave, medida e testada onde ela passa a importar.
 *
 * Duas coisas que o wizard não fazia e que custam caro no primeiro dia:
 *
 * 1. **Sem chave, era um beco.** O passo 1 mede e escreve "Falta a chave da
 *    inteligência artificial" — diagnóstico certo, saída nenhuma. Aqui a pessoa
 *    cola a chave no lugar onde ela é usada, um clique antes de o funcionário
 *    nascer com ela.
 *
 * 2. **"Validada" nunca significou "funciona".** O validador de chave bate num
 *    endpoint de LISTAGEM, que responde 200 com a conta zerada — então o selo
 *    verde prova que a chave existe, nunca que ela vai gerar uma resposta. Quem
 *    instalava, via "Validada" e recebia erro na primeira conversa não tinha
 *    onde olhar. A única coisa que prova saldo é uma geração, e é isso que
 *    `?provar=1` faz.
 *
 * ⚠️ A PROVA RODA NO CLIENTE, DEPOIS DE MONTAR — não no render do servidor. Ela
 * é uma ida ao provedor com timeout de 8 segundos: no render, o passo inteiro
 * ficaria em branco esperando por ela, e uma tela lenta é o que se lê como
 * produto quebrado.
 */
export interface EstadoDaChave {
  origem: "org" | "instalacao" | "nenhuma";
  provedor: string;
  rotulo: string;
  /** Só os últimos dígitos — o resto nunca sai do banco cifrado. */
  final: string | null;
}

type Prova =
  | { estado: "conferindo" }
  | { estado: "ok" }
  | { estado: "problema"; mensagem: string }
  | { estado: "nao_deu" };

export function InteligenciaDele({ inicial }: { inicial: EstadoDaChave }) {
  const t = useT();
  const [chave, setChave] = useState(inicial);
  const [prova, setProva] = useState<Prova | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [provedor, setProvedor] = useState(inicial.provedor);

  const temChave = chave.origem !== "nenhuma";

  useEffect(() => {
    if (!temChave) return;
    let vivo = true;
    let tentativas = 0;

    async function conferir(): Promise<void> {
      setProva({ estado: "conferindo" });
      try {
        const r = await fetch("/api/v1/system/instalacao?provar=1");
        const corpo = r.ok ? await r.json() : null;
        if (!vivo) return;
        const p = corpo?.data?.prova as
          | { feita: boolean; ok?: boolean; mensagem?: string; aindaVerificando?: boolean }
          | undefined;

        // A chave recém-colada ainda está sendo validada em segundo plano, e
        // `loadCredential` recusa credencial não validada. Medido percorrendo o
        // wizard: quem colava a chave e recebia a resposta no mesmo segundo lia
        // "não consegui testar o crédito" sobre uma chave que funcionava.
        // Esperar e perguntar de novo é a resposta certa — desistir na primeira
        // manda a pessoa desconfiar do que está correto.
        if (p?.aindaVerificando && tentativas < 4) {
          tentativas += 1;
          setTimeout(() => void (vivo && conferir()), 2000);
          return;
        }

        // "Não deu para conferir" é resposta distinta de "está com problema", e
        // colapsar as duas mandaria a pessoa trocar uma chave que está certa.
        if (!p || !p.feita) return setProva({ estado: "nao_deu" });
        if (p.ok) return setProva({ estado: "ok" });
        setProva({ estado: "problema", mensagem: p.mensagem ?? "" });
      } catch {
        if (vivo) setProva({ estado: "nao_deu" });
      }
    }

    void conferir();
    return () => {
      vivo = false;
    };
  }, [temChave]);

  if (!temChave) {
    return (
      <section className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-5">
        <div>
          <h3 className="text-sm font-medium">{t("Ele ainda não tem cérebro")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Seu funcionário pensa com a inteligência artificial que você contratar. A instalação não trouxe nenhuma chave — cole a sua aqui e ele já nasce funcionando.",
            )}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="provedor_da_ia">{t("Qual você contratou")}</Label>
            <select
              id="provedor_da_ia"
              value={provedor}
              onChange={(e) => setProvedor(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {PROVEDORES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.rotulo}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api_key_da_ia">{t("A chave")}</Label>
            <Input
              id="api_key_da_ia"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("Cole aqui a chave que a empresa de IA te deu")}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={salvando || apiKey.trim().length < 8}
            onClick={async () => {
              setSalvando(true);
              const fd = new FormData();
              fd.set("provider", provedor);
              fd.set("api_key", apiKey);
              const r = await salvarChaveDaIa(fd);
              setSalvando(false);
              if (!r.ok) return toast.error(r.erro);
              // A chave sai da memória da tela no mesmo instante em que é aceita.
              setApiKey("");
              setChave({
                origem: "org",
                provedor,
                rotulo: PROVEDORES.find((p) => p.id === provedor)?.rotulo ?? provedor,
                final: r.final,
              });
              toast.success(t("Chave guardada. Agora ele pode pensar."));
            }}
          >
            {salvando ? t("Guardando...") : t("Guardar a chave")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Ela é guardada cifrada — nem nós conseguimos lê-la depois.")}
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-1 rounded-lg border bg-background p-5">
      <h3 className="text-sm font-medium">
        {t("O cérebro dele:")} {chave.rotulo}
        {chave.final ? (
          <span className="ml-1 font-normal text-muted-foreground">
            ({t("final")} {chave.final})
          </span>
        ) : null}
      </h3>
      <p className="text-sm text-muted-foreground">
        {prova?.estado === "conferindo" && t("Conferindo se a chave tem crédito…")}
        {prova?.estado === "ok" && t("Testei agora: a chave respondeu e tem crédito.")}
        {prova?.estado === "problema" && (
          <>
            {t("A chave foi aceita, mas o teste não passou:")}{" "}
            <span className="text-amber-700 dark:text-amber-500">{prova.mensagem}</span>.{" "}
            {t(
              "Se for falta de crédito, adicione saldo na conta da empresa de IA — sem isso ele não responde a nenhum cliente.",
            )}
          </>
        )}
        {prova?.estado === "nao_deu" &&
          t(
            "Não consegui testar o crédito agora. Dá para seguir — mas confira o saldo na conta da empresa de IA antes de confiar nele.",
          )}
        {prova === null && t("Pronta para uso.")}
      </p>
    </section>
  );
}

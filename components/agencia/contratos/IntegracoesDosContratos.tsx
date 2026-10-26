"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { salvarIntegracoesDosContratos } from "@/app/actions/agencia/contratos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** ZapSign e InfinitePay em Configurações (docs/agencia/SPEC-contratos.md, K3). O token nunca volta para a tela. */
export function IntegracoesDosContratos({ inicial }: { inicial: { zapsign: boolean; sandbox: boolean; handle: string } }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [tirar, setTirar] = useState(false);
  const [sandbox, setSandbox] = useState(inicial.sandbox);
  const [handle, setHandle] = useState(inicial.handle);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();

  return (
    <section className="space-y-4 rounded-md border p-4" data-testid="integracoes-dos-contratos">
      <div className="space-y-1">
        <h2 className="font-semibold">Contratos: assinatura e pagamento</h2>
        <p className="text-sm text-muted-foreground">
          Opcional. Com a ZapSign e a InfinitePay ligadas, a central manda o contrato para assinar, gera o link de pagamento e percebe sozinha quando
          os dois acontecem. Sem elas, marque à mão na ficha do cliente.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="zapsign-token">Token da API da ZapSign</Label>
          <Input
            id="zapsign-token"
            type="password"
            autoComplete="off"
            placeholder={inicial.zapsign ? "Guardado — deixe em branco para manter" : "Cole o token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Na ZapSign: Configurações › Integração › Token de acesso.</p>
          {inicial.zapsign && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={tirar} onChange={(e) => setTirar(e.target.checked)} />
              Desligar a ZapSign
            </label>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
            Ambiente de testes da ZapSign (sandbox)
          </label>
        </div>
        <div className="space-y-1">
          <Label htmlFor="infinitepay-handle">InfiniteTag da InfinitePay</Label>
          <Input id="infinitepay-handle" placeholder="sua-empresa (sem o $)" value={handle} onChange={(e) => setHandle(e.target.value)} />
          <p className="text-xs text-muted-foreground">A mesma que aparece no app da InfinitePay. O link gerado é da primeira mensalidade.</p>
        </div>
      </div>
      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {msg.texto}
        </p>
      )}
      <Button
        type="button"
        disabled={pendente}
        onClick={() =>
          startTransition(async () => {
            const r = await salvarIntegracoesDosContratos({ zapsignToken: tirar ? "" : token ? token : null, zapsignSandbox: sandbox, infinitepayHandle: handle });
            if (!r.ok) return setMsg({ ok: false, texto: r.erro });
            setToken("");
            setTirar(false);
            setMsg({
              ok: true,
              texto: r.dados.webhookZapsign
                ? `Salvo. A ZapSign não aceitou o aviso automático: cadastre este endereço em Configurações › Integração › Webhooks — ${r.dados.webhookZapsign}`
                : "Salvo.",
            });
            router.refresh();
          })
        }
      >
        Salvar
      </Button>
    </section>
  );
}

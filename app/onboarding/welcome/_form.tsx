"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Cidade, não identificador de fuso. A lista mostrava "America/Bahia" e
 * "America/Fortaleza" e esperava que a pessoa soubesse em qual delas mora — o
 * identificador é do sistema, o que ela reconhece é a cidade.
 */
const FUSOS: { id: string; cidade: string }[] = [
  { id: "America/Sao_Paulo", cidade: "São Paulo, Rio, Brasília, Sul e Sudeste" },
  { id: "America/Recife", cidade: "Recife, Salvador, Fortaleza e Nordeste" },
  { id: "America/Belem", cidade: "Belém e Pará" },
  { id: "America/Manaus", cidade: "Manaus e Amazonas" },
  { id: "America/Cuiaba", cidade: "Cuiabá e Mato Grosso" },
  { id: "America/Rio_Branco", cidade: "Rio Branco e Acre" },
  { id: "America/Argentina/Buenos_Aires", cidade: "Buenos Aires" },
  { id: "Europe/Lisbon", cidade: "Lisboa" },
  { id: "Europe/Madrid", cidade: "Madri" },
  { id: "America/New_York", cidade: "Nova York" },
  { id: "America/Los_Angeles", cidade: "Los Angeles" },
  { id: "UTC", cidade: "Outro (horário universal)" },
];

export function WelcomeForm({ defaultOrgName }: { defaultOrgName: string }) {
  const [displayName, setDisplayName] = useState(defaultOrgName);
  const [oQueFaz, setOQueFaz] = useState("");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [accepted, setAccepted] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-5 rounded-lg border bg-background p-6"
      action={(formData) => {
        if (!accepted) {
          toast.error("Aceite os termos para continuar.");
          return;
        }
        startTransition(async () => {
          const res = await acceptWelcome(formData);
          if (res && !res.ok) {
            toast.error(`Falha: ${res.error}`);
          }
        });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="display_name">Como se chama o seu negócio?</Label>
        <Input
          id="display_name"
          name="display_name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          minLength={2}
          maxLength={120}
          required
        />
        <p className="text-xs text-muted-foreground">
          É o nome que aparece para o seu time e nos relatórios. Pode ser clínica,
          loja, escritório — o que for seu.
        </p>
      </div>

      {/*
        A pergunta que faltava no produto inteiro. Sem ela, o funcionário nasce
        se apresentando como atendente de uma "loja online" — era o que os três
        modelos de prompt diziam — e o quadro de clientes nasce com as colunas
        de e-commerce que o gatilho semeia. Os dois defeitos têm a mesma origem:
        uma instalação que nunca pergunta em que ramo entrou.
      */}
      <div className="space-y-2">
        <Label htmlFor="o_que_faz">O que vocês fazem?</Label>
        <Input
          id="o_que_faz"
          name="o_que_faz"
          value={oQueFaz}
          onChange={(e) => setOQueFaz(e.target.value)}
          maxLength={280}
          placeholder="Ex.: clínica odontológica, ou venda de roupa fitness pelo WhatsApp"
        />
        <p className="text-xs text-muted-foreground">
          Uma linha basta. É com isso que seu funcionário aprende com quem ele
          está falando — e que a gente monta o quadro de clientes do seu jeito.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="timezone">Onde você atende</Label>
        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger id="timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUSOS.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.cidade}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input type="hidden" name="timezone" value={timezone} />
        <p className="text-xs text-muted-foreground">
          Decide o horário em que seu funcionário pode falar com clientes.
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          className="mt-1"
          required
        />
        <span>
          Li e aceito os{" "}
          <a className="underline" href="/legal/terms" target="_blank" rel="noreferrer">
            Termos de Uso
          </a>{" "}
          e a{" "}
          <a className="underline" href="/legal/privacy" target="_blank" rel="noreferrer">
            Política de Privacidade
          </a>
          .
        </span>
      </label>

      <div className="flex sm:justify-end">
        <Button type="submit" disabled={pending || !accepted} className="w-full sm:w-auto">
          {pending ? "Salvando..." : "Continuar"}
        </Button>
      </div>
    </form>
  );
}

"use client";
import { AlertsBell } from "./AlertsBell";
import { AvisoDePropostaEmDestaque } from "./AvisoDePropostaEmDestaque";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";
import { BotaoDoPainelDoModulo, PainelDoModuloProvider } from "@/components/modulo/PainelDoModulo";

export function TopBar() {
  return (
    <PainelDoModuloProvider>
      <header className="sticky top-[var(--faixas-de-cima,0px)] z-20 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur md:gap-4 md:px-6" data-casca="topo">
        <div className="flex min-w-0 items-center gap-2">
          <MobileSidebar />
          <TenantSwitcher />
        </div>
        {/*
          A BUSCA NUNCA FICA COM 0 px DE COLUNA.

          Em 320px o grupo da direita (avisos + menu do usuário) ocupa 200px
          fixos e o da esquerda 92px: sobravam 0px para esta coluna, e o botão
          de 42px transbordava 13px sobre o seletor de organização e 13px
          sobre o sino (medido com `getBoundingClientRect`, issue #5096).
          `min-w-11` só abaixo de 360px: é o piso de largura que o botão
          precisa, e o desenho de 360px para cima continua idêntico.
        */}
        <div
          className="flex min-w-0 flex-1 justify-center max-[359px]:min-w-11 md:max-w-md"
          data-testid="topo-busca"
        >
          <SearchTrigger />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BotaoDoPainelDoModulo />
          <AlertsBell />
          <AvisoDePropostaEmDestaque />
          <UserMenu />
        </div>
      </header>
    </PainelDoModuloProvider>
  );
}

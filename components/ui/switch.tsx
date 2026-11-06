"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // O `::before` é a área de toque: com ponteiro grosso ela passa dos 20 px
      // desenhados a 44. Ele se ancora na caixa de PADDING (h-5 menos o
      // `border-2` = 16 px), e `-inset-3.5` soma 14 de cada lado: 16 + 28 = 44.
      // `pointer-coarse:my-3` dá a cada interruptor 44 px de passo vertical: numa
      // pilha densa (a lista de grupos tem um a cada 28 px) o `::before` do de
      // baixo, pintado depois, cobria a borda do de cima e roubava o toque. Com
      // 12 px de margem em cima e embaixo as áreas encostam sem se sobrepor.
      // Com mouse nada muda. Padrão de `components/contacts/ContactsTable.tsx`.
      "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-[''] pointer-coarse:my-3",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }

"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// `block` é LOAD-BEARING, e não estilo: `<label>` nasce `display: inline`, e
// elemento inline IGNORA margem vertical. Isso não custava nada no Tailwind 3 —
// lá o `space-y-*` punha `margin-top` no filho SEGUINTE (`> :not([hidden]) ~
// :not([hidden])`), e o rótulo, sendo o primeiro, nunca recebia margem. O
// Tailwind 4 inverteu o seletor para `:where(> :not(:last-child))` e passou a
// pôr `margin-bottom` no filho ANTERIOR — que é justamente o rótulo. A margem
// caía num elemento inline e evaporava.
//
// Sintoma medido na migração: todo grupo `space-y-2` de formulário encolhia
// exatamente 8px (`--space-2`), colando o rótulo no campo. Na tela de boas-vindas
// eram três grupos, 24px de página a menos, sem erro nenhum em lugar nenhum.
// Ver `tests/sonda-tailwind-4-antes-depois.ts` e o par em `evidence/tailwind-4/`.
//
// `inline-block` e não `block`, por duas medidas: o rótulo continua com largura
// shrink-to-fit (é o que `inline` dava, e `block` esticaria para a linha
// inteira), e a caixa do grupo fica a 4px do que o Tailwind 3 rendia, contra
// 10px do `block`. A diferença residual é o `leading-none` desta mesma classe
// finalmente valendo: enquanto o rótulo era `inline`, quem mandava na altura da
// linha era o strut do pai, e o token era ignorado. Fechar esses 4px exige tirar
// o `leading-none` — decisão de design, não de migração, e por isso não foi
// tomada aqui.
const labelVariants = cva(
  "inline-block text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants(), className)}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }

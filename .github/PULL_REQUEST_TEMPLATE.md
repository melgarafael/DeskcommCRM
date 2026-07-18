# O que este PR faz

<!-- 1-3 frases. Se resolve issue, referencie: Closes #123 -->

## Checklist (Definition of Done)

- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] Testes relevantes existem e passam (`pnpm test:unit` / `pnpm test:e2e`)
- [ ] RLS testada, se toca tabela tenant-aware
- [ ] Audit log emitido, se há mutação relevante
- [ ] Zod valida todo input externo novo
- [ ] Sem `console.log` esquecido
- [ ] Mudança de schema saiu como migration versionada + apêndice no `baseline.sql` + linha no MANIFEST
- [ ] Doc atualizada se mudou contrato (PRD/spec)

Convenções completas em [`CLAUDE.md`](../CLAUDE.md) · fluxo em [`CONTRIBUTING.md`](../CONTRIBUTING.md).

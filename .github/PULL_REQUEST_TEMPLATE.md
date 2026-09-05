<!--
  Se você está abrindo daqui de um FORK: você está no lugar certo.
  Três pessoas já fecharam PRs neste repositório dizendo "abri no repositório
  errado, desculpa o ruído" — e nenhuma tinha errado. PR de fork para cá é
  exatamente como se contribui. Não feche o seu; nós respondemos.
-->

# O que este PR faz

<!-- 1-3 frases, do ponto de vista de quem USA o sistema. Se resolve issue: Closes #123 -->

---

### 📌 Contribuindo de um fork? Você está no lugar certo.

**Duas coisas vão parecer erro seu e não são** — e nenhuma é motivo para fechar o PR:

- **`Vercel` vermelho** (`Authorization required to deploy`): esperado em PR de fork, porque a `main` faz deploy de produção. **Não entra no gate de merge.**
- **Workflows parados** esperando aprovação: política do GitHub no primeiro PR de quem nunca contribuiu. Um mantenedor libera.

<details>
<summary><b>E estas quatro são trabalho NOSSO — não se preocupe com elas</b></summary>

| | |
|---|---|
| **Fragmento em `.changes/`** | É o aviso que aparece na tela de quem opera uma VPS. Se faltar, **nós escrevemos**, com o seu nome. Não é cobrança. |
| **Numeração de migration** | Se colidir com um PR aberto que você não tinha como ver, **quem renumera somos nós**. |
| **Conflito com a `main`** | Resolvemos do nosso lado, preservando os seus commits. Você não refaz nada. |
| **Prova pela tela (`test:e2e`)** | Exige Docker, banco semeado e WAHA local. Fica com o mantenedor — exigir prova sem entregar a ferramenta de produzi-la seria pedágio, não rigor. |

</details>

---

## Checklist (Definition of Done)

<!-- Contribuindo de fora? Marque o que conseguiu; o resto é nosso. Nada aqui trava PR externo. -->

- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] Testes relevantes existem e passam (`pnpm test:unit`)
- [ ] RLS testada, se toca tabela tenant-aware
- [ ] Audit log emitido, se há mutação relevante
- [ ] Zod valida todo input externo novo
- [ ] Sem `console.log` esquecido
- [ ] Mudança de schema saiu como migration versionada + apêndice no `baseline.sql` + linha no MANIFEST
- [ ] Doc atualizada se mudou contrato (PRD/spec)

Convenções completas em [`CLAUDE.md`](../CLAUDE.md) · fluxo em [`CONTRIBUTING.md`](../CONTRIBUTING.md).

<sub>Seu trabalho aparece no seu perfil do GitHub? Se você commitou de um servidor, pode estar assinado como `root`, e o GitHub não associa isso à sua conta. `git config --global user.email "<e-mail da sua conta>"` resolve dali em diante — e se pedir, a gente corrige o histórico.</sub>

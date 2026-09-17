<!--
  Se você está abrindo daqui de um FORK: você está no lugar certo.
  Três pessoas já fecharam PRs neste repositório dizendo "abri no repositório
  errado, desculpa o ruído" — e nenhuma tinha errado. PR de fork para cá é
  exatamente como se contribui. Não feche o seu; nós respondemos.
-->

# O que este PR faz

<!-- 1-3 frases, do ponto de vista de quem USA o sistema. Se resolve issue: Closes #123 -->

<!-- Destino da mudança (opcional para quem contribui): núcleo, extensão, ambos ou
     infraestrutura/documentação. Diga por quê, se já souber. A triagem completa essa
     avaliação com você; não é necessário usar um SDK que ainda não foi entregue.
     Critério: triagem/TRIAGEM.md, passe 2-bis. -->

---

### 📌 Contribuindo de um fork? Você está no lugar certo.

**Uma coisa vai parecer erro seu e não é** — e ela não é motivo para fechar o PR:

- **Workflows parados** esperando aprovação: política do GitHub no primeiro PR de quem nunca contribuiu. Um mantenedor libera.

<details>
<summary><b>E estas quatro são trabalho NOSSO — não se preocupe com elas</b></summary>

| | |
|---|---|
| **Fragmento em `.changes/`** | É o aviso que aparece na tela de quem opera uma VPS. Se faltar, **nós escrevemos**, com o seu nome. Não é cobrança. |
| **Numeração de migration** | Se colidir com um PR aberto que você não tinha como ver, **quem renumera somos nós**. |
| **Conflito com a `main`** | Resolvemos nós, preservando os seus commits. Com "Allow edits by maintainers" ligado, o merge da `main` pode chegar na sua própria branch — avisamos no PR, e você só dá `git pull --no-rebase` antes do seu próximo push. Você não refaz nada. |
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

<sub>Seu trabalho aparece no seu perfil do GitHub? Se você commitou de um servidor, pode estar assinado como `root`, e o GitHub não associa isso à sua conta. `git config --global user.email "<e-mail da sua conta>"` resolve dali em diante — e se pedir, a gente associa os commits antigos à sua conta pelo `.mailmap`, sem reescrever nada.</sub>

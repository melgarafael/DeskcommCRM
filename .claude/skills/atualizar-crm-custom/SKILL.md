---
name: atualizar-crm-custom
description: 'Atualiza um fork do DeskcommCRM com o upstream oficial sem perder as customizações do fork, e leva a versão nova à VPS com backup, conferência e rollback. Use SEMPRE que pedirem para atualizar o CRM, "tem versão nova?", "o que mudou na última versão?", sincronizar com o upstream, mesclar uma release, fazer o deploy da atualização ou voltar uma atualização, mesmo sem dizer "skill". Confere o que assume do upstream antes de mexer em qualquer coisa.'
metadata:
  publico: dono de um fork do DeskcommCRM, operador de VPS
  alvo: sync com o upstream preservando customizações; deploy por imagens publicadas
---

# Atualizar um fork do DeskcommCRM

Traz as releases do upstream (`melgarafael/DeskcommCRM`) para o fork **sem perder o que é do fork**, e leva a versão nova à VPS. Vale para qualquer fork e qualquer versão: nada aqui fixa número de versão, cliente ou domínio. O que é da sua instalação (ssh, pasta, domínio, checagens próprias) fica em `.astra/local/`, fora do git: o fork é público.

## Antes de tudo

1. **Config da instância.** Primeira vez: `references/instancia.md` (2 minutos). Sem ela o modo avaliação ainda funciona, mas a VPS não é consultada.
2. **Contrato.** Rode `bash .agents/skills/atualizar-crm-custom/scripts/checar-contrato.sh --ref upstream/main`. Ele confere que o upstream ainda tem o que esta skill assume (funções do kit, compose, formato do CHANGELOG, rótulo da imagem). Reprovou: **pare** e siga `references/contrato-com-upstream.md`. Descobrir isso agora custa um minuto; descobrir no meio do deploy, uma noite.

## Onde cada coisa roda

- **Máquina de trabalho** (clone do fork, `gh` logado, **sem `.env`**): Checkpoints 1 e 2 e o push. A VPS não é lugar de merge nem de suíte de testes: a pasta do projeto lá é produção, o `.env` dela é real (os testes o carregam) e a suíte disputa CPU com o CRM no ar.
- **GitHub Actions**: a prova dos testes e o build das imagens.
- **VPS**: só o Checkpoint 3, chamado da máquina de trabalho por `.agents/skills/atualizar-crm-custom/scripts/na-vps.sh`, que leva a config e as verificações da instância junto.

## Regras de ouro (cada uma já derrubaria ou escondeu um problema)

1. **Nunca `docker compose -f …` cru na VPS.** Use `dc`, o helper do kit (`source hostgator-setup-kit/_common.sh && enter_project && dc …`): ele monta os arquivos certos para o modo da instalação (single-server, proxy). Sem ele, app e worker podem voltar sem enxergar o banco ou o proxy.
2. **Tag móvel + política de pull `missing` = `up -d` não puxa nada.** Imagem nova só chega com `dc pull` explícito.
3. **Sem "foto" não há volta.** Depois do pull a imagem antiga perde o nome. Sempre `na-vps.sh antes` primeiro.
4. **Nada vai para a `main` antes da custódia e do CI verde.** A `main` dispara o build das imagens de produção.
5. **`SUPABASE_REF` mudou? Pare.** O deploy manual desta skill **não** atualiza o Supabase da VPS (só o `update.sh` do kit faz isso). Decida com o dono antes.
6. **Nunca imprima `.env` nem chaves.** Os scripts já não imprimem; ao diagnosticar, filtre as linhas.
7. **Nada de cliente ou segredo no git.** Arme o guarda uma vez: `bash .agents/skills/atualizar-crm-custom/scripts/guardar-vazamento.sh --instalar`.

## Modos

1. **Avaliação** ("o que mudou?", "tem versão nova?"): só o Checkpoint 1. **Não altera branch nem VPS.**
2. **Atualização:** um "sim" no Checkpoint 1 libera o Checkpoint 2; o Checkpoint 3 pede **outro** "sim" (é ele que mexe na produção). Qualquer falha **pausa** e traz o diagnóstico.

```
Checkpoint 1: checar-novidades ─► autoriza? ─ não ─► encerra
        │ sim
Checkpoint 2: branch sync + merge da TAG ─► custodia.sh (leve) ─► PR + CI verde (os testes rodam aqui) ─► autoriza o merge? ─► main ─► build das imagens
        │
Checkpoint 3 (autorização própria): antes ─► código ─► proxy ─► banco ─► pull + up ─► depois ─ falhou ─► rollback
```

## Checkpoint 1: o que há de novo (só leitura)

```bash
bash .agents/skills/atualizar-crm-custom/scripts/checar-novidades.sh
```

Lê a **versão que roda de verdade** (commit carimbado na imagem do app na VPS) e a **última release estável** do upstream, e imprime o CHANGELOG do intervalo com a seção **Requer atenção** na íntegra, mais: migrations novas, mudança do `SUPABASE_REF`, arquivos de infra que o upstream mexeu e o que o fork customiza.

**Apresente ao dono, em português curto:**
1. Versão instalada → versão alvo.
2. Cada item **Requer atenção**, traduzido para a realidade **desta** instalação: "isso se aplica a nós?". Confira no banco ou na tela antes de afirmar; não adivinhe.
3. Banco: há migration ou baseline? (vira o passo 4 do Checkpoint 3).
4. `SUPABASE_REF` mudou? (regra 5) e arquivos de infra mexidos (conflito provável).
5. A pergunta: *"Prepara a atualização para vX.Y.Z na branch de sincronização?"* Se não, encerre.

## Checkpoint 2: branch de sincronização, merge e custódia

1. **Branch isolada, mesclando a TAG da release** (não o topo da `main` do upstream):
   ```bash
   git checkout main && git pull --ff-only origin main
   git checkout -b sync/upstream-vX.Y.Z
   git merge vX.Y.Z          # a tag que o Checkpoint 1 mostrou
   ```
2. **Conflitos:** preserve o que é do fork. A lista do que é do fork **não está escrita aqui**: sai do git (`checar-novidades.sh`, seção de customizações). Como resolver cada tipo: `references/conflitos.md`.
3. **Custódia leve, local** (sem `pnpm install`, sem testes):
   ```bash
   bash .agents/skills/atualizar-crm-custom/scripts/custodia.sh --alvo vX.Y.Z
   ```
   Confere se cada arquivo e cada linha que o fork acrescentou sobreviveram ao merge, e roda as checagens de `custodia.d/` da instância. É rápida e quase não usa memória. **O código de saída é a autoridade.** **Não rode `--testes` por padrão:** `test:unit` percorre o repositório inteiro (500+ arquivos) e já travou a máquina do dono por falta de RAM. Typecheck, lint, `test:unit`, `invariants` e o build são provados pelo CI do passo 4, que é a prova que vale. Só rode `--testes` local se o dono pedir, ou se o CI do fork não rodar (diga isso explicitamente) — e então depois de `pnpm install --frozen-lockfile`, de preferência rodando `pnpm vitest run --maxWorkers=2` à mão em vez do gate completo.
4. **PR e CI antes da `main`:** `git push -u origin sync/upstream-vX.Y.Z`, `gh pr create --base main`, `gh pr checks --watch`. Verde = pode pedir autorização. Falhou: pare na branch de sync e traga o diagnóstico. Se um teste do upstream vigia uma customização do fork, ajuste o teste, não a customização, e registre em `.astra/README.md`. O push publica a branch, então peça o aval do dono antes.
5. **Autorização do merge:** *"Custódia OK e CI verde. Autoriza mesclar na `main`? Isso dispara o build das imagens de produção."* Ao receber: `gh pr merge --merge`.
6. **Build das imagens:** `gh run list --workflow=publish-image.yml --limit 1` até `completed success`. Reporte ao dono.

## Checkpoint 3: deploy na VPS (autorização própria)

Pergunte: *"As imagens foram publicadas. Autoriza atualizar a VPS agora? Haverá uma parada curta do CRM."* Depois, o roteiro de `references/deploy-vps.md`, passo a passo e em ordem. O núcleo:

```bash
bash .agents/skills/atualizar-crm-custom/scripts/na-vps.sh antes            # backup + foto (anote FOTO=…)
# …código novo, proxy, banco (só se houve migration), pull + up: ver o roteiro…
bash .agents/skills/atualizar-crm-custom/scripts/na-vps.sh depois <foto>    # tudo verde = concluído
```

## O que NÃO fazer

- Não rode o `update.sh` nem o botão "Atualizar" da tela num fork que não publica releases e imagens próprias: eles puxariam o código do upstream sem as suas customizações (o porquê e como adotá-lo no futuro: `references/contrato-com-upstream.md`).
- Não faça push na `main` com custódia reprovada ou sem CI verde.
- Não pule o `antes`; não rode `docker image prune` antes de 24 h estável.
- Não aceite "a imagem subiu" como prova: a prova é o `depois` todo verde.
- Não guarde dado de cliente, domínio ou chave em arquivo versionado.

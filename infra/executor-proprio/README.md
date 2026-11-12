# Executor próprio do CI

Uma máquina nossa que roda os jobs pesados do trabalho **nosso** — push na `main` e PR de
branch deste repositório — para a fila do GitHub ficar para quem contribui de fora.

Não muda nada até a variável de repositório `EXECUTOR_PROPRIO` valer `ligado`
(Settings → Secrets and variables → Actions → Variables). Apagar a variável é o botão de
emergência: os jobs novos voltam na hora para as máquinas do GitHub.

## Peças

| arquivo | o que é |
|---|---|
| `instalar.sh` | instala Docker + Sysbox numa Ubuntu 24.04 amd64 dedicada, pede o token, liga as vagas e a atualização semanal |
| `vaga.sh` | uma vaga: pede ao GitHub um runner JIT (um job, uso único), roda um contêiner limpo com ele, repete |
| `Dockerfile` | a imagem da vaga — o que os jobs pressupõem do `ubuntu-latest` |
| `entrypoint.sh` | sobe o Docker de dentro da vaga e entrega ao runner |
| `so-o-que-e-nosso.sh` | a guarda de entrada: recusa todo job que não seja nosso, antes do primeiro passo |
| `limpa-depois.sh` | o gancho de saída dos runners persistentes da VPS (abaixo): limpa o que o job deixou no Docker do host |

## Por que a guarda mora aqui

O repositório é público, e num `pull_request` de fork o GitHub roda o workflow **do fork** — que
pode reescrever `runs-on:` para mirar esta máquina. A expressão de `runs-on` dos nossos workflows
só decide para quem não a edita. A guarda é gravada na imagem e registrada como
`ACTIONS_RUNNER_HOOK_JOB_STARTED`; script de entrada que falha faz o job não rodar.

Aceita: `push`, `workflow_dispatch`, `schedule`, `merge_group`, e `pull_request` cuja branch mora
neste repositório. Recusa o resto, inclusive `pull_request_target` e payload ilegível.

Também recusa ator cujo login termina em `[bot]`: o dependabot abre PR com branch **deste**
repositório, e sem essa regra rodaria atualização de dependência com o Docker do host.

## Runners persistentes da VPS (`deskcomm-vps`)

Desde 12/11/2026 há um segundo executor, mais simples que as vagas: dois runners comuns
(`vps-devops-1` e `-2`, rótulos `self-hosted, Linux, X64, deskcomm-vps`) numa VPS AlmaLinux 9,
rodando como o usuário `gh-runner` (grupo `docker`, sem sudo). Só a matriz `invariants-majors` do
`ci.yml` vai para lá, e só com a variável de repositório `RUNNER_PROPRIO=ligado`.

**Desligar a rota, sem PR:** `gh variable set RUNNER_PROPRIO --body desligado`. Vale para os jobs
novos; os que já estão na fila do runner próprio têm de ser cancelados e reexecutados.

Os dois ganchos deste diretório são instalados pelo root, fora do alcance do `gh-runner`:

```bash
install -d -m 755 /opt/deskcomm
install -m 755 -o root -g root so-o-que-e-nosso.sh limpa-depois.sh /opt/deskcomm/
for r in 1 2; do
  cat >> /home/gh-runner/runner-$r/.env <<'ENV'
ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/deskcomm/so-o-que-e-nosso.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/deskcomm/limpa-depois.sh
ENV
  # O `.env` é o que liga os ganchos: o runner não pode reescrevê-lo.
  chown root:root /home/gh-runner/runner-$r/.env
  chmod 644 /home/gh-runner/runner-$r/.env
  systemctl restart actions.runner.melgarafael-DeskcommCRM.vps-devops-$r.service
done
```

Os scripts (`root:root 755`) e o `.env` (`root:root 644`) ficam fora do alcance de escrita do
`gh-runner` **pelo sistema de arquivos**. Isso não resiste a quem tem o Docker do host (ver os
riscos abaixo): é proteção contra engano e contra código de fora, não contra job nosso hostil.

| gancho | quando | o que faz |
|---|---|---|
| `so-o-que-e-nosso.sh` | antes do primeiro passo | recusa fork, bot, outro repositório e evento fora da lista; recusado, o job não roda |
| `limpa-depois.sh` | depois do job, mesmo cancelado | remove os contêineres com `deskcomm.worktree=$GITHUB_WORKSPACE` (o rótulo que `scripts/test-db.sh` e `scripts/test-update-com-dados.sh` gravam), contêineres parados há mais de 6 h, volumes sem dono, e esvazia o `RUNNER_TEMP` |

A limpeza é pelo checkout, e não por run/job, porque as duas pernas da matriz têm o mesmo
`GITHUB_RUN_ID` e o mesmo `GITHUB_JOB` e rodam juntas, uma em cada runner: um rótulo por run/job
faria a primeira a terminar apagar o Postgres da outra. O checkout é de um runner só, e cada
runner roda um job por vez.

Pacotes que os jobs pressupõem: Docker, `git`, `jq` (da guarda), `curl`, `tar`. `psql` não: o
`test:db` usa o `psql` de dentro do contêiner.

**Riscos conhecidos**

- **O gancho impede que código de FORA (fork, bot) rode no host. Não protege o host de um job
  NOSSO.** O `gh-runner` está no grupo `docker`, o que na prática equivale a root no host: um job
  nosso — ou uma dependência comprometida num PR nosso — pode montar `/` num contêiner, reescrever
  os ganchos e o `.env` e deixar persistência para os jobs seguintes, a `main` inclusive. Aceito
  porque só a equipe abre PR com branch deste repositório. O `HOME` no `RUNNER_TEMP` só tira o
  caminho acidental (cache e pnpm gravados no HOME e lidos pelo job seguinte); não é barreira.
  Próximos passos, **não feitos**: runner efêmero (JIT, um por job, como o `vaga.sh` daqui), Docker
  sem root (rootless) para o `gh-runner`, ou levar estes jobs para o desenho de vaga em contêiner
  descartável que este diretório já descreve.
- Sem o `gh` na VPS, o `scripts/conferir-isolamento-do-kit.sh` pergunta a última release à API
  anônima, com teto de 60 consultas/hora por IP, e os dois runners saem pelo mesmo IP. Instalar o
  binário `gh` não põe segredo no host: ele usaria o `GH_TOKEN` que o próprio job passa.
- Se os dois runners caírem, as pernas roteadas para eles esperam na fila (até ~24h) em vez de
  falhar, e o check `invariants` espera junto. O botão é a variável acima.

## Por que uma vaga por contêiner (Sysbox)

O `e2e` sobe o Supabase em portas fixas (54321/54322) e o teste de imagem usa `:3000` e nomes fixos
de contêiner: dois jobs no mesmo Docker colidem. Cada vaga tem o próprio Docker e a própria rede,
sem `--privileged`, e o contêiner é descartado ao fim do job.

## Tamanho

Uma vaga = 4 núcleos e 14 GB, como o `ubuntu-latest`. Medido em 15–18/09/2026: o trabalho nosso
ocupava ~5 jobs em média e mais de 10 em 17% do tempo (sob o teto de 20 da época, então a demanda
real é maior). 8 vagas cobrem os picos.

## Operação

```bash
journalctl -u deskcomm-vaga@1 -f                          # log de uma vaga
sudo bash /opt/deskcomm-executor/instalar.sh atualizar    # reconstrói a imagem agora
systemctl list-timers deskcomm-executor-atualizar.timer   # próxima atualização automática
```

Vigiado por `tests/unit/executor-proprio-so-roda-o-que-e-nosso.test.ts`.

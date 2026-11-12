import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  catalogoCli,
  encerrarProcessoProprio,
  iniciarServidor,
} from "./catalogo-extensoes";

/**
 * O catálogo de ENSAIO do módulo conectado (Spec 33): um pacote `connected` que pede as áreas
 * `tarefas` (leitura e escrita) e `conversas` (leitura), servido pelo MESMO processo do laboratório
 * (`catalog.py serve --modulo-de-ensaio`), que também serve o `/embed` do módulo.
 *
 * Por que o mesmo processo: a política do host só aceita `http` em loopback quando a origem do serviço
 * é a do catálogo de laboratório (`EXTENSIONS_LOCAL_CATALOG_ORIGIN`). Um segundo processo em outra
 * porta seria recusado como origem de serviço. Consequência para a prova do "serviço fora do ar":
 * parar o serviço é parar este processo, o que só se faz DEPOIS da instalação (o catálogo já foi
 * admitido e o pacote já foi baixado).
 *
 * Nenhum segredo mora aqui nem no laboratório. O segredo da instalação nasce no CRM (botão "Gerar
 * segredo", que a prova aciona pela tela) e a prova o entrega, uma vez, a `POST /ensaio/configurar`;
 * o serviço o guarda só na memória do processo. Esta fixture nunca o devolve, o registra ou o grava.
 */

const ORIGEM_CATALOGO = "http://127.0.0.1:56331";

export interface CatalogoDoModuloConectado {
  diretorio: string;
  /** O JSON exportado, o que a tela de admissão recebe. */
  catalogo: string;
  origem: string;
  pacote: {
    publisher: string;
    name: string;
    version: string;
    title: string;
    /** `${publisher}-${name}`: o que vai depois de `/app/m/`. */
    slug: string;
  };
  /** Entrega ao serviço de ensaio onde fica o CRM, qual é a instalação e o segredo que a tela gerou. */
  configurarServico(dados: {
    hostOrigin: string;
    installationId: string;
    segredo: string;
  }): Promise<void>;
  estaLigado(): boolean;
  desligar(): Promise<void>;
  limpar(): Promise<void>;
}

export async function criarCatalogoDoModuloConectado(
  db: SupabaseClient,
): Promise<CatalogoDoModuloConectado> {
  const { data: atual, error: erroAtual } = await db
    .from("extension_catalogs")
    .select("revision")
    .eq("origin", ORIGEM_CATALOGO)
    .maybeSingle();
  if (erroAtual) throw new Error(erroAtual.message);
  const revisaoAtual = (atual?.revision as number | undefined) ?? 0;

  const diretorio = await mkdtemp(path.join(tmpdir(), "deskcomm-extensions-e2e-"));
  let servidor: Awaited<ReturnType<typeof iniciarServidor>> | undefined;
  try {
    const banco = path.join(diretorio, "catalog.sqlite");
    const manifesto = path.join(diretorio, "modulo-de-ensaio.json");
    const sufixo = randomUUID().replaceAll("-", "").slice(0, 10);
    const publisher = "lab";
    const name = `modulo-de-ensaio-${sufixo}`;
    const title = `Módulo de ensaio ${sufixo}`;

    await catalogoCli(["init", "--db", banco, "--origin", ORIGEM_CATALOGO]);
    await writeFile(
      manifesto,
      JSON.stringify({
        format_version: 1,
        profile: "connected",
        publisher,
        name,
        version: "1.0.0",
        license: "MIT",
        host_api: { min: 2, max: 2 },
        permissions: ["area.tarefas.leitura", "area.tarefas.escrita", "area.conversas.leitura"],
        dependencies: [],
        data: { mode: "none" },
        display: {
          title: { "pt-BR": title },
          summary: { "pt-BR": "Serviço de ensaio da prova em tela do módulo conectado." },
          category: "productivity",
          icon: "ListChecks",
        },
        configuration: {},
        contributions: {},
      }),
      "utf8",
    );
    await catalogoCli([
      "publish",
      "--db",
      banco,
      "--manifest",
      manifesto,
      "--service-origin",
      ORIGEM_CATALOGO,
    ]);

    // A revisão exportada precisa suceder a do catálogo que o CRM já admitiu para esta origem
    // (outra spec pode ter admitido uma antes): exporta-se uma vez por revisão até passar dela.
    let catalogo = "";
    for (let revisao = 1; revisao <= revisaoAtual + 1; revisao += 1) {
      catalogo = path.join(diretorio, `catalog-revision-${revisao}.json`);
      await catalogoCli(["export", "--db", banco, "--output", catalogo]);
    }
    const snapshot = JSON.parse(await readFile(catalogo, "utf8")) as { revision: number };
    if (snapshot.revision !== revisaoAtual + 1) {
      throw new Error("A revisão exportada não sucede o catálogo já admitido.");
    }

    const iniciado = await iniciarServidor(banco, ["--modulo-de-ensaio"]);
    servidor = iniciado;

    let ligado = true;
    return {
      diretorio,
      catalogo,
      origem: ORIGEM_CATALOGO,
      pacote: { publisher, name, version: "1.0.0", title, slug: `${publisher}-${name}` },
      async configurarServico({ hostOrigin, installationId, segredo }) {
        const resposta = await fetch(`${ORIGEM_CATALOGO}/ensaio/configurar`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            host_origin: hostOrigin,
            installation_id: installationId,
            secret: segredo,
          }),
        });
        // Nunca repetir o corpo enviado: ele leva o segredo.
        if (!resposta.ok) {
          throw new Error(`O serviço de ensaio recusou a configuração (HTTP ${resposta.status}).`);
        }
      },
      estaLigado: () => ligado && iniciado.processo.exitCode === null,
      async desligar() {
        if (!ligado) return;
        ligado = false;
        await encerrarProcessoProprio(iniciado.processo, iniciado.pid);
      },
      async limpar() {
        let erroDoProcesso: unknown;
        if (ligado) {
          ligado = false;
          try {
            await encerrarProcessoProprio(iniciado.processo, iniciado.pid);
          } catch (error) {
            erroDoProcesso = error;
          }
        }
        const raizPermitida = path.join(tmpdir(), "deskcomm-extensions-e2e-");
        if (!diretorio.startsWith(raizPermitida)) {
          throw new Error("Diretório temporário inesperado; cleanup recusado.");
        }
        await rm(diretorio, { recursive: true, force: true });
        if (erroDoProcesso) throw erroDoProcesso;
      },
    };
  } catch (error) {
    if (servidor) {
      await encerrarProcessoProprio(servidor.processo, servidor.pid).catch(() => undefined);
    }
    await rm(diretorio, { recursive: true, force: true });
    throw error;
  }
}

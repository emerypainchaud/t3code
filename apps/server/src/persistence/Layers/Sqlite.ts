import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const dynamicImport = new Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;
const bunSqliteClientSpecifiers = [
  new URL("./persistence/BunSqliteClientLoader.mjs", import.meta.url).href,
  new URL("../BunSqliteClientLoader.ts", import.meta.url).href,
];
const nodeSqliteClientSpecifiers = [
  new URL("./NodeSqliteClient.mjs", import.meta.url).href,
  new URL("./persistence/NodeSqliteClient.mjs", import.meta.url).href,
  new URL("../NodeSqliteClient.ts", import.meta.url).href,
];

async function importBunSqliteClient(): Promise<Loader> {
  for (const specifier of bunSqliteClientSpecifiers) {
    try {
      return await dynamicImport<Loader>(specifier);
    } catch {
      // The exact relative output path depends on whether we're running from
      // tsdown's bundled dist or a source-adjacent development environment.
    }
  }

  throw new Error("Unable to locate BunSqliteClient runtime module.");
}

async function importNodeSqliteClient(): Promise<Loader> {
  for (const specifier of nodeSqliteClientSpecifiers) {
    try {
      return await dynamicImport<Loader>(specifier);
    } catch {
      // The exact relative output path depends on whether we're running from
      // tsdown's bundled dist or a source-adjacent development environment.
    }
  }

  throw new Error("Unable to locate NodeSqliteClient runtime module.");
}

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const clientModule = yield* Effect.promise<Loader>(() => {
      if (process.versions.bun !== undefined) {
        return importBunSqliteClient();
      }

      return importNodeSqliteClient();
    });
    return clientModule.layer(config);
  }).pipe(Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations;
  }),
);

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: dbPath }));
  }).pipe(Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const { join } = yield* Path.Path;
  const dbPath = join(stateDir, "state.sqlite");
  return makeSqlitePersistenceLive(dbPath);
}).pipe(Layer.unwrap);

import * as BunSqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Layer } from "effect";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

export const layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient> =
  BunSqliteClient.layer;

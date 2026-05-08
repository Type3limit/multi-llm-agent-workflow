import SqliteDatabase from "better-sqlite3";

export type Database = InstanceType<typeof SqliteDatabase>;

export function openDatabase(path: string): Database {
  const db = new SqliteDatabase(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

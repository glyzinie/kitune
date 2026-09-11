import { Database } from "bun:sqlite";
import { loadSettings } from "./config";
import { createRuntime } from "./auth";
import { Store } from "./store";

process.umask(0o077);
const [command, argument] = process.argv.slice(2);
try {
  if (command === "backup") {
    if (!argument) throw new Error("Usage: bun run cli backup <new-backup-path>");
    // Backups must not reconcile a new configuration or run migrations first.
    const db = new Database(process.env.DATABASE_PATH ?? "./data/kitune.sqlite", { readonly: true });
    try { console.log(new Store(db).backup(argument)); } finally { db.close(); }
  } else if (command === "check-config") {
    await loadSettings();
    console.log("Configuration is valid");
  } else if (["sync", "enroll", "recover", "revoke", "revoke-all"].includes(command ?? "")) {
    if (["enroll", "recover", "revoke"].includes(command!) && !argument) throw new Error(`Usage: bun run cli ${command} <user-id>`);
    const runtime = await createRuntime(await loadSettings());
    try {
      if (command === "enroll" || command === "recover") console.log(runtime.store.issueEnrollment(argument!, runtime.settings.config.origin, command === "recover"));
      else if (command === "revoke") {
        runtime.store.active(argument!);
        runtime.store.db.transaction(() => runtime.store.revokeUser(argument!)).immediate();
        console.log("Sessions and OAuth grants revoked");
      } else if (command === "revoke-all") {
        runtime.store.revokeAll();
        console.log("All sessions, OAuth grants and enrollment URLs revoked");
      } else console.log("Database migrated and configuration synchronized");
    } finally { runtime.close(); }
  } else throw new Error("Usage: bun run cli <check-config | sync | enroll USER | recover USER | revoke USER | revoke-all | backup PATH>");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}

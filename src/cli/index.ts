#!/usr/bin/env node
import { parseArgs, runCli } from "./run-command.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const result = await runCli(args);

  if (result.message) {
    if (result.exitCode === 0) {
      console.log(result.message);
    } else {
      console.error(result.message);
    }
  }

  process.exitCode = result.exitCode;
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

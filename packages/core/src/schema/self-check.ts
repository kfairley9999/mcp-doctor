import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_IDS } from "../clients.js";
import { schemaDocument } from "../schema.js";
import { validateAgainstSchema } from "../schema.js";

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas");

export function checkSchemas(write: boolean): string[] {
  mkdirSync(schemaDir, { recursive: true });
  const problems: string[] = [];
  for (const id of CLIENT_IDS) {
    const file = path.join(schemaDir, `${id}.schema.json`);
    const next = schemaDocument(id);
    if (write) writeFileSync(file, next);
    let current: string;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      problems.push(`${id}: schema file is missing`);
      continue;
    }
    if (current !== next) problems.push(`${id}: schema file drifted from the generator`);
    const parsed: unknown = JSON.parse(next);
    if (typeof parsed !== "object" || parsed === null || !("$schema" in parsed)) {
      problems.push(`${id}: generated schema has no $schema`);
    }
    try {
      validateAgainstSchema(id, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "compile failed";
      problems.push(`${id}: schema failed to compile (${message})`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const problems = checkSchemas(process.argv.includes("--write"));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`schemas ok (${CLIENT_IDS.length})`);
}

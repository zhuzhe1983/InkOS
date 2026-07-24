import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  buildPaperS3HomePackage,
  currentShanghaiCalendarDate,
} from "../lib/ink/builtin/papers3-home";

function outputDirectory(arguments_: string[]): string {
  const outputIndex = arguments_.indexOf("--output");
  const value = outputIndex >= 0 ? arguments_[outputIndex + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error("Usage: npm run export:papers3-home -- --output <firmware asset directory>");
  }
  return path.resolve(value);
}

async function atomicWrite(filePath: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, filePath);
}

async function main(): Promise<void> {
  const directory = outputDirectory(process.argv.slice(2));
  const built = await buildPaperS3HomePackage(currentShanghaiCalendarDate());
  const metadata = {
    schemaVersion: "inkos.embedded-home/v1",
    packageId: built.manifest.packageId,
    entryUuid: built.manifest.entryUuid,
    revision: built.manifest.revision,
    generator: `${built.manifest.generator.name}/${built.manifest.generator.version}`,
    archiveBytes: built.archive.byteLength,
    archiveSha256: built.sha256,
  };

  await mkdir(directory, { recursive: true });
  await atomicWrite(path.join(directory, "home.ink"), built.archive);
  await atomicWrite(
    path.join(directory, "home.version.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  process.stdout.write(
    `PaperS3 home ${metadata.revision}: ${metadata.archiveBytes} bytes, ${metadata.archiveSha256}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

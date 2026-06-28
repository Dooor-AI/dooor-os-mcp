/**
 * Tarball builder for `deploy_app_from_directory`.
 * - Reads .dockerignore (preferred) or .gitignore for exclude rules.
 * - Always excludes a hard-coded set of dangerous defaults (.env*, secrets, build outputs).
 * - Uses the system `tar` binary to keep the MCP dependency-free.
 * - Returns the tarball as a Buffer plus its sha256, ready to PUT to a presigned URL.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HARD_EXCLUDES = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  ".cache",
  "*.log",
  ".DS_Store",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.pub",
];

export const MAX_TARBALL_BYTES = 500 * 1024 * 1024;

export interface BuildTarballResult {
  data: Buffer;
  sha256: string;
  sizeBytes: number;
  excludedEnvFiles: string[];
}

export async function buildSourceTarball(
  sourceDir: string,
  extraExcludes: string[] = [],
): Promise<BuildTarballResult> {
  const absDir = resolve(sourceDir);
  if (!existsSync(absDir)) {
    throw new Error(`Source directory does not exist: ${absDir}`);
  }

  const excludes = collectExcludes(absDir, extraExcludes);
  const envFiles = detectEnvFiles(absDir);

  const tmpDir = mkdtempSync(join(tmpdir(), "dooor-tar-"));
  const excludeFile = join(tmpDir, "excludes.txt");
  writeFileSync(excludeFile, excludes.join("\n"), "utf-8");

  try {
    const data = await spawnTar(absDir, excludeFile);

    if (data.length > MAX_TARBALL_BYTES) {
      throw new Error(
        `Tarball is ${data.length} bytes, exceeds limit of ${MAX_TARBALL_BYTES}. ` +
          "Add more entries to .dockerignore or split the deploy.",
      );
    }

    const sha256 = createHash("sha256").update(data).digest("hex");

    return {
      data,
      sha256,
      sizeBytes: data.length,
      excludedEnvFiles: envFiles,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function collectExcludes(absDir: string, extraExcludes: string[]): string[] {
  const dockerignore = join(absDir, ".dockerignore");
  const gitignore = join(absDir, ".gitignore");

  let userPatterns: string[] = [];
  if (existsSync(dockerignore)) {
    userPatterns = readIgnoreFile(dockerignore);
  } else if (existsSync(gitignore)) {
    userPatterns = readIgnoreFile(gitignore);
  }

  const all = [...HARD_EXCLUDES, ...userPatterns, ...extraExcludes];
  return Array.from(new Set(all)).filter((p) => p && !p.startsWith("!"));
}

function readIgnoreFile(filePath: string): string[] {
  return readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function detectEnvFiles(absDir: string): string[] {
  const found: string[] = [];
  const candidates = [".env", ".env.local", ".env.production", ".env.development"];
  for (const c of candidates) {
    if (existsSync(join(absDir, c))) found.push(c);
  }
  return found;
}

function spawnTar(absDir: string, excludeFile: string): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "--gzip",
      "--create",
      "--file",
      "-",
      "--exclude-from",
      excludeFile,
      "--exclude-vcs",
      "-C",
      absDir,
      ".",
    ];

    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderrBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_TARBALL_BYTES) {
        child.kill("SIGTERM");
        rejectPromise(
          new Error(
            `Tarball exceeded max size ${MAX_TARBALL_BYTES} bytes during streaming`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (err) => rejectPromise(err));

    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`tar exited with code ${code}: ${stderrBuffer.trim()}`),
        );
        return;
      }
      resolvePromise(Buffer.concat(chunks));
    });
  });
}

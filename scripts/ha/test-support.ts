import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = join(scriptDirectory, "../..");
export const workerDirectory = join(repositoryRoot, "apps/worker");
export const probeScript = join(scriptDirectory, "node-probe.ts");
export const sessionSecret = "ha-verification-secret-with-at-least-32-bytes";

function resolveTsxLoader(): string {
  const value = execFileSync(process.env.PNPM_BIN ?? "pnpm", ["--filter", "@hyeboard/worker", "exec", "node", "-p", "require.resolve('tsx/esm')"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (!value) throw new Error("Could not resolve the workspace tsx loader");
  return value;
}

const tsxLoader = resolveTsxLoader();

export async function dockerIsAvailable(): Promise<boolean> {
  try {
    await execFileAsync(process.env.DOCKER_BIN ?? "docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function dockerImagesAreAvailable(images: readonly string[]): Promise<boolean> {
  try {
    await Promise.all(images.map((image) => execFileAsync(process.env.DOCKER_BIN ?? "docker", ["image", "inspect", image], { timeout: 5_000 })));
    return true;
  } catch {
    return false;
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

export type WorkerOptions = {
  port: number;
  nodeId: string;
  postgresUrl: string;
  redisUrl: string;
};

export class WorkerProcess {
  private constructor(
    readonly port: number,
    private readonly child: ChildProcess,
    private readonly output: { stdout: string; stderr: string },
  ) {}

  static async start(options: WorkerOptions): Promise<WorkerProcess> {
    const port = options.port === 0 ? await freePort() : options.port;
    const output = { stdout: "", stderr: "" };
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, "src/index.node.ts"],
      {
        cwd: workerDirectory,
        env: {
          ...process.env,
          NODE_ENV: "test",
          HOST: "127.0.0.1",
          PORT: String(port),
          HYEB_HA_MODE: "distributed",
          HYEB_HA_NODE_ID: options.nodeId,
          HYEB_HA_SESSION_EPOCH: "1",
          HYEB_HA_ENFORCE_SESSION_EPOCH: "true",
          HYEB_SESSION_SECRET: sessionSecret,
          HYEB_POSTGRES_URL: options.postgresUrl,
          HYEB_REDIS_URL: options.redisUrl,
          HYEB_CAPTCHA_OCR: "false",
          HYEB_LOG_LEVEL: "error",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => { output.stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output.stderr += chunk.toString(); });
    const worker = new WorkerProcess(port, child, output);
    try {
      await worker.waitUntilResponding();
      return worker;
    } catch (error) {
      await worker.stop();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${worker.logs()}`);
    }
  }

  async waitUntilResponding(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/ready`);
        if (response.status === 200) return;
      } catch {
        // The child may still be importing dependencies or binding its port.
      }
      await delay(100);
    }
    throw new Error(`Worker on port ${this.port} did not become reachable`);
  }

  async request(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, init);
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body };
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    this.child.kill(signal);
    const exited = once(this.child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      timeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        void exited.then(resolve);
      }, 15_000);
    });
    try {
      const [code, childSignal] = await Promise.race([exited, timedOut]);
      return { code, signal: childSignal };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  logs(): string {
    return `worker stdout:\n${this.output.stdout}\nworker stderr:\n${this.output.stderr}`;
  }
}

export async function runProbe(
  backend: "postgres" | "redis",
  operation: string,
  input: Record<string, unknown>,
  dependencies: { postgresUrl?: string; redisUrl?: string },
): Promise<any> {
  const child = spawn(
    process.env.PNPM_BIN ?? "pnpm",
    ["--filter", "@hyeboard/worker", "exec", "tsx", probeScript, operation, JSON.stringify(input)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HA_PROBE_BACKEND: backend,
        HA_POSTGRES_URL: dependencies.postgresUrl,
        HA_REDIS_URL: dependencies.redisUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`HA probe ${operation} failed:\n${stderr}\n${stdout}`);
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`HA probe ${operation} returned no result`);
  return JSON.parse(line);
}

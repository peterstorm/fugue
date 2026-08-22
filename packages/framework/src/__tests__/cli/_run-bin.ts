import { resolve } from "node:path";

const binPath = resolve(__dirname, "..", "..", "..", "bin", "fugue.ts");

export interface BinResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runBin = async (args: readonly string[]): Promise<BinResult> => {
  const proc = Bun.spawn(["bun", binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

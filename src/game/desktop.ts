import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Game, GameAction } from './actions.js';

const execFileAsync = promisify(execFile);
const windowSchema = z.object({
  windowId: z.number().int().positive(),
  pid: z.number().int().positive(),
  owner: z.string(), title: z.string(),
  x: z.number(), y: z.number(),
  width: z.number().positive(), height: z.number().positive(),
});

export type GameWindow = z.infer<typeof windowSchema>;
export type Capture = {
  window: GameWindow;
  pngPath: string;
  modelPath: string;
  width: number;
  height: number;
  sha256: string;
  capturedAt: string;
};

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Window capture did not produce a PNG; check Screen Recording permission');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function runNative(file: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => { /* The helper's close event reports early failure. */ });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Desktop helper exited with status ${code}`));
    });
    child.stdin.end(input);
  });
}

export class MacDesktop {
  constructor(private readonly helper: string, private readonly game: Game) {
    if (process.platform !== 'darwin') throw new Error('The Mac desktop adapter requires macOS');
  }

  async window(): Promise<GameWindow> {
    const { stdout } = await execFileAsync(this.helper, ['window', this.game], { timeout: 5_000 });
    return windowSchema.parse(JSON.parse(stdout) as unknown);
  }

  private async inspect(windowId: number): Promise<GameWindow> {
    const { stdout } = await execFileAsync(this.helper, ['inspect', this.game, String(windowId)], { timeout: 5_000 });
    return windowSchema.parse(JSON.parse(stdout) as unknown);
  }

  async capture(directory: string, label: string, previous?: GameWindow): Promise<Capture> {
    const before = previous ? await this.inspect(previous.windowId) : await this.window();
    if (previous && (before.pid !== previous.pid ||
        Math.abs(before.width - previous.width) > 2 || Math.abs(before.height - previous.height) > 2)) {
      throw new Error('Game window identity or size changed before follow-up capture');
    }
    const pngPath = path.join(directory, `${label}.png`);
    const modelPath = path.join(directory, `${label}.jpg`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await execFileAsync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(before.windowId), pngPath], { timeout: 10_000 });
    const bytes = await fs.readFile(pngPath);
    const { width, height } = pngDimensions(bytes);
    if (width === 0 || height === 0 || Math.abs(width / height - before.width / before.height) > 0.06) {
      throw new Error('Window screenshot dimensions do not match the game window');
    }
    const after = previous ? await this.inspect(before.windowId) : await this.window();
    if (after.windowId !== before.windowId || after.pid !== before.pid ||
        Math.abs(after.width - before.width) > 2 || Math.abs(after.height - before.height) > 2) {
      throw new Error('Game window changed during capture');
    }
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '1600', pngPath, '--out', modelPath], { timeout: 10_000 });
    return {
      window: before, pngPath, modelPath, width, height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: new Date().toISOString(),
    };
  }

  async act(capture: Capture, actions: GameAction[]): Promise<void> {
    if (actions.length === 0) return;
    await runNative(this.helper, ['act', this.game], JSON.stringify({
      windowId: capture.window.windowId,
      width: Math.round(capture.window.width),
      height: Math.round(capture.window.height),
      actions,
    }));
  }
}

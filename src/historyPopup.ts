import { t, getLocale } from './i18n';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

interface Subscription { dispose(): void; }
export interface HistorySurface {
  readonly popup: boolean;
  webview: {
    postMessage(message: unknown): Promise<boolean> | Thenable<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown): Subscription;
  };
  onDidDispose(listener: () => void): Subscription;
  dispose(): void;
}


// A narrow stdin/stdout transport; no local HTTP server or editor UI injection.
export class PopupTransport implements HistorySurface {
  readonly popup = true;
  private listener?: (message: unknown) => unknown;
  private pending: unknown[] = [];
  private disposed = false;
  private disposals = new Set<() => void>();
  private stderr = '';
  private ready = false;
  readonly started: Promise<void>;
  private resolveStart!: () => void;
  private rejectStart!: (error: Error) => void;
  webview = {
    postMessage: async (message: unknown): Promise<boolean> => {
      if (this.disposed) return false;
      return new Promise<boolean>(resolve => this.child.stdin.write(`${JSON.stringify(message)}\n`, error => resolve(!error)));
    },
    onDidReceiveMessage: (listener: (message: unknown) => unknown): Subscription => {
      this.listener = listener;
      for (const message of this.pending.splice(0)) listener(message);
      return { dispose: () => { if (this.listener === listener) this.listener = undefined; } };
    },
  };
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly report: (message: string) => void) {
    this.started = new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
    const timeout = setTimeout(() => this.fail(new Error(t("历史小窗启动超时。"))), 15_000);
    timeout.unref();
    const lines = createInterface({ input: child.stdout });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    child.stdin.on('error', () => { /* The exit/error event reports the failure. */ });
    child.on('error', error => this.fail(error));
    lines.on('line', line => {
      if (this.disposed) return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { this.fail(new Error(t("历史小窗通信格式错误。"))); return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'fatal') { this.fail(new Error(String(message.message || t("历史小窗启动失败。")))); return; }
      if (!this.ready && message.type === 'init') { this.ready = true; clearTimeout(timeout); this.resolveStart(); }
      if (this.listener) this.listener(message); else this.pending.push(message);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout); lines.close();
      if (!this.ready && !this.disposed) this.rejectStart(new Error(t("历史小窗未能启动（{0}）。{1}", code ?? 'signal', this.stderr)));
      else if (!this.disposed && (code || signal)) report(t("历史小窗异常退出（{0}）。", code ?? signal));
      this.finish();
    });
  }
  private fail(error: Error): void {
    if (this.disposed) return;
    if (this.ready) this.report(error.message); else this.rejectStart(error);
    this.dispose();
  }
  private finish(): void {
    if (this.disposed) return;
    this.disposed = true; this.pending = []; this.listener = undefined;
    for (const listener of this.disposals) listener();
    this.disposals.clear();
  }
  onDidDispose(listener: () => void): Subscription { this.disposals.add(listener); return { dispose: () => this.disposals.delete(listener) }; }
  dispose(): void {
    if (this.disposed) return;
    if (!this.ready) this.rejectStart(new Error(t("历史小窗启动已取消。")));
    this.child.stdin.end(`${JSON.stringify({ type: 'closeHost' })}\n`);
    this.finish();
    const timer = setTimeout(() => { if (this.child.exitCode === null && !this.child.killed) this.child.kill(); }, 1000);
    timer.unref();
  }
}

export function popupEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  // LaunchServices must register the companion as its own accessory app.
  // These Electron host identifiers otherwise make it inherit Qoder's app identity.
  delete env.__CFBundleIdentifier; delete env.XPC_SERVICE_NAME;
  return env;
}

export type HistoryTheme = 'light' | 'dark' | 'hc-light' | 'hc-dark';

export async function openHistoryPopup(extensionPath: string, title: string, theme: HistoryTheme, report: (message: string) => void): Promise<HistorySurface> {
  const binary = path.join(extensionPath, 'native-bin/Orbit Git History.app/Contents/MacOS/GitWorkbenchHistory');
  try { await chmod(binary, 0o755); } catch { throw new Error(t("原生历史小窗组件不可用，请重新安装包含 macOS 小窗组件的 VSIX。")); }
  const child = spawn(binary, [path.join(extensionPath, 'media'), title, theme, getLocale()], { stdio: ['pipe', 'pipe', 'pipe'], env: popupEnvironment(process.env) });
  const surface = new PopupTransport(child, report);
  await surface.started;
  return surface;
}

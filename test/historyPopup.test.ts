import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PopupTransport, popupEnvironment } from '../src/historyPopup';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, killed: false, kill() { this.killed = true; this.exitCode = 0; EventEmitter.prototype.emit.call(this, 'exit', 0); return true; } });
  const errors: string[] = [];
  const surface = new PopupTransport(child as unknown as ChildProcessWithoutNullStreams, message => errors.push(message));
  return { child, surface, errors };
}

test('popup transport buffers the startup handshake and preserves Chinese patches over stdio', async () => {
  const { child, surface, errors } = fixture();
  child.stdout.write('{"type":"init"}\n'); await surface.started;
  const messages: unknown[] = [];
  surface.webview.onDidReceiveMessage(message => messages.push(message));
  assert.deepEqual(messages, [{ type: 'init' }]);
  const received: string[] = []; child.stdin.setEncoding('utf8'); child.stdin.on('data', chunk => received.push(String(chunk)));
  const detail = { type: 'historyDetail', data: { patch: '+中文\n-old\n', hash: 'a'.repeat(40) } };
  assert.equal(await surface.webview.postMessage(detail), true);
  assert.deepEqual(JSON.parse(received[0]), detail);
  let closed = false; surface.onDidDispose(() => { closed = true; });
  child.exitCode = 0; child.emit('exit', 0);
  assert.equal(closed, true); assert.equal(await surface.webview.postMessage(detail), false); assert.deepEqual(errors, []);
});

test('startup failures reject rather than leaving an empty popup or silently opening a tab', async () => {
  const { child, surface } = fixture();
  const rejected = assert.rejects(surface.started, /资源加载失败/);
  child.stdout.write('{"type":"fatal","message":"资源加载失败"}\n');
  await rejected; child.kill();
});

test('closing a popup sends a shutdown message and cancels an unfinished startup', async () => {
  const { child, surface } = fixture();
  let command = ''; child.stdin.setEncoding('utf8'); child.stdin.on('data', chunk => { command += chunk; });
  const rejected = assert.rejects(surface.started, /已取消/);
  surface.dispose(); await rejected;
  assert.deepEqual(JSON.parse(command), { type: 'closeHost' }); child.kill();
});


test('the native companion does not inherit the editor LaunchServices identity', () => {
  const inherited = { __CFBundleIdentifier: 'com.qoder.ide', XPC_SERVICE_NAME: 'application.com.qoder.ide.example', PATH: '/usr/bin', LANG: 'zh_CN.UTF-8' };
  assert.deepEqual(popupEnvironment(inherited), { PATH: '/usr/bin', LANG: 'zh_CN.UTF-8' });
  assert.equal(inherited.__CFBundleIdentifier, 'com.qoder.ide', 'the parent environment must remain unchanged');
});

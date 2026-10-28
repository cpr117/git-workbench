import { watch, FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { Git } from './git';

// Stashes belong to the common repository, including when opened in a linked worktree.
// Watch directories so the first stash, atomic ref updates and stash clear are all detected.
export async function watchStashes(git: Git, changed: () => void, failed: (error: unknown) => void): Promise<{ dispose(): void }> {
  const common = path.resolve(git.root, (await git.run(['rev-parse', '--git-common-dir'])).trim());
  const directories = ['', 'refs', 'logs', 'logs/refs', 'reftable'];
  const watchers = new Map<string, FSWatcher>();
  let disposed = false;
  function attach(): void {
    if (disposed) return;
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = watch(path.join(common, directory), { persistent: false }, (_event, filename) => {
          const name = filename?.toString();
          const relevant = !name || (directory === '' ? ['refs', 'logs', 'packed-refs', 'reftable'].includes(name)
            : directory === 'logs' ? name === 'refs'
            : directory === 'reftable' || name === 'stash' || name === 'stash.lock');
          if (!relevant || disposed) return;
          // Parent directories may have been created, removed, or replaced.
          if (!name || directory === '' || directory === 'logs') {
            for (const [child, active] of watchers) {
              if (child !== directory && child.startsWith(directory ? directory + '/' : '') && child) { active.close(); watchers.delete(child); }
            }
            attach();
          }
          changed();
        });
        watchers.set(directory, watcher);
        watcher.on('error', error => { watcher.close(); watchers.delete(directory); if (!disposed) { failed(error); changed(); } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed(error);
      }
    }
  }
  attach();
  return { dispose() { disposed = true; watchers.forEach(watcher => watcher.close()); watchers.clear(); } };
}

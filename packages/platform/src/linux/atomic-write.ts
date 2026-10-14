import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface FileOps {
  rename(from: string, to: string): Promise<void>;
}

const defaultOps: FileOps = { rename: (a, b) => fs.rename(a, b) };

export type WriteMethod = 'rename' | 'in-place';

async function fsyncDir(dir: string): Promise<void> {
  const fh = await fs.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Replace `target` with `data` without ever exposing a half-written file: write a temp file
 * in the same directory, fsync it, rename over the target, fsync the directory. Mode (and
 * owner, when permitted) of an existing target are preserved.
 *
 * Some files cannot be replaced by rename, notably `/etc/hosts` inside Docker where it is a
 * bind mount (`EBUSY`). In that case, and only that case, fall back to rewriting in place.
 * The fallback is not atomic, so the caller is told which method was used.
 */
export async function atomicWriteFile(
  target: string,
  data: string,
  ops: FileOps = defaultOps,
): Promise<WriteMethod> {
  let mode = 0o644;
  let uid: number | undefined;
  let gid: number | undefined;
  try {
    const st = await fs.stat(target);
    mode = st.mode & 0o7777;
    uid = st.uid;
    gid = st.gid;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.hourkeep-${process.pid}.tmp`);
  const fh = await fs.open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.chmod(mode); // umask must not narrow the original mode
    if (uid !== undefined && gid !== undefined) {
      await fh.chown(uid, gid).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EPERM') throw e; // not root (tests): keep the current owner
      });
    }
    await fh.sync();
  } catch (e) {
    await fh.close();
    await fs.rm(tmp, { force: true });
    throw e;
  }
  await fh.close();

  try {
    await ops.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e;
    const inPlace = await fs.open(target, 'r+');
    try {
      await inPlace.truncate(0);
      await inPlace.writeFile(data);
      await inPlace.sync();
    } finally {
      await inPlace.close();
    }
    return 'in-place';
  }
  await fsyncDir(dir);
  return 'rename';
}

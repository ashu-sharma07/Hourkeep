import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from './atomic-write.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk-atomic-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('creates a missing file with mode 0644', async () => {
    const f = path.join(dir, 'new');
    expect(await atomicWriteFile(f, 'hello')).toBe('rename');
    expect(await fs.readFile(f, 'utf8')).toBe('hello');
    expect((await fs.stat(f)).mode & 0o777).toBe(0o644);
  });

  it('preserves the mode of an existing file regardless of umask', async () => {
    const f = path.join(dir, 'f');
    await fs.writeFile(f, 'old', { mode: 0o640 });
    await fs.chmod(f, 0o640);
    await atomicWriteFile(f, 'new');
    expect((await fs.stat(f)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(f, 'utf8')).toBe('new');
  });

  it('replaces the file by rename (new inode) and leaves no temp files', async () => {
    const f = path.join(dir, 'f');
    await fs.writeFile(f, 'old');
    const before = (await fs.stat(f)).ino;
    await atomicWriteFile(f, 'new');
    expect((await fs.stat(f)).ino).not.toBe(before);
    expect(await fs.readdir(dir)).toEqual(['f']);
  });

  it('falls back to an in-place rewrite on EBUSY, keeping the inode', async () => {
    const f = path.join(dir, 'f');
    await fs.writeFile(f, 'a much longer old content');
    const before = (await fs.stat(f)).ino;
    const method = await atomicWriteFile(f, 'short', {
      rename: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })),
    });
    expect(method).toBe('in-place');
    expect(await fs.readFile(f, 'utf8')).toBe('short');
    expect((await fs.stat(f)).ino).toBe(before);
    expect(await fs.readdir(dir)).toEqual(['f']);
  });

  it('does not fall back for other rename errors, and cleans up the temp file', async () => {
    const f = path.join(dir, 'f');
    await fs.writeFile(f, 'old');
    await expect(
      atomicWriteFile(f, 'new', {
        rename: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EACCES' })),
      }),
    ).rejects.toThrow('nope');
    expect(await fs.readFile(f, 'utf8')).toBe('old');
    expect(await fs.readdir(dir)).toEqual(['f']);
  });
});

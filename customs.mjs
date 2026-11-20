/**
 * The assets' customs folder (assets/customs), laid out like the assets: a file there is served in place of the
 * assets' own of the same name, and a file only it has is served as well. Voyage-Editor publishes there, and
 * Voyage-Server reads the same files, so players and the game server see the same game.
 *
 * The page asks for a changed file by its version (/config.json lists them), so a copy a browser kept of the one
 * before isn't used: the list is read again when it is asked for, at most every couple of seconds, which makes a
 * file published while the server runs reach players the next time they change maps.
 */
import fs from 'fs';
import path from 'path';

export class Customs {
  constructor(assetsDir) {
    this.dir = path.join(assetsDir, 'customs');
    this.read = 0;
    this.scanning = null;
    this.list = { versions: {}, imgs: new Set() };
    this.refresh().catch(() => {});
  }

  /**
   * Returns the latest cached customs snapshot immediately (non-blocking) and triggers a background
   * refresh when stale so /config.json never stalls on slow Docker bind mounts.
   */
  now() {
    const ttl = this.list.imgs.size > 500 ? 60000 : 2000;
    if (Date.now() - this.read >= ttl && !this.scanning) {
      this.refresh().catch(() => {});
    }
    return this.list;
  }

  async refresh() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const versions = {}, imgs = new Set();
      const skipSubtree = (r) => r.startsWith('Character/') || r.startsWith('Item/') || r.startsWith('UI/') || r.startsWith('Effect/');
      const walk = async (dir, rel) => {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        const subdirs = [];
        const files = [];
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (e.name.endsWith('.img') && skipSubtree(r)) {
              imgs.add(r);
              if (!(r in versions)) versions[r] = 1;
            } else {
              subdirs.push(walk(path.join(dir, e.name), r));
            }
            continue;
          }
          files.push([e.name, r, path.join(dir, e.name)]);
        }
        // Batch stat calls cleanly to maximize throughput on Windows/Docker bind mounts
        for (let i = 0; i < files.length; i += 64) {
          await Promise.all(files.slice(i, i + 64).map(async ([, r, full]) => {
            let mtime = 0;
            try { mtime = (await fs.promises.stat(full)).mtimeMs; } catch { return; }
            const m = /^(.*?\.img)(?:\.json$|\/)/.exec(r);
            const key = m ? m[1] : r;
            if (m) imgs.add(key);
            versions[key] = Math.max(versions[key] || 0, Math.floor(mtime));
          }));
        }
        await Promise.all(subdirs);
      };
      await walk(this.dir, '');
      for (const k of Object.keys(versions)) versions[k] = versions[k].toString(36);
      this.list = { versions, imgs };
      this.read = Date.now();
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  /** Whether the customs folder changes this .img ("Npc/9010000.img"): then the sheets leave it to the files. */
  has(img) { return this.now().imgs.has(img); }
}

/**
 * Which assets these are: a short id from when each of the assets' top folders last changed. Extracting the assets
 * again gives a new one, and the page asks for files by it, so copies a browser kept of the old ones aren't used.
 */
export function assetsId(assetsDir) {
  let text = '';
  try {
    for (const e of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'customs') text += `${e.name}:${Math.floor(fs.statSync(path.join(assetsDir, e.name)).mtimeMs)};`;
    }
  } catch { return ''; }
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return text ? (h >>> 0).toString(36) : '';
}

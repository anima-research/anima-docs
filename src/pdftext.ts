// The text of a PDF, page by page, for agents (read_file, search): made by
// poppler's pdftotext the first time it is asked for and kept beside the media
// (stored files never change, so neither does their text). Where pdftotext is
// not installed, a PDF stays what it was to an agent: a size and an address.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class PdfText {
  readonly available: boolean;
  private dir: string;
  private reading = new Map<string, Promise<string[] | null>>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'pdftext');
    this.available = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
    if (!this.available) console.warn('[pdf] pdftotext (poppler-utils) is not installed: agents cannot read the text of PDFs.');
  }

  /** Where each word sits on its page (one page, or all): for placing something beside given words. Null when unreadable. */
  words(file: string, page?: number): Promise<PageWords[] | null> {
    if (!this.available) return Promise.resolve(null);
    const range = page ? ['-f', String(page), '-l', String(page)] : [];
    const run = (cmd: string, args: string[]) => new Promise<string | null>((resolve) => { execFile(cmd, args, { maxBuffer: 512 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => resolve(err ? null : stdout)); });
    // The words come placed as the page is shown (turned, if the page is); the page's size comes as it is
    // before turning, so each page's rotation is asked for too, and a page on its side has its sides swapped.
    return Promise.all([run('pdftotext', ['-q', '-enc', 'UTF-8', '-cropbox', '-bbox', ...range, file, '-']), run('pdfinfo', [...(page ? range : ['-f', '1', '-l', '100000']), file])]).then(([xml, info]) => {
      if (xml === null) return null;
      const turned = new Set([...(info ?? '').matchAll(/^Page\s+(\d+) rot:\s+(\d+)/gm)].filter((m) => Number(m[2]) % 180 === 90).map((m) => Number(m[1])));
      return parseWords(xml, page ?? 1).map((p) => (turned.has(p.page) ? { ...p, width: p.height, height: p.width } : p));
    });
  }

  /** Whether the text is already made (reading it costs nothing). */
  ready(mediaId: string): boolean { return existsSync(join(this.dir, `${mediaId}.txt`)) || existsSync(join(this.dir, `${mediaId}.txt.failed`)); }

  /** The pages' text, or null when the file cannot be read as a PDF. */
  pages(mediaId: string, file: string): Promise<string[] | null> {
    if (!this.available) return Promise.resolve(null);
    const out = join(this.dir, `${mediaId}.txt`);
    if (existsSync(out)) return Promise.resolve(split(readFileSync(out, 'utf8')));
    // One that could not be read (damaged, or too slow) is not tried again: stored files do not change.
    if (existsSync(`${out}.failed`)) return Promise.resolve(null);
    let reading = this.reading.get(mediaId);
    if (!reading) {
      reading = new Promise<string[] | null>((resolve) => {
        execFile('pdftotext', ['-q', '-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
          this.reading.delete(mediaId);
          mkdirSync(this.dir, { recursive: true });
          if (err) { writeFileSync(`${out}.failed`, ''); resolve(null); return; }
          writeFileSync(`${out}.tmp`, stdout);
          renameSync(`${out}.tmp`, out);
          resolve(split(stdout));
        });
      });
      this.reading.set(mediaId, reading);
    }
    return reading;
  }
}

export interface PageWords { page: number; width: number; height: number; words: { text: string; x0: number; y0: number; x1: number; y1: number }[] }

const entity = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" } as Record<string, string>)[e]);

/** pdftotext -bbox -cropbox: each page's size and each word's box, in points from the top left of the page as it is shown. */
function parseWords(xml: string, first: number): PageWords[] {
  const out: PageWords[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  for (let m = pageRe.exec(xml), n = first; m; m = pageRe.exec(xml), n++) {
    const words: PageWords['words'] = [];
    const wordRe = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;
    for (let w = wordRe.exec(m[3]); w; w = wordRe.exec(m[3])) words.push({ x0: Number(w[1]), y0: Number(w[2]), x1: Number(w[3]), y1: Number(w[4]), text: entity(w[5]) });
    out.push({ page: n, width: Number(m[1]), height: Number(m[2]), words });
  }
  return out;
}

/** pdftotext ends every page with a form feed. */
function split(text: string): string[] {
  const pages = text.split('\f');
  if (pages.length > 1 && pages[pages.length - 1].trim() === '') pages.pop();
  return pages.map((p) => p.replace(/\s+$/, ''));
}

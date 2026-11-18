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

  /** Whether the text is already made (reading it costs nothing). */
  ready(mediaId: string): boolean { return existsSync(join(this.dir, `${mediaId}.txt`)); }

  /** The pages' text, or null when the file cannot be read as a PDF. */
  pages(mediaId: string, file: string): Promise<string[] | null> {
    if (!this.available) return Promise.resolve(null);
    const out = join(this.dir, `${mediaId}.txt`);
    if (existsSync(out)) return Promise.resolve(split(readFileSync(out, 'utf8')));
    let reading = this.reading.get(mediaId);
    if (!reading) {
      reading = new Promise<string[] | null>((resolve) => {
        execFile('pdftotext', ['-q', '-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
          this.reading.delete(mediaId);
          if (err) { resolve(null); return; }
          mkdirSync(this.dir, { recursive: true });
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

/** pdftotext ends every page with a form feed. */
function split(text: string): string[] {
  const pages = text.split('\f');
  if (pages.length > 1 && pages[pages.length - 1].trim() === '') pages.pop();
  return pages.map((p) => p.replace(/\s+$/, ''));
}

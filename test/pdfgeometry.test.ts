// What a person places on a page as it is shown lands there in the PDF, whatever the page's rotation and crop;
// and a field placed beside words is where those words are shown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { pageMapper, shownBox } from '../web/pdfgeometry.js';
import { PdfText } from '../src/pdftext.js';

const hasPdfText = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('text placed at a point of the shown page is read back at that point: every rotation, with and without a crop', { skip: !hasPdfText && 'pdftotext is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adocs-geom-'));
  const reader = new PdfText(dir);
  for (const crop of [null, { x: 40, y: 60, width: 500, height: 650 }]) {
    for (const rot of [0, 90, 180, 270]) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, 792]);
      page.setRotation(degrees(rot));
      if (crop) page.setCropBox(crop.x, crop.y, crop.width, crop.height);
      const m = pageMapper(page.getRotation().angle, shownBox(page.getCropBox(), page.getMediaBox()));
      // The baseline of the word starts three tenths across and four tenths down the page as shown.
      const u = 0.3 * m.shown.w, v = 0.4 * m.shown.h;
      const at = m.at(u, v);
      page.drawText('MARK', { x: at.x, y: at.y, size: 20, font, rotate: degrees(m.rot) });
      const file = join(dir, `r${rot}${crop ? 'c' : ''}.pdf`);
      writeFileSync(file, await doc.save());
      const [shown] = (await reader.words(file))!;
      const where = `rotation ${rot}${crop ? ', cropped' : ''}`;
      assert.ok(Math.abs(shown.width - m.shown.w) < 0.5 && Math.abs(shown.height - m.shown.h) < 0.5, `${where}: shown ${shown.width}×${shown.height}, expected ${m.shown.w}×${m.shown.h}`);
      const word = shown.words.find((w) => w.text === 'MARK');
      assert.ok(word, `${where}: the word is on the shown page (${JSON.stringify(shown.words)})`);
      assert.ok(Math.abs(word!.x0 - u) < 3, `${where}: starts at ${word!.x0}, expected ${u}`);
      assert.ok(word!.y0 < v && Math.abs(word!.y1 - v) < 8, `${where}: stands on ${word!.y1}, expected the baseline at ${v}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

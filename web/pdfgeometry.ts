// Where a point of a PDF page as it is shown lies in the page's own space.
//
// A page is shown through a box (its crop box, within its media box) and
// turned by its rotation; what a person places on it is kept in the shown
// page's terms (points from its top left). Writing it into the PDF needs the
// page's own coordinates: origin at the bottom left of the unturned page.

export interface Box { x: number; y: number; width: number; height: number }

/** The part of the crop box that lies inside the media box: what viewers show. */
export function shownBox(crop: Box, media: Box): Box {
  const x0 = Math.max(crop.x, media.x), y0 = Math.max(crop.y, media.y);
  const x1 = Math.min(crop.x + crop.width, media.x + media.width), y1 = Math.min(crop.y + crop.height, media.y + media.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : media;
}

/**
 * For a page shown through `box` and turned `rotation` degrees clockwise: the size it is shown at, and the
 * page's own point for a shown one. Something drawn upright for the reader is drawn turned by the same
 * number of degrees counter-clockwise, from the point its bottom left corner is shown at.
 */
export function pageMapper(rotation: number, box: Box) {
  const rot = ((rotation % 360) + 360) % 360;
  const shown = rot % 180 ? { w: box.height, h: box.width } : { w: box.width, h: box.height };
  const at = (u: number, v: number) => (rot === 90 ? { x: box.x + v, y: box.y + u }
    : rot === 180 ? { x: box.x + box.width - u, y: box.y + v }
      : rot === 270 ? { x: box.x + box.width - v, y: box.y + box.height - u }
        : { x: box.x + u, y: box.y + box.height - v });
  return { rot, shown, at };
}

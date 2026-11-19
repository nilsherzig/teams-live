// The one building block for "a small icon, then text" on a card: a service logo and a status, a person's
// picture and a name, a CI icon and its label. Every such pair uses the same exact gap between the two,
// because the card's own spacing presets are either too wide or too tight (and a column also gets the
// card's default column spacing unless told otherwise).
//
// Pure functions: card items in, card items out.

/** The gap between a small icon and the text after it, in pixels. */
export const ICON_GAP_PX = 6;

/** An empty column of fixed width. `spacing: None`: otherwise the card adds its own spacing in front of it. */
export function gapColumn(px = ICON_GAP_PX) {
  return {
    type: 'Column',
    width: `${px}px`,
    spacing: 'None',
    verticalContentAlignment: 'Center',
    items: [{ type: 'TextBlock', text: '', wrap: false, size: 'Small', spacing: 'None' }],
  };
}

/**
 * The three columns of an icon followed by its text: [icon] [gap] [text]. The first column keeps the
 * card's default spacing (it follows a label or sits first in a row); the others have none.
 *
 * @param {object} p
 * @param {object} p.icon  a card item (an Image)
 * @param {object|object[]} p.content  the item(s) after the icon (a TextBlock, ...)
 * @param {number} [p.gapPx]
 * @param {string} [p.iconWidth]  'auto' or a pixel width such as '16px'
 * @param {string} [p.contentWidth]  'stretch' (default) or 'auto'
 */
export function iconTextColumns({ icon, content, gapPx = ICON_GAP_PX, iconWidth = 'auto', contentWidth = 'stretch' }) {
  return [
    { type: 'Column', width: iconWidth, verticalContentAlignment: 'Center', items: [icon] },
    gapColumn(gapPx),
    { type: 'Column', width: contentWidth, spacing: 'None', verticalContentAlignment: 'Center', items: Array.isArray(content) ? content : [content] },
  ];
}

/** The same as one row (a ColumnSet) of its own. */
export function iconTextRow(options, { spacing = 'None' } = {}) {
  return { type: 'ColumnSet', spacing, columns: iconTextColumns(options) };
}

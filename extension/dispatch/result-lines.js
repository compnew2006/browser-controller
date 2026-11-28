/**
 * Result annotation lines (extracted from dispatch/router.js): the router
 * appends these to a successful tool result, and nothing else uses them.
 */
import { getOpenDialog, dialogLabel, takeFileChooser } from '../lib/cdp-session.js';

/**
 * A success on a tab whose JavaScript dialog is open gets the `dialog:` line the input tools
 * give (a navigate whose page calls alert on load, say), unless its text already names the dialog.
 */
export function withDialogLine(tabId, result) {
  const open = tabId == null ? null : getOpenDialog(tabId);
  const text = typeof result?.text === 'string' ? result.text : '';
  if (!open || !result || result.success === false || /^dialog: /m.test(text)) return result;
  const line = `dialog: ${dialogLabel(open)}`;
  return { ...result, text: text ? `${text}\n${line}` : line, dialog: open };
}

/**
 * A file chooser that agent input opened was intercepted, not shown (cdp-session
 * holdFileChooser). The next success on the tab says so, once, and how to upload instead.
 */
export function withFileChooserLine(tabId, result) {
  if (tabId == null || !result || result.success === false) return result;
  const chooser = takeFileChooser(tabId);
  if (!chooser) return result;
  const files = chooser.mode === 'selectMultiple' ? 'several files' : 'one file';
  const line = `fileChooser: the page opened a file chooser (${files}); it was not shown. To upload, browser_fill the file input, its label or the upload button with absolute paths.`;
  const text = typeof result.text === 'string' ? result.text : '';
  return { ...result, text: text ? `${text}\n${line}` : line, fileChooser: { mode: chooser.mode } };
}

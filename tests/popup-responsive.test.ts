import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderQuestionCard } from '../extension/popup/question-card.js';

const repoRoot = join(import.meta.dirname, '..');
const popupHtmlPath = join(repoRoot, 'extension', 'popup', 'popup.html');
const popupCssPath = join(repoRoot, 'extension', 'popup', 'popup.css');
const popupJsPath = join(repoRoot, 'extension', 'popup', 'popup.js');
const popupResizePath = join(repoRoot, 'extension', 'popup', 'popup-resize.js');
const questionCardPath = join(repoRoot, 'extension', 'popup', 'question-card.js');
const questionViewPath = join(repoRoot, 'extension', 'popup', 'question-view.js');
const openTabsViewPath = join(repoRoot, 'extension', 'popup', 'open-tabs-view.js');

const popupHtml = readFileSync(popupHtmlPath, 'utf8');
const popupJs = readFileSync(popupJsPath, 'utf8');
/** The extracted stylesheet; '' before Task 9 extracts it, so every rule assertion fails (RED) instead of throwing. */
const popupCss = existsSync(popupCssPath) ? readFileSync(popupCssPath, 'utf8') : '';
/** The resizer lives in popup-resize.js after the Task 9 split; before that, in popup.js. */
const resizeSource = existsSync(popupResizePath) ? readFileSync(popupResizePath, 'utf8') : popupJs;

/** Drop every @media block (brace-counted) so only base rules — the ones live at 320px — remain. */
function stripMediaBlocks(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    while (j < css.length) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    i = j + 1;
  }
  return out;
}

/** The min-height (px) a base rule for this exact selector declares, or null when it declares none. */
function baseMinHeight(css: string, selector: string): number | null {
  const base = stripMediaBlocks(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = base.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'));
  if (!match) return null;
  const height = match[1].match(/(?:min-height|height)\s*:\s*(\d+)px/u);
  return height ? Number(height[1]) : null;
}

describe('responsive popup layout', () => {
  it('test_touch_targets_min_44px', () => {
    // Every interactive button in the popup is at least 44px tall at 320px
    // (Design §7 / adapt: touch targets 44x44 minimum). The 44px must come
    // from a BASE rule — a value that only appears inside a wider breakpoint
    // would leave the 320px popup with the old small targets.
    // Buttons in popup.html itself: the tab bar, .btn-mini, .logbar-toggle.
    expect(popupHtml).toContain('<button');
    expect(baseMinHeight(popupCss, '.tabbar button'), '.tabbar button').toBeGreaterThanOrEqual(44);
    expect(baseMinHeight(popupCss, '.btn-mini'), '.btn-mini').toBeGreaterThanOrEqual(44);
    expect(baseMinHeight(popupCss, '.logbar-toggle'), '.logbar-toggle').toBeGreaterThanOrEqual(44);
    // Buttons rendered by the row/card modules: the question card's answers
    // (question-card.js) and the per-row icon buttons (open-tabs-view.js).
    const questionCardSource = readFileSync(questionCardPath, 'utf8');
    expect(questionCardSource).toContain('class="question-answer"');
    expect(baseMinHeight(popupCss, '.question-answer'), '.question-answer').toBeGreaterThanOrEqual(44);
    const openTabsViewSource = readFileSync(openTabsViewPath, 'utf8');
    expect(openTabsViewSource).toContain('icon-btn');
    expect(baseMinHeight(popupCss, '.icon-btn'), '.icon-btn').toBeGreaterThanOrEqual(44);
    // The other touch targets in the same rows: the free-text answer input
    // and the per-row agent picker.
    expect(baseMinHeight(popupCss, '.question-input'), '.question-input').toBeGreaterThanOrEqual(44);
    expect(baseMinHeight(popupCss, '.tab-pin select'), '.tab-pin select').toBeGreaterThanOrEqual(44);
  });

  it('test_breakpoints_320_380_500_640', () => {
    // Flexible shell, not the old fixed 380px: base floor 320px, default
    // 380px, and min-width breakpoints at 380 / 500 / 640.
    expect(popupCss).toMatch(/min-width:\s*320px/u);
    expect(popupCss).toMatch(/@media\s*\(\s*min-width:\s*380px\s*\)/u);
    expect(popupCss).toMatch(/@media\s*\(\s*min-width:\s*500px\s*\)/u);
    expect(popupCss).toMatch(/@media\s*\(\s*min-width:\s*640px\s*\)/u);
    // The resizer clamps to the same range: 320px floor, 640px ceiling.
    expect(resizeSource).toMatch(/MIN_W\s*=\s*320/u);
    expect(resizeSource).toMatch(/MAX_W\s*=\s*640/u);
    expect(resizeSource).not.toMatch(/MAX_W\s*=\s*760/u);
  });

  it('test_css_extracted_to_popup_css', () => {
    // The inline <style> is gone; popup.html links the extracted sheet, and
    // the sheet keeps the dark zinc + indigo identity (PRODUCT.md).
    expect(popupHtml).not.toContain('<style>');
    expect(popupHtml).toMatch(/<link\s+rel="stylesheet"\s+href="popup\.css"\s*\/?>/u);
    expect(popupCss).toContain('#0a0a0b');
    expect(popupCss).toContain('#818cf8');
    expect(popupCss).toContain('#6366f1');
  });

  it('test_task_panels_present_and_question_card_hosted_unchanged', () => {
    // The three task panels exist: Tasks and Evidence as sections of the
    // Tasks tab panel, Questions as the persistent strip above the panels
    // (always visible, whichever tab is open — Task 6's guarantee).
    for (const panel of ['tasks', 'questions', 'evidence']) {
      expect(popupHtml, `data-task-panel="${panel}"`).toContain(`data-task-panel="${panel}"`);
    }
    const questionsAt = popupHtml.indexOf('id="taskQuestions"');
    expect(questionsAt).toBeGreaterThan(-1);
    const panelsAt = popupHtml.indexOf('<main class="panels">');
    expect(panelsAt).toBeGreaterThan(-1);
    expect(questionsAt).toBeLessThan(panelsAt);
    // Ruling P1: the Task 6 card is hosted, not rebuilt — the same module
    // still renders it, the same view still owns #taskQuestions, and
    // popup.js still binds it.
    const questionViewSource = readFileSync(questionViewPath, 'utf8');
    expect(questionViewSource).toContain("getElementById('taskQuestions')");
    expect(questionViewSource).toContain('renderQuestionCards');
    expect(popupJs).toContain('bindTaskQuestions');
    const html = renderQuestionCard({
      id: 'q-1',
      taskId: 'task-1',
      text: 'Which report should I open?',
      options: ['Sales', 'Stock'],
      kind: 'choice',
    });
    expect(html).toContain('data-action="answerQuestion"');
    expect(html).toContain('data-answer="Sales"');
  });
});

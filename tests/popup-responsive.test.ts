import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderQuestionCard } from '../extension/popup/question-card.js';

const repoRoot = join(import.meta.dirname, '..');
const popupHtmlPath = join(repoRoot, 'extension', 'popup', 'popup.html');
const popupCssPath = join(repoRoot, 'extension', 'popup', 'popup.css');
const popupJsPath = join(repoRoot, 'extension', 'popup', 'popup.js');
const questionCardPath = join(repoRoot, 'extension', 'popup', 'question-card.js');
const questionViewPath = join(repoRoot, 'extension', 'popup', 'question-view.js');
const openTabsViewPath = join(repoRoot, 'extension', 'popup', 'open-tabs-view.js');

const popupHtml = readFileSync(popupHtmlPath, 'utf8');
const popupJs = readFileSync(popupJsPath, 'utf8');
/** The extracted stylesheet; '' before Task 9 extracts it, so every rule assertion fails (RED) instead of throwing. */
const popupCss = existsSync(popupCssPath) ? readFileSync(popupCssPath, 'utf8') : '';

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

/** Concatenated inner text of every @media block whose query contains `query` (e.g. 'min-width: 500px'). */
function mediaBlocks(css: string, query: string): string {
  const blocks: string[] = [];
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) break;
    const open = css.indexOf('{', at);
    if (open === -1) break;
    const header = css.slice(at, open);
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
    if (header.includes(query)) blocks.push(css.slice(open + 1, j));
    i = j + 1;
  }
  return blocks.join('\n');
}

/** The declaration block of the rule for this exact selector inside a CSS fragment, or '' when absent. */
function ruleBody(fragment: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fragment.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'));
  return match ? match[1] : '';
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
    // Fix round 1: the two controls the first version missed. The Activity
    // "Clear" button's .btn-mini 44px was overridden to 30px by the more
    // specific .activity-clear rule, and .field input (port / token /
    // enrollment / profile name) declared no min-height at all (~37px).
    expect(popupHtml).toContain('btn-mini activity-clear');
    expect(baseMinHeight(popupCss, '.activity-panel .activity-clear'), '.activity-clear').toBeGreaterThanOrEqual(44);
    expect(baseMinHeight(popupCss, '.field input'), '.field input').toBeGreaterThanOrEqual(44);
    // The toggles' hit areas are their labels, not the 18px switch visuals:
    // the Activity "Element details" label was a single ~17px line, and the
    // Settings .switch-row labels clear 44px on title + hint already — both
    // now state 44px so the claim above holds for them too.
    expect(baseMinHeight(popupCss, '.activity-name-toggle'), '.activity-name-toggle').toBeGreaterThanOrEqual(44);
    expect(baseMinHeight(popupCss, '.switch-row'), '.switch-row').toBeGreaterThanOrEqual(44);
    // The switches are visually smaller than their clickable labels.
  });

  it('test_evidence_list_capped_at_500px', () => {
    // Fix round 1: the 500px breakpoint used to lift the Evidence cap
    // (max-height: none) while the shell never scrolls, so a long Evidence
    // list grew unboundedly and squeezed the Tasks list to zero height.
    // The cap (180px, as at base) and internal scrolling must survive 500px.
    expect(baseMinHeight(popupCss, '.evidence-list'), '.evidence-list base cap').toBe(180);
    const wide = mediaBlocks(popupCss, 'min-width: 500px');
    expect(wide).toContain('.evidence-list');
    const body = ruleBody(wide, '.evidence-list');
    expect(body).toMatch(/max-height:\s*180px/u);
    expect(body).not.toMatch(/max-height:\s*none/u);
    expect(body).toMatch(/overflow-y:\s*auto/u);
    // The row separators survive the two-column grid too: the sibling rule
    // is still stripped (it would draw a stray line above the top-right
    // cell), but visual rows 2+ get their separator back via nth-child.
    const separators = ruleBody(wide, '.evidence-list .evidence-row:nth-child(n+3)');
    expect(separators).toMatch(/border-top:\s*1px solid var\(--border\)/u);
  });

  it('uses the browser side panel and matches its tab orientation to the layout', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'extension', 'manifest.json'), 'utf8'));
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.side_panel.default_path).toBe('popup/popup.html');
    expect(manifest.action).not.toHaveProperty('default_popup');
    expect(popupHtml).not.toContain('id="resizer"');
    expect(ruleBody(popupCss, '.tabbar')).toContain('repeat(5, minmax(0, 1fr))');
    const wide = mediaBlocks(popupCss, 'min-width: 560px');
    expect(ruleBody(wide, '.tabbar')).toContain('flex-direction: column');
    expect(popupJs).toContain("matchMedia('(min-width: 560px)')");
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } from '../extension/lib/page-dom.js';

class NodeStub {
  id = '';
  style: Record<string, string> = {};
  children: NodeStub[] = [];
  animations: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  setAttribute() {}
  appendChild(child: NodeStub) { this.children = this.children.filter((item) => item !== child); this.children.push(child); return child; }
  insertBefore(child: NodeStub) { this.children.unshift(child); }
  get lastChild() { return this.children.at(-1); }
  get lastElementChild() { return this.lastChild; }
  animate(frames: Keyframe[], options: KeyframeAnimationOptions) { this.animations.push({ frames, options }); return { onfinish: null }; }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('agent cursor', () => {
  it('stays visible between actions and glides from the previous position', () => {
    vi.useFakeTimers();
    const root = new NodeStub();
    const doc = { documentElement: root, visibilityState: 'visible', createElement: () => new NodeStub(), createElementNS: () => new NodeStub(), getElementById: (id: string) => root.children.find((el) => el.id === id) };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('__bcDom', undefined);
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
    const cursor = (globalThis as any).__bcDom.cursor;
    expect(cursor(20, 30)).toBe(0);
    vi.advanceTimersByTime(5000);
    const marker = root.children.find((el) => el.id === '__bc-agent-cursor')!;
    expect(marker.style.opacity).toBe('1');
    expect(cursor(420, 230)).toBeGreaterThan(0);
    expect(marker.animations.at(-1)?.frames).toEqual([
      { transform: 'translate(20px,30px)' },
      { transform: 'translate(420px,230px)' },
    ]);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(cursor(100, 100)).toBe(0);
    expect(marker.style.transform).toBe('translate(100px,100px)');
    vi.advanceTimersByTime(30_000);
    expect(marker.style.opacity).toBe('0');
  });
});

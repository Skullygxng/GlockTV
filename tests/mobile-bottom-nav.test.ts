import { describe, expect, it } from 'vitest';
import appStyles from '../src/styles.css?raw';
import liveTvStyles from '../src/live-tv.css?raw';
import premiumStyles from '../src/premium.css?raw';
import appSource from '../src/App.tsx?raw';
import liveTvIntegration from '../src/components/LiveTvIntegration.tsx?raw';

/*
 * The mobile tab bar, and the mistake it made once.
 *
 * Live TV portals a sixth button into .bottom-nav at runtime, so the number of
 * buttons is not knowable from the markup. The nav used to be a grid with a
 * hard-coded column count that had to be kept in step with that by hand;
 * adding the account entry point made six buttons compete for five columns and
 * the Live button wrapped onto a second row, out of the nav's own box and into
 * the browser chrome.
 *
 * These assert the shape that makes the bug unrepresentable rather than fixed:
 * the nav sizes itself by how many buttons it has, and there is one definition
 * of how much room it occupies.
 */

function navRule(css: string): string {
  return css.match(/\.bottom-nav\{position:fixed[^}]*\}/)?.[0] ?? '';
}

describe('the mobile tab bar sizes itself by its contents', () => {
  it('lays out with flex, not a fixed column count', () => {
    const rule = navRule(appStyles);
    expect(rule).toContain('display:flex');
    expect(rule).not.toContain('grid-template-columns');
  });

  it('lets every button take an equal share, however many there are', () => {
    const button = appStyles.match(/\.bottom-nav button\{[^}]*\}/)?.[0] ?? '';
    expect(button).toContain('flex:1 1 0');
    // Without this a long label would refuse to shrink and force an overflow.
    expect(button).toContain('min-width:0');
  });

  it('has no stylesheet pinning the nav to a fixed number of columns', () => {
    /*
     * The original break came from live-tv.css overriding the column count with
     * !important, so the two files had to agree about a number neither of them
     * owned.
     */
    for (const css of [appStyles, liveTvStyles, premiumStyles]) {
      expect(css).not.toMatch(/\.bottom-nav\{[^}]*grid-template-columns/);
      expect(css).not.toMatch(/\.bottom-nav[^{]*\{[^}]*repeat\(\d+,\s*1fr\)/);
    }
  });

  it('still expects a button it does not render itself', () => {
    // If this ever stops being true the flex layout is still correct, but the
    // reason for it is worth keeping visible.
    expect(liveTvIntegration).toContain("document.querySelector('.bottom-nav')");
    expect(appSource).toContain('MobileAccountButton');
  });
});

describe('the space the tab bar occupies is defined once', () => {
  it('defines a single nav-height variable that includes the safe area', () => {
    expect(appStyles).toMatch(/--bottom-nav-h:\s*calc\(62px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  });

  it('keeps the nav clear of the home indicator and browser chrome', () => {
    const rule = navRule(appStyles);
    expect(rule).toContain('height:var(--bottom-nav-h)');
    expect(rule).toContain('padding-bottom:env(safe-area-inset-bottom, 0px)');
  });

  it('has nothing left reserving a hard-coded 62px of room', () => {
    /*
     * Every consumer reads the variable, so the nav's height and the space
     * reserved for it cannot drift apart - which is what would put content
     * underneath it on a device with a home indicator.
     */
    for (const [name, css] of [
      ['styles.css', appStyles],
      ['live-tv.css', liveTvStyles],
      ['premium.css', premiumStyles],
    ] as const) {
      const stale = css.match(/(calc\(100svh - 62px\)|padding-bottom:\s*62px|bottom:\s*calc\(62px)/g) ?? [];
      expect(stale, `${name} still hard-codes the nav height`).toEqual([]);
    }
  });

  it('reserves room for the nav using that same variable', () => {
    expect(appStyles).toContain('calc(100svh - var(--bottom-nav-h))');
    expect(appStyles).toContain('padding-bottom:var(--bottom-nav-h)');
    expect(liveTvStyles).toContain('bottom:var(--bottom-nav-h)');
  });
});

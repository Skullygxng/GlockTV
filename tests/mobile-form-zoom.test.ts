import { describe, expect, it } from 'vitest';
import appStyles from '../src/styles.css?raw';

describe('mobile form controls', () => {
  it('keeps every editable field at an iPhone-safe 16px minimum', () => {
    expect(appStyles).toContain('@media(max-width:700px){input,textarea,select{font-size:16px}');
    expect(appStyles).toMatch(/\.mobile-searchbar input\{[^}]*font-size:16px/);
  });
});

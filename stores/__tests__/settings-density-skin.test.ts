import { describe, it, expect } from 'vitest';
import { densityVarsFor, type Density } from '@/stores/settings-store';

// Gmail has three row rhythms and this fork has four. The four are laid over
// Gmail's scale rather than left meaning whatever they meant before.

const px = (value: string) => Number.parseInt(value, 10);
const ROW = (density: Density, skin: 'bulwark' | 'gmail') =>
  px(densityVarsFor(density, skin)['--list-item-height']);

describe('densityVarsFor', () => {
  it('lands the three shared names on Gmail\'s own heights', () => {
    expect(ROW('compact', 'gmail')).toBe(32);
    expect(ROW('regular', 'gmail')).toBe(40);
    expect(ROW('comfortable', 'gmail')).toBe(48);
  });

  it('continues the series below compact rather than dropping a choice', () => {
    expect(ROW('extra-compact', 'gmail')).toBeLessThan(ROW('compact', 'gmail'));
  });

  it('keeps every step distinct, so all four settings still do something', () => {
    const heights = (['extra-compact', 'compact', 'regular', 'comfortable'] as Density[])
      .map((density) => ROW(density, 'gmail'));
    expect(new Set(heights).size).toBe(4);
    expect([...heights]).toEqual([...heights].sort((a, b) => a - b));
  });

  it('leaves the default skin exactly as it was', () => {
    expect(densityVarsFor('regular', 'bulwark')['--list-item-height']).toBe('48px');
    expect(densityVarsFor('compact', 'bulwark')['--list-item-height']).toBe('auto');
    expect(densityVarsFor('extra-compact', 'bulwark')['--density-item-py']).toBe('2px');
  });

  it('restates only the vertical rhythm, not the rest of the spacing', () => {
    const gmail = densityVarsFor('regular', 'gmail');
    const bulwark = densityVarsFor('regular', 'bulwark');
    expect(gmail['--density-card-p']).toBe(bulwark['--density-card-p']);
    expect(gmail['--density-sidebar-py']).toBe(bulwark['--density-sidebar-py']);
    expect(gmail['--density-item-py']).not.toBe(bulwark['--density-item-py']);
  });
});

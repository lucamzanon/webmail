import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FilterPanelHost } from '../filter-panel-host';

// The Gmail skin moves the filter button into the global top bar. The panel
// follows it there, given an anchor; without one it stays in the flow of the
// message-list column, which is the default skin's arrangement.

describe('FilterPanelHost', () => {
  it('renders in place when there is no anchor', () => {
    const { container } = render(
      <FilterPanelHost anchor={null}><span>filters</span></FilterPanelHost>
    );

    expect(container).toContainElement(screen.getByText('filters'));
    expect(container.querySelector('[data-skin-filter-panel]')).toBeNull();
  });

  it('drops the panel into the anchor when there is one', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);

    const { container } = render(
      <FilterPanelHost anchor={anchor}><span>filters</span></FilterPanelHost>
    );

    expect(anchor).toContainElement(screen.getByText('filters'));
    expect(container).not.toContainElement(screen.getByText('filters'));
    expect(anchor.querySelector('[data-skin-filter-panel]')).not.toBeNull();

    anchor.remove();
  });
});

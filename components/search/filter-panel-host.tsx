"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where the advanced-filter panel is drawn.
 *
 * With no anchor it stays where it has always been: in the flow of the
 * message-list column, directly under the header that carries the filter
 * button. That is the default skin, and nothing about it changes.
 *
 * The Gmail skin moves the filter button up into the global top bar, next to
 * the search field, and the panel stayed behind - the control was in one place
 * and its panel in another, with the list header in between. Given the anchor
 * the top bar renders under its search field, the panel is portalled there
 * instead and drops from the field it belongs to, as Gmail's does. It is a
 * portal rather than a moved element because the panel's contents read a
 * couple of dozen values and callbacks out of the page that owns them.
 */
export function FilterPanelHost({
  anchor,
  children,
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const panel = (
    <div className="px-3 pb-3 space-y-2.5 animate-in slide-in-from-top-1 fade-in duration-150">
      {children}
    </div>
  );

  if (!anchor) return panel;

  return createPortal(
    <div
      data-skin-filter-panel=""
      className="mt-1 rounded-lg border border-border bg-popover pt-3 shadow-xl"
    >
      {panel}
    </div>,
    anchor
  );
}

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { PrimaryActionContext } from './primary-action-context';
import type { PrimaryAction } from './primary-action-context';

/**
 * Holder for the application's single primary action.
 *
 * Phase 1 gave every route its own 新增记录 button inside its own page header, which is defensible
 * but has two costs: the button moves vertically as the page header grows, and the shell — the one
 * part of the interface that never changes — carried no action at all while a 56 px brand bar carried
 * only a title.
 *
 * Phase 2 puts one primary action in the shell and lets the current view decide what it means:
 * 新增记录 on 概览 / 工作, 新增荣誉 on 荣誉, nothing on 台账 / 报告 / 设置. A context rather than a
 * prop chain because the owner and the renderer are far apart: the page owns the dialog, its draft
 * state and its submit logic, and none of that should move into the shell to satisfy a layout
 * decision.
 */
export function PrimaryActionProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [action, setAction] = useState<PrimaryAction | null>(null);
  const value = useMemo(() => ({ action, setAction }), [action]);
  return <PrimaryActionContext.Provider value={value}>{children}</PrimaryActionContext.Provider>;
}

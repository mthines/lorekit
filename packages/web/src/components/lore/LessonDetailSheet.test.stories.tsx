import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { LessonDetailSheet } from './LessonDetailSheet';
import type { ContentTab } from './content-tabs';
import type { LessonEntry } from './LessonCard';
import { withQueryClient } from '@/mocks/decorators';

/**
 * Interaction tests for {@link LessonDetailSheet} — the mobile bottom-sheet
 * presentation (`layout="sheet"` forces the sheet regardless of the test
 * viewport). Two groups:
 *   • Dismissal — backdrop tap, Escape on a clean form, drag the handle down.
 *   • Content tabs — Preview is default, markdown renders, untrusted HTML is
 *     sanitized, tabs switch by click + arrow keys, editing reveals the save bar.
 *
 * None of these touch the network: a personal lesson skips the member-identity
 * fetch, and no save/archive is committed (the save-bar test only reveals the
 * bar, it never clicks Save — the save itself is a `'use server'` action with no
 * server in the browser test harness).
 */

/** Markdown value so the Preview tab renders a `<strong>` (from `**…**`). */
const LESSON: LessonEntry = {
  key: 'prefer-server-actions',
  value: 'Reach for a **server action** over a route handler for dashboard mutations.',
  tags: ['auth'],
  created_at: '2026-06-15T09:00:00Z',
  updated_at: '2026-07-28T14:30:00Z',
  scope: 'repo::mthines/lorekit',
  scope_type: 'repo',
};

/** Untrusted content: a `javascript:` link plus raw HTML that must never execute. */
const MALICIOUS: LessonEntry = {
  ...LESSON,
  key: 'untrusted-content',
  value: [
    '[click me](javascript:alert(1))',
    '',
    '<script>window.__xss_pwned = true;</script>',
    '',
    '<img src=x onerror="window.__xss_pwned = true;">',
    '',
    'plain **text**',
  ].join('\n'),
};

/** Archived lore is read-only: the Edit tab is disabled and Preview is forced. */
const ARCHIVED: LessonEntry = {
  ...LESSON,
  key: 'archived-lesson',
  archived_at: '2026-07-30T10:00:00Z',
};

/** Recurred often enough to clear the promotion threshold (seen_count >= 3). */
const RECURRING: LessonEntry = {
  ...LESSON,
  key: 'recurring-lesson',
  kind: 'lesson',
  host: 'reviewer',
  seen_count: 5,
};

/** Recurred, but not enough to clear the promotion threshold. */
const RECURRING_BELOW_THRESHOLD: LessonEntry = {
  ...LESSON,
  key: 'recurring-lesson-below-threshold',
  seen_count: 1,
};

/** Controlled open state so a dismissal actually unmounts the panel. */
function Harness({
  onClose,
  lesson = LESSON,
  initialContentTab,
}: {
  onClose: () => void;
  lesson?: LessonEntry;
  initialContentTab?: ContentTab;
}) {
  const [open, setOpen] = useState(true);
  return (
    <LessonDetailSheet
      lesson={open ? lesson : null}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
      layout="sheet"
      initialContentTab={initialContentTab}
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Lore/LessonDetailSheet/Tests',
  component: Harness,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'centered',
  },
  args: { onClose: fn() },
  decorators: [withQueryClient],
};

export default meta;
type Story = StoryObj<typeof Harness>;

const body = () => within(document.body);
const backdrop = () => document.body.querySelector('[data-testid="lesson-sheet-backdrop"]');
const handle = () => document.body.querySelector('[data-testid="lesson-sheet-drag-handle"]');
const previewPanel = () => document.getElementById('content-panel-preview');
// The content field is the ONLY <textarea> in the sheet — Tags and Expiry are
// <input> elements, so `role=textbox` is ambiguous but the element query is not.
const contentTextarea = () => document.querySelector('#content-panel-edit textarea');

/**
 * The panel focuses its close button ~80 ms after open — but ONLY when focus is
 * not already inside the dialog when the timer fires. If a story has already
 * placed focus inside the panel, the steal is skipped (the guard in
 * `LessonDetailSheet.tsx`), so awaiting this helper after moving focus into the
 * panel would hang; it is for the default open, where nothing has taken focus.
 *
 * **The rule: await this before any keyboard interaction with the panel.**
 * Left unsettled, the timer fires mid-story and moves focus — which drops the
 * tail of a `userEvent.type` (the original CI flake) or takes a tab out of
 * focus before the tablist's own `onKeyDown` can read the arrow key. Keeping it
 * uniform is deliberate: a per-story "is this one exposed?" judgement is the
 * kind of rule that gets re-derived wrongly by the next author. Pointer-only
 * stories (click, drag, backdrop tap) do not need it.
 */
const settleOpenFocus = () =>
  waitFor(() =>
    expect(body().getByRole('button', { name: /close detail panel/i })).toHaveFocus(),
  );

// ── Dismissal ────────────────────────────────────────────────────────────────

export const OpensAsASheet: Story = {
  play: async ({ step }) => {
    await step('the panel renders as a dialog with a drag handle + backdrop', async () => {
      await expect(await body().findByRole('dialog', { name: /memory detail/i })).toBeVisible();
      await expect(handle()).toBeInTheDocument();
      await expect(backdrop()).toBeInTheDocument();
    });
  },
};

export const BackdropTapCloses: Story = {
  play: async ({ args, step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('tapping the backdrop dismisses the sheet', async () => {
      const overlay = backdrop();
      if (!overlay) throw new Error('backdrop not found');
      await userEvent.click(overlay);
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

export const EscapeCloses: Story = {
  play: async ({ args, step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await settleOpenFocus();
    await step('Escape on a clean form dismisses the sheet', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

/** Drive Motion's drag with real PointerEvents (see BottomSheet tests). */
function pointer(type: string, target: EventTarget, clientY: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      clientX: 180,
      clientY,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  );
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

export const DragDownCloses: Story = {
  play: async ({ args, step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('dragging the handle down past the threshold dismisses the sheet', async () => {
      const grip = handle();
      if (!grip) throw new Error('drag handle not found');
      pointer('pointerdown', grip, 24);
      await nextFrame();
      for (const y of [90, 180, 260, 340]) {
        pointer('pointermove', window, y);
        await nextFrame();
      }
      pointer('pointerup', window, 340);
      await waitFor(() => expect(body().queryByRole('dialog')).not.toBeInTheDocument());
      await expect(args.onClose).toHaveBeenCalled();
    });
  },
};

export const OpenFocusSkipsWhenAlreadyInside: Story = {
  // The open-focus effect (~80 ms after open) moves focus to the close button
  // ONLY when focus is not already inside the dialog — a fast click straight
  // into a control must not have its keystrokes swallowed. This puts focus on a
  // tab WITHIN the 80 ms window and asserts the timer does not steal it.
  //
  // Non-vacuous by construction: the pre-guard code was an unconditional
  // `close.focus()`, which — with focus placed here well inside the window —
  // would move focus to the close button by the time the wait elapses, failing
  // both assertions below (same shape as ArchivedLoreIsPreviewOnly, written to
  // fail the pre-fix behaviour).
  play: async ({ step }) => {
    // Place focus inside the dialog SYNCHRONOUSLY, before the first `await` can
    // yield to the event loop and let the ~80 ms open-focus timer fire. The
    // component is already mounted when `play` runs (the harness opens with the
    // lesson set, and AnimatePresence renders its children on the mount commit),
    // so the Edit tab is queryable with a synchronous `getByRole` — no async
    // `findBy*` needed. Gating this focus behind an awaited query would race the
    // timer: if the query resolved after ~80 ms the timer would already have run
    // with focus OUTSIDE the panel, the guard's skip-branch would never be
    // exercised, and the story would go green without testing the guard at all.
    // A tab is focusable via .focus() (roving tabindex uses -1, not removal) and
    // focusing it does not select it, so the panel is otherwise untouched.
    const editTab = body().getByRole('tab', { name: /edit/i });
    editTab.focus();
    await expect(editTab).toHaveFocus();
    await step('focus placed inside the panel before the timer is not stolen', async () => {
      // Wait past the ~80 ms timer. With the guard this is a no-op; the pre-guard
      // unconditional focus would have pulled focus onto the close button by now.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(editTab).toHaveFocus();
      await expect(body().getByRole('button', { name: /close detail panel/i })).not.toHaveFocus();
    });
  },
};

// ── Content tabs ─────────────────────────────────────────────────────────────

export const PreviewIsDefault: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('Preview is the selected tab and renders markdown, not raw source', async () => {
      await expect(body().getByRole('tab', { name: /preview/i })).toHaveAttribute('aria-selected', 'true');
      await expect(body().getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'false');
      const panel = previewPanel();
      if (!panel) throw new Error('preview panel not found');
      // "server action" came from `**server action**`, so it renders inside <strong>.
      await expect(within(panel).getByText('server action')).toBeVisible();
      await expect(panel.querySelector('strong')).not.toBeNull();
      // The content field (the sheet's only <textarea>) is absent while previewing.
      await expect(contentTextarea()).toBeNull();
    });
  },
};

export const InitialContentTabIsHonoured: Story = {
  // The reset-to-Preview effect used to fire on mount too, so the Edit tab this
  // prop asks for was overwritten before paint. Regression guard.
  render: (args) => <Harness onClose={args.onClose} initialContentTab="edit" />,
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('initialContentTab="edit" opens on the textarea, not Preview', async () => {
      await waitFor(() => expect(contentTextarea()).not.toBeNull());
      await expect(body().getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'true');
      await expect(previewPanel()).toBeNull();
    });
  },
};

export const ArchivedLoreIsPreviewOnly: Story = {
  // The `canEdit: false` branch: the Edit tab is disabled, must not announce a
  // shortcut it will not honour, and neither the key nor a click can leave
  // Preview. Only the pure spec covered this before.
  render: (args) => <Harness onClose={args.onClose} lesson={ARCHIVED} />,
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await settleOpenFocus();
    await step('the Edit tab is disabled and announces no shortcut', async () => {
      const edit = body().getByRole('tab', { name: /edit/i });
      await expect(edit).toBeDisabled();
      await expect(edit).not.toHaveAttribute('aria-keyshortcuts');
      await expect(body().getByRole('tab', { name: /preview/i })).toHaveAttribute(
        'aria-keyshortcuts',
        'P',
      );
    });
    await step('neither the E shortcut nor a click can leave Preview', async () => {
      await userEvent.keyboard('e');
      await expect(contentTextarea()).toBeNull();
      await expect(previewPanel()).not.toBeNull();
      await userEvent.click(body().getByRole('tab', { name: /edit/i }));
      await expect(contentTextarea()).toBeNull();
      await expect(body().getByRole('tab', { name: /preview/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  },
};

export const SanitizesUntrustedMarkdown: Story = {
  // Explicit render (not args) so the malicious lesson is unambiguously the one
  // rendered — the assertions must exercise the untrusted content, not the default.
  render: (args) => <Harness onClose={args.onClose} lesson={MALICIOUS} />,
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('raw HTML is inert text and a javascript: link is stripped', async () => {
      const panel = previewPanel();
      if (!panel) throw new Error('preview panel not found');
      // The malicious lesson really is what rendered: its safe markdown
      // (`plain **text**`) is present, so the assertions below are not vacuous.
      await expect(panel.textContent ?? '').toContain('plain');
      await expect(panel.querySelector('strong')).not.toBeNull();
      // Raw <script>/<img> in the source produce no elements (react-markdown
      // drops raw HTML — no rehype-raw — so it is neither injected nor executed).
      await expect(panel.querySelector('script')).toBeNull();
      await expect(panel.querySelector('img')).toBeNull();
      // The javascript: URL was removed from the rendered link's href. The
      // anchor itself must still exist — `rehype-sanitize` strips the unsafe
      // protocol, not the element — so assert it before reading the href;
      // guarding with `if (link)` would let this pass vacuously.
      const link = panel.querySelector('a');
      await expect(link).not.toBeNull();
      await expect((link as HTMLAnchorElement).getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
      // Nothing executed.
      await expect((window as unknown as { __xss_pwned?: boolean }).__xss_pwned).toBeUndefined();
    });
  },
};

export const SwitchToEditRevealsTextarea: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('clicking Edit shows the raw-markdown textarea', async () => {
      await userEvent.click(body().getByRole('tab', { name: /edit/i }));
      await waitFor(() => expect(contentTextarea()).not.toBeNull());
      await expect(contentTextarea() as HTMLElement).toBeVisible();
      await expect(body().getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'true');
      await expect(previewPanel()).toBeNull();
    });
  },
};

export const SwitchBackToPreviewRenders: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('Edit → Preview swaps the textarea back for rendered markdown', async () => {
      await userEvent.click(body().getByRole('tab', { name: /edit/i }));
      await waitFor(() => expect(contentTextarea()).not.toBeNull());
      await userEvent.click(body().getByRole('tab', { name: /preview/i }));
      await waitFor(() => expect(contentTextarea()).toBeNull());
      await expect(previewPanel()).not.toBeNull();
    });
  },
};

export const ArrowKeysSwitchTabs: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await settleOpenFocus();
    await step('arrow keys move the active tab (roving tabindex)', async () => {
      body().getByRole('tab', { name: /preview/i }).focus();
      await userEvent.keyboard('{ArrowRight}');
      await expect(body().getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'true');
      await userEvent.keyboard('{ArrowLeft}');
      await expect(body().getByRole('tab', { name: /preview/i })).toHaveAttribute('aria-selected', 'true');
    });
  },
};

export const EditingRevealsSaveBar: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await settleOpenFocus();
    await step('typing in the Edit textarea reveals the pinned Discard/Save bar', async () => {
      await userEvent.click(body().getByRole('tab', { name: /edit/i }));
      await waitFor(() => expect(contentTextarea()).not.toBeNull());
      await userEvent.type(contentTextarea() as HTMLTextAreaElement, ' Keep RLS central.');
      // The bar mounts then animates opacity 0→1 (Motion), so poll for visibility.
      const bar = await body().findByRole('region', { name: /unsaved changes/i });
      await waitFor(() => expect(bar).toBeVisible());
      await expect(body().getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  },
};

export const KeyboardShortcutsSwitchTabs: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await settleOpenFocus();
    await step('E → Edit, P → Preview when focus is not in a form field', async () => {
      body().getByRole('tab', { name: /preview/i }).focus();
      await userEvent.keyboard('e');
      await waitFor(() => expect(contentTextarea()).not.toBeNull());
      await expect(body().getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'true');
      await userEvent.keyboard('p');
      await waitFor(() => expect(contentTextarea()).toBeNull());
      await expect(body().getByRole('tab', { name: /preview/i })).toHaveAttribute('aria-selected', 'true');
    });
  },
};

// ── Provenance ───────────────────────────────────────────────────────────────

export const RecurrencePastThresholdShowsPromoteAffordance: Story = {
  render: (args) => <Harness onClose={args.onClose} lesson={RECURRING} />,
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('kind, host and a "promote?" badge render for seen_count >= 3', async () => {
      await expect(body().getByText('lesson')).toBeVisible();
      await expect(body().getByText('reviewer')).toBeVisible();
      await expect(body().getByText('seen 5×')).toBeVisible();
      await expect(body().getByText('promote?')).toBeVisible();
    });
  },
};

export const RecurrenceBelowThresholdShowsNoPromoteAffordance: Story = {
  render: (args) => <Harness onClose={args.onClose} lesson={RECURRING_BELOW_THRESHOLD} />,
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('the count renders without the promotion badge below the threshold', async () => {
      await expect(body().getByText('seen 1×')).toBeVisible();
      await expect(body().queryByText('promote?')).not.toBeInTheDocument();
    });
  },
};

export const NoProvenanceRendersNoEmptyLabels: Story = {
  // A memory with no kind/host/source_agent/trigger/seen_count/origin must not
  // render any of those labels — an empty `<dt>Kind</dt>` with no value would
  // be clutter, and the whole Source cluster is conditional on this data
  // existing at all.
  render: (args) => <Harness onClose={args.onClose} lesson={LESSON} />,
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await step('no provenance label renders for a memory that carries none of it', async () => {
      await expect(body().queryByText('Kind')).not.toBeInTheDocument();
      await expect(body().queryByText('Host')).not.toBeInTheDocument();
      await expect(body().queryByText('Recurrence')).not.toBeInTheDocument();
    });
  },
};

export const ShortcutIgnoredWhileTyping: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
    await settleOpenFocus();
    await step('typing p/e inside the textarea never switches tabs', async () => {
      await userEvent.click(body().getByRole('tab', { name: /edit/i }));
      await waitFor(() => expect(contentTextarea()).not.toBeNull());
      const textarea = contentTextarea() as HTMLTextAreaElement;
      textarea.focus();
      await userEvent.type(textarea, ' peek'); // contains both 'p' and 'e'
      // The letters landed in the field (poll — the controlled value settles async).
      await waitFor(() => expect((contentTextarea() as HTMLTextAreaElement | null)?.value ?? '').toContain('peek'));
      // …and the tab never switched: still Edit, textarea still present.
      await expect(body().getByRole('tab', { name: /edit/i })).toHaveAttribute('aria-selected', 'true');
      await expect(contentTextarea()).not.toBeNull();
    });
  },
};

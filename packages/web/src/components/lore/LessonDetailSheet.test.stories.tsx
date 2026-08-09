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
      // The javascript: URL was removed from the rendered link's href.
      const link = panel.querySelector('a');
      if (link) await expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
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

export const ShortcutIgnoredWhileTyping: Story = {
  play: async ({ step }) => {
    await body().findByRole('dialog', { name: /memory detail/i });
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

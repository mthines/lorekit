import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';

import { GroomingRuleBuilder } from './GroomingRuleBuilder';
import { groomHandlers, memoryHandlers } from '@/mocks/memories';
import { withQueryClient } from '@/mocks/decorators';

/**
 * Interaction tests for the LIST-FIRST {@link GroomingRuleBuilder}: Add opens
 * the dialog, the scope combobox accepts a creatable value, the live preview
 * count updates, Save closes the dialog and the row appears, and a Run-now over
 * the threshold routes through a confirm. `/Tests` namespace, `test`-tagged,
 * `chromatic.disableSnapshot` so the visual `afterEach` skips these (per
 * `docs/storybook.md`). Portaled surfaces (the combobox popover) are queried via
 * `document.body`; the dialog and its confirm render inline in the canvas.
 *
 * No toast decorator needed — the component calls sonner's `showToast`
 * (`@/lib/toast`) directly, and sonner renders nothing without a mounted
 * `<Toaster>`, so a toast call here is simply a no-op rather than an error.
 */

const meta: Meta<typeof GroomingRuleBuilder> = {
  title: 'Settings/GroomingRuleBuilder/Tests',
  component: GroomingRuleBuilder,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [...groomHandlers(), ...memoryHandlers()] },
    // The component reads `useRouter`/`useSearchParams` to consume the
    // one-shot `?prefillScope=…` handoff from the Lore Explorer.
    // `appDirectory: true` mounts `@storybook/nextjs-vite`'s App Router
    // context so those hooks resolve instead of throwing "expected app
    // router to be mounted".
    nextjs: { appDirectory: true },
  },
  decorators: [withQueryClient],
};

export default meta;
type Story = StoryObj<typeof GroomingRuleBuilder>;

/** Pick a scope through the combobox: open it, type a creatable value, commit. */
async function chooseScope(scope: string) {
  const body = within(document.body);
  await userEvent.click(await body.findByRole('button', { name: /^Scope:/ }));
  const search = await body.findByPlaceholderText(/search or type a scope/i);
  // Set the query in one shot: the combobox re-renders heavily on every
  // keystroke, and per-key typing drops characters out of `::`-bearing scopes.
  fireEvent.change(search, { target: { value: scope } });
  // The creatable "use this scope" row carries the typed scope as its label.
  await userEvent.click(await body.findByText(scope, { selector: '[role="option"] *' }));
}

export const AddSaveAndRun: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('Add opens the dialog', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: /add policy/i }));
      await expect(await canvas.findByText(/new retention policy/i)).toBeInTheDocument();
    });

    await step('the scope combobox accepts a creatable value + preview updates', async () => {
      await chooseScope('repo::acme/app');
      await waitFor(
        async () => {
          await expect(canvas.getByText(/match this rule/i)).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    await step('the Auto (nightly) switch toggles on click', async () => {
      const toggle = canvas.getByRole('switch', { name: 'Auto (nightly)' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(toggle);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    await step('Save closes the dialog and the new row appears', async () => {
      await userEvent.type(await canvas.findByLabelText('Policy name'), 'Fresh sweep');
      await userEvent.click(canvas.getByRole('button', { name: /save policy/i }));
      await waitFor(
        async () => {
          await expect(canvas.queryByText(/new retention policy/i)).not.toBeInTheDocument();
        },
        { timeout: 3000 },
      );
      await expect(await canvas.findByText('Fresh sweep')).toBeInTheDocument();
    });
  },
};

/** Run now over the confirm threshold routes through the confirm dialog. */
export const RunOverThresholdConfirms: Story = {
  parameters: {
    msw: {
      handlers: [
        // A high preview/run count so Run-now crosses RUN_CONFIRM_THRESHOLD (25).
        http.post('*/functions/v1/memories/groom/preview', () =>
          HttpResponse.json({ count: 40, keys: [] })),
        http.post('*/functions/v1/memories/groom/run', () =>
          HttpResponse.json({ archived: 40, keys: [] })),
        // A non-empty list so there is a single "Add policy" button (the empty
        // state renders a second one), keeping the trigger query unambiguous.
        ...groomHandlers(),
        ...memoryHandlers(),
      ],
    },
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('open the dialog and choose a scope', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: /add policy/i }));
      await chooseScope('repo::acme/app');
      // Wait on the DIALOG's live count (the row's "catches ~N" also shows 40),
      // so the form's own matchCount is settled before Run-now reads it.
      await waitFor(
        async () => {
          await expect(canvas.getByText(/match this rule/i)).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    await step('Run now over the threshold asks to confirm', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /run now/i }));
      await expect(await canvas.findByText(/run this rule now/i)).toBeInTheDocument();
      await expect(canvas.getByText(/archive 40 lessons/i)).toBeInTheDocument();
    });
  },
};

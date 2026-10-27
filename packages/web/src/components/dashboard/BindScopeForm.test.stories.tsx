import type { Meta, StoryObj } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import { BindScopeForm } from './BindScopeForm';
import { memoryHandlers } from '@/mocks/memories';
import { withQueryClient } from '@/mocks/decorators';

/**
 * Interaction tests for {@link BindScopeForm} against a catalog large enough to
 * have hidden scopes before: 150 `branch::acme/…` scopes that sort ahead of
 * `repo::zeta/lorekit`. The old form loaded an alphabetical prefix (500 memory
 * rows → at most 100 scopes → 20 chips), so searching for `lorekit` found
 * nothing. `/Tests` namespace, `test`-tagged, `chromatic.disableSnapshot` so the
 * visual `afterEach` skips these (per `docs/storybook.md`). The combobox popover
 * is portaled, so it is queried via `document.body`.
 */

const BRANCH_SCOPES = Array.from(
  { length: 150 },
  (_, i) => `branch::acme/agent-marketplace::feat/${String(i).padStart(3, '0')}`,
);
const CATALOG = [...BRANCH_SCOPES, 'repo::acme/api', 'repo::zeta/lorekit'];

/** `GET /memories/scopes` for {@link CATALOG}, ahead of the shared fixture's handler. */
const scopesHandler = http.get('*/functions/v1/memories/scopes', () =>
  HttpResponse.json({
    scopes: CATALOG.map((scope) => ({ scope, count: 1, last_activity: '2026-10-01T00:00:00.000Z' })),
  }),
);

const meta: Meta<typeof BindScopeForm> = {
  title: 'Dashboard/BindScopeForm/Tests',
  component: BindScopeForm,
  tags: ['test'],
  parameters: {
    chromatic: { disableSnapshot: true },
    layout: 'padded',
    msw: { handlers: [scopesHandler, ...memoryHandlers()] },
  },
  decorators: [withQueryClient],
  args: {
    orgName: 'Acme',
    boundScopes: ['repo::acme/api'],
    onBind: fn(async () => null),
    onCancel: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof BindScopeForm>;

/** Open the scope combobox and set the search query in one shot. */
async function search(query: string) {
  const body = within(document.body);
  await userEvent.click(await body.findByRole('button', { name: /^Scope:/ }));
  const input = await body.findByPlaceholderText(/search or type a scope/i);
  // One change event, not per-key typing: the combobox re-renders on every
  // keystroke and per-key typing drops characters out of `::`-bearing scopes.
  fireEvent.change(input, { target: { value: query } });
  return body;
}

export const FindsAScopeBeyondTheOldCap: Story = {
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a search finds a scope that sorts after 150 others', async () => {
      const body = await search('lorekit');
      const option = await body.findByRole('option', { name: /zeta\/lorekit/ });
      await expect(option).toBeInTheDocument();
      await expect(body.getAllByRole('option')).toHaveLength(1);
      await userEvent.click(option);
    });

    await step('Bind scope binds exactly the picked scope', async () => {
      await expect(canvas.getByText('repo::zeta/lorekit')).toBeInTheDocument();
      await userEvent.click(canvas.getByRole('button', { name: /bind scope/i }));
      await waitFor(() => expect(args.onBind).toHaveBeenCalledWith('repo::zeta/lorekit'));
      await expect(args.onBind).toHaveBeenCalledTimes(1);
    });
  },
};

export const DoesNotOfferABoundScope: Story = {
  play: async ({ step }) => {
    await step('the already-bound scope is neither listed nor offered as typed', async () => {
      const body = await search('repo::acme/api');
      await expect(await body.findByText('No matches')).toBeInTheDocument();
      await expect(body.queryByRole('option', { name: /acme\/api/ })).not.toBeInTheDocument();
    });
  },
};

export const BindsATypedWildcard: Story = {
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a typed wildcard is offered lowercased as a "use this scope" row', async () => {
      const body = await search('REPO::Zeta/*');
      const option = await body.findByRole('option', { name: /repo::zeta\/\*.*use this scope/ });
      await userEvent.click(option);
    });

    await step('Bind scope binds the normalised wildcard', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /bind scope/i }));
      await waitFor(() => expect(args.onBind).toHaveBeenCalledWith('repo::zeta/*'));
    });
  },
};

export const ShowsTheBindError: Story = {
  args: { onBind: fn(async () => 'This scope is already bound to another organization.') },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('a refused bind keeps the selection and shows why', async () => {
      const body = await search('lorekit');
      await userEvent.click(await body.findByRole('option', { name: /zeta\/lorekit/ }));
      await userEvent.click(canvas.getByRole('button', { name: /bind scope/i }));
      await expect(
        await canvas.findByText('This scope is already bound to another organization.'),
      ).toBeInTheDocument();
      await expect(canvas.getByText('repo::zeta/lorekit')).toBeInTheDocument();
    });
  },
};

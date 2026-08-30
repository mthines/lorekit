import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ScopingBadges, ScopingFields } from './TokenScoping';
import { UNSCOPED, type TokenScoping } from '@/lib/token-scoping';

/**
 * Interaction tests for the API-key scoping surfaces.
 *
 * These cover what a screenshot cannot: that picking a scope accumulates
 * instead of replacing, that switching tenancy DROPS the orgs already chosen
 * (the database rejects that pair, so carrying a hidden list would only defer
 * the rejection), that the org picker appears and disappears with the tenancy,
 * and that the collapsed summary tells the truth about what it is hiding.
 *
 * The wording arithmetic underneath — what a badge counts, which wildcards are
 * offered — is unit-tested in `lib/token-scoping.spec.ts`. What is asserted
 * here is that the components are actually wired to it.
 *
 * The picker's popup is PORTALED to `document.body`, so its rows resolve
 * against the document rather than the story canvas — the same pattern
 * `Combobox.test.stories.tsx` documents.
 */
const ORG_ACME = '11111111-1111-4111-8111-111111111111';
const ORG_GLOBEX = '22222222-2222-4222-8222-222222222222';

const ORGS = [
  { id: ORG_ACME, name: 'Acme' },
  { id: ORG_GLOBEX, name: 'Globex' },
];

const ORG_NAMES: Record<string, string> = {
  [ORG_ACME]: 'Acme',
  [ORG_GLOBEX]: 'Globex',
};

/** Two repos under `mthines`, so the `repo::mthines/*` wildcard is offered. */
const SCOPE_CATALOG = [
  'global',
  'repo::mthines/lorekit',
  'repo::mthines/gw-tools',
  'project::alpha',
];

/**
 * The harness holds the value and echoes it into an `<output>`.
 *
 * Echoing the COMMITTED state rather than asserting on a spy: `ScopingFields`
 * hands back a whole `TokenScoping` on every change, so what matters is the
 * object that came out, not how many times `onChange` fired.
 */
function Harness({
  initial = UNSCOPED,
  defaultOpen = true,
}: {
  initial?: TokenScoping;
  defaultOpen?: boolean;
}) {
  const [value, setValue] = useState<TokenScoping>(initial);
  return (
    <div style={{ width: 560, padding: '1rem' }}>
      <ScopingFields
        scoping={value}
        onChange={setValue}
        scopeCatalog={SCOPE_CATALOG}
        orgs={ORGS}
        defaultOpen={defaultOpen}
      />
      <output data-testid="scopes" style={{ display: 'block', marginTop: '0.75rem' }}>
        {value.scopes.join(',')}
      </output>
      <output data-testid="org-access" style={{ display: 'block' }}>
        {value.org_access}
      </output>
      <output data-testid="org-ids" style={{ display: 'block' }}>
        {value.org_ids.join(',')}
      </output>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Dashboard/TokenScoping/Tests',
  component: Harness,
  tags: ['test'],
  parameters: { chromatic: { disableSnapshot: true }, layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/** Open the scope picker and hand back a `within(document.body)` for its rows. */
async function openScopePicker(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: /^Scopes:/ }));
  const screen = within(document.body);
  await screen.findByRole('listbox', { name: /scopes/i });
  return screen;
}

export const PickingScopesAccumulates: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const menu = await openScopePicker(canvasElement);

    await step('the synthesised owner wildcard is offered', async () => {
      // Two repos under `mthines` in the catalog, so `scopePatternOptions`
      // derives it. A lone repo deliberately gets no wildcard, which is why
      // `project::alpha` has none here.
      await expect(menu.getByRole('option', { name: /repo::mthines\/\*/ })).toBeInTheDocument();
    });

    await step('the first pick lands and the list stays open', async () => {
      await userEvent.click(menu.getByRole('option', { name: /repo::mthines\/\*/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('scopes')).toHaveTextContent('repo::mthines/*');
      });
      await expect(menu.getByRole('listbox', { name: /scopes/i })).toBeInTheDocument();
    });

    await step('a second pick ADDS rather than replaces', async () => {
      await userEvent.click(menu.getByRole('option', { name: /^global$/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('scopes')).toHaveTextContent('repo::mthines/*,global');
      });
    });

    await step('clicking a chosen scope removes it again', async () => {
      await userEvent.click(menu.getByRole('option', { name: /repo::mthines\/\*/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('scopes')).toHaveTextContent('global');
      });
    });
  },
};

export const TheOrgPickerFollowsTheTenancy: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('no org picker under the default tenancy', async () => {
      // `all` and `personal` have nothing to pick, so offering an empty control
      // would be a question with no answers.
      await expect(canvas.queryByRole('button', { name: /^Organisations:/ })).toBeNull();
    });

    await step('choosing "Specific orgs" reveals it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /specific orgs/i }));
      await expect(canvas.getByTestId('org-access')).toHaveTextContent('selected');
      await expect(
        await canvas.findByRole('button', { name: /^Organisations:/ }),
      ).toBeInTheDocument();
    });

    await step('an org can be picked by NAME, not by uuid', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /^Organisations:/ }));
      const menu = within(document.body);
      await userEvent.click(await menu.findByRole('option', { name: /Acme/ }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('org-ids')).toHaveTextContent(ORG_ACME);
      });
      await userEvent.keyboard('{Escape}');
    });

    await step('switching away DROPS the orgs already picked', async () => {
      // The database rejects `personal` carrying org ids outright
      // (`api_tokens_org_ids_match_access`). Keeping a hidden list would only
      // defer that rejection to the save, so the control clears it here.
      await userEvent.click(canvas.getByRole('button', { name: /personal only/i }));
      await waitFor(async () => {
        await expect(canvas.getByTestId('org-access')).toHaveTextContent('personal');
      });
      await expect(canvas.getByTestId('org-ids')).toHaveTextContent('');
      await expect(canvas.queryByRole('button', { name: /^Organisations:/ })).toBeNull();
    });
  },
};

export const TheCollapsedSummarySaysWhatIsHidden: Story = {
  args: { defaultOpen: false },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('an unscoped picker reads as Unrestricted while collapsed', async () => {
      await expect(canvas.getByText('Unrestricted')).toBeInTheDocument();
      await expect(canvas.queryByRole('button', { name: /^Scopes:/ })).toBeNull();
    });

    await step('expanding reveals the controls', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /scoping/i }));
      await expect(await canvas.findByRole('button', { name: /^Scopes:/ })).toBeInTheDocument();
    });

    await step('a pick is reflected in the summary, so collapsing hides nothing', async () => {
      // The whole point of a collapsed disclosure with a summary: it must never
      // be ambiguous about what it is concealing.
      const menu = await openScopePicker(canvasElement);
      await userEvent.click(menu.getByRole('option', { name: /^global$/ }));
      await userEvent.keyboard('{Escape}');
      await waitFor(async () => {
        await expect(canvas.getByText(/Scopes: global\./)).toBeInTheDocument();
      });
    });
  },
};

export const BadgesCountAndStayQuietWhenUnscoped: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
      <div data-testid="unscoped">
        <ScopingBadges scoping={UNSCOPED} orgNames={ORG_NAMES} />
      </div>
      <div data-testid="scoped">
        <ScopingBadges
          scoping={{
            scopes: ['global', 'repo::mthines/*'],
            org_access: 'selected',
            org_ids: [ORG_ACME, ORG_GLOBEX],
          }}
          orgNames={ORG_NAMES}
        />
      </div>
    </div>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step('an unscoped key renders NO badge at all', async () => {
      // Deliberate: no badge already means unrestricted, and one on every key
      // would be noise. Asserted because it is invisible by construction.
      await expect(canvas.getByTestId('unscoped')).toBeEmptyDOMElement();
    });

    await step('a scoped key counts both axes', async () => {
      const scoped = within(canvas.getByTestId('scoped'));
      await expect(scoped.getByText('2 scopes')).toBeInTheDocument();
      await expect(scoped.getByText('2 orgs')).toBeInTheDocument();
    });

    await step('and names the orgs in the hover text, where there is room', async () => {
      // A uuid tells the reader nothing; the sentence is the one place the
      // exact patterns and the real org names fit.
      await expect(canvas.getByText('2 orgs')).toHaveAttribute(
        'title',
        'Scopes: global, repo::mthines/* · orgs: Acme, Globex.',
      );
    });
  },
};

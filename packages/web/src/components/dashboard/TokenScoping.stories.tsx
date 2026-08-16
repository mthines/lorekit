import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ScopingBadges, ScopingFields } from './TokenScoping';
import { UNSCOPED, type TokenScoping } from '@/lib/token-scoping';

/**
 * Visual-regression stories for the API-key scoping surfaces.
 *
 * Two components, one file, because they are two halves of one feature and a
 * reader comparing them wants them on one screen: the badge is what the row
 * says a key is narrowed to, and the picker is where that narrowing is chosen.
 *
 * Every variant is grouped into the single `Default` render tree rather than
 * split across stories: visual regression captures one snapshot per story, and
 * one snapshot showing five states side by side catches a drift in spacing or
 * border that five separate images hide.
 *
 * These fix the RESTING states. The picker's popup is portaled and
 * interaction-driven — screenshotting it open would pin a position that depends
 * on where the trigger happened to land — so the open list is covered in
 * `TokenScoping.test.stories.tsx` instead. That is the same split
 * `Combobox.stories.tsx` documents for the control underneath.
 */
const meta: Meta<typeof ScopingFields> = {
  title: 'Dashboard/TokenScoping',
  component: ScopingFields,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof ScopingFields>;

/** Static — a story that derives ids at render time diffs against itself. */
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

/**
 * Two repos under one owner, so `scopePatternOptions` synthesises the
 * `repo::mthines/*` wildcard — the case worth seeing in the picker, since a
 * lone repo deliberately gets no wildcard offered.
 */
const SCOPE_CATALOG = [
  'global',
  'repo::mthines/lorekit',
  'repo::mthines/gw-tools',
  'project::alpha',
];

function scoping(over: Partial<TokenScoping> = {}): TokenScoping {
  return { ...UNSCOPED, ...over };
}

/**
 * The picker is controlled; a story still needs somewhere to put the value.
 *
 * A real component — the same `Harness` shape `TokenScoping.test.stories.tsx`
 * uses — rather than a `useState` inside a `render` callback, because a render
 * callback is not a component and the hook call there is only legal behind an
 * `eslint-disable`. The catalog and org list are overridable so `Playground`'s
 * controls drive this same harness instead of needing a second one.
 */
function ControlledFields({
  initial,
  defaultOpen = false,
  scopeCatalog = SCOPE_CATALOG,
  orgs = ORGS,
}: {
  initial: TokenScoping;
  defaultOpen?: boolean;
  scopeCatalog?: string[];
  orgs?: { id: string; name: string }[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <ScopingFields
      scoping={value}
      onChange={setValue}
      scopeCatalog={scopeCatalog}
      orgs={orgs}
      defaultOpen={defaultOpen}
    />
  );
}

/**
 * Every state of the badge row, grouped into one snapshot.
 *
 * The unscoped case is included precisely because it renders NOTHING — that is
 * the deliberate decision (a badge every unscoped key carries is noise), and a
 * snapshot is the only thing that would catch it silently starting to render.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 640 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <BadgeRow label="Unscoped (renders nothing)" scoping={UNSCOPED} />
        <BadgeRow label="One scope" scoping={scoping({ scopes: ['global'] })} />
        <BadgeRow
          label="Several scopes"
          scoping={scoping({ scopes: ['global', 'repo::mthines/*', 'project::alpha'] })}
        />
        <BadgeRow label="Personal only" scoping={scoping({ org_access: 'personal' })} />
        <BadgeRow
          label="Both axes"
          scoping={scoping({
            scopes: ['repo::mthines/*'],
            org_access: 'selected',
            org_ids: [ORG_ACME, ORG_GLOBEX],
          })}
        />
      </div>

      {/* Collapsed — how the create form first shows it, in both its states. */}
      <ControlledFields initial={UNSCOPED} />
      <ControlledFields
        initial={scoping({
          scopes: ['repo::mthines/*'],
          org_access: 'selected',
          org_ids: [ORG_ACME],
        })}
      />

      {/* Expanded — how the row editor opens it, and the only state where the
          two triggers, the three tenancy cards and the conditional org picker
          are all on screen at once. */}
      <ControlledFields initial={UNSCOPED} defaultOpen />
      <ControlledFields
        initial={scoping({
          scopes: ['repo::mthines/*'],
          org_access: 'selected',
          org_ids: [ORG_ACME],
        })}
        defaultOpen
      />
    </div>
  ),
};

/**
 * Interactive controls for the picker.
 *
 * `scoping` and `onChange` are deliberately absent from `argTypes`: the value
 * is held by the wrapper below so the control stays usable in the Playground,
 * and a control for a callback would only ever be noise.
 */
export const Playground: Story = {
  args: {
    scopeCatalog: SCOPE_CATALOG,
    orgs: ORGS,
    defaultOpen: true,
  },
  argTypes: {
    defaultOpen: {
      control: 'boolean',
      description: 'Start expanded. The row editor does; the create form does not.',
    },
    scopeCatalog: {
      control: 'object',
      description:
        "The account's scope strings. Owner wildcards are synthesised from these, so an owner needs two entries before one is offered.",
    },
    orgs: {
      control: 'object',
      description: 'The orgs the signed-in user belongs to.',
    },
  },
  render: (args) => <ControlledFields {...args} initial={UNSCOPED} />,
};

/** One labelled badge row, so the grouped snapshot says which case is which. */
function BadgeRow({ label, scoping: value }: { label: string; scoping: TokenScoping }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
      <span style={{ fontSize: 12, opacity: 0.6, minWidth: 200 }}>{label}</span>
      <ScopingBadges scoping={value} orgNames={ORG_NAMES} />
    </div>
  );
}

import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';

import {
  OrgListSkeleton,
  OrgMembersSkeleton,
  OrgInvitesSkeleton,
  OrgScopesSkeleton,
} from './OrganizationSkeleton';

/**
 * The Organization settings placeholders — the route-level Suspense fallback
 * and the three async sections inside `OrganizationManager`.
 *
 * ## Why structural assertions and not pixel baselines
 * Every block carries Tailwind's `animate-pulse`, a CSS keyframe animation the
 * preview's `MotionConfig reducedMotion="always"` does not collapse (that
 * governs `motion/react` only). A `toMatchScreenshot` baseline would then be
 * pinned to whatever opacity the pulse happened to be at when the screenshot
 * fired — so these stories opt out of visual-regression snapshotting and pin
 * the shape with play assertions instead, the same convention as the sibling
 * `LessonCardSkeleton`.
 */
const meta: Meta = {
  title: 'Dashboard/OrganizationSkeleton',
  parameters: { layout: 'padded', chromatic: { disableSnapshot: true } },
};

export default meta;
type Story = StoryObj;

/** The master list, as it renders in the page's Suspense fallback. */
export const OrgList: Story = {
  render: () => <OrgListSkeleton />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('announces the load and stands in for two org rows', async () => {
      const status = canvas.getByRole('status', { name: 'Loading organizations' });
      await expect(status.children).toHaveLength(2);
    });
  },
};

/**
 * Members as an owner/admin sees them — rows sized for the `min-h-11` role
 * `<select>` and the remove button, so the placeholder resolves to the height
 * the real rows will have.
 */
export const Members: Story = {
  render: () => <OrgMembersSkeleton manageable />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('three member rows, each ending in a select + remove placeholder', async () => {
      const status = canvas.getByRole('status', { name: 'Loading members' });
      await expect(status.children).toHaveLength(3);
      const trailing = status.querySelector('[aria-hidden="true"] > div:last-child');
      await expect(trailing?.children).toHaveLength(2);
    });
  },
};

/** Members as a member/viewer sees them — a role badge, no row controls. */
export const MembersReadOnly: Story = {
  render: () => <OrgMembersSkeleton manageable={false} />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('a row without management controls ends in the lone role badge', async () => {
      const status = canvas.getByRole('status', { name: 'Loading members' });
      const trailing = status.querySelector('[aria-hidden="true"] > div:last-child');
      await expect(trailing?.children).toHaveLength(1);
    });
  },
};

/** A single pending-invite row — most orgs have none, so one is the honest count. */
export const Invites: Story = {
  render: () => <OrgInvitesSkeleton />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('one invite row, not a stack', async () => {
      const status = canvas.getByRole('status', { name: 'Loading invites' });
      await expect(status.children).toHaveLength(1);
    });
  },
};

/** The bound-scope rows. */
export const Scopes: Story = {
  render: () => <OrgScopesSkeleton />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('two scope rows', async () => {
      const status = canvas.getByRole('status', { name: 'Loading shared scopes' });
      await expect(status.children).toHaveLength(2);
    });
  },
};

/** All three sections stacked, the way the detail view renders them together. */
export const DetailView: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <OrgMembersSkeleton manageable />
      <OrgInvitesSkeleton />
      <OrgScopesSkeleton />
    </div>
  ),
};

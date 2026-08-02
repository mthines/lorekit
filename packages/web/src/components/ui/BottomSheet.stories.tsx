import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Check, Search, Tag } from 'lucide-react';

import { BottomSheet } from './BottomSheet';

/**
 * Visual-regression stories for {@link BottomSheet}.
 *
 * The sheet portals and is `fixed` to the viewport in the app, which a
 * story-root screenshot can't capture. Each story therefore renders it inside a
 * phone-sized **device frame** and passes that frame as `container`, so the
 * sheet is `absolute` within the frame and the snapshot of the story root
 * includes it. `preview.tsx` pins reduced motion, so the sheet renders in its
 * settled open state (no mid-slide frame) — deterministic pixels.
 */
const meta: Meta<typeof BottomSheet> = {
  title: 'UI/BottomSheet',
  component: BottomSheet,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof BottomSheet>;

/** These stories render the sheet permanently open; nothing to close. */
const noop = () => undefined;

/** A phone-sized frame with faux page content, so the blurred backdrop reads. */
function DeviceFrame({
  children,
}: {
  children: (frame: HTMLElement) => React.ReactNode;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setFrame}
      className="relative h-[520px] w-[300px] overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg)]"
    >
      {/* Faux page behind the sheet — gives the backdrop blur something to blur. */}
      <div className="space-y-2 p-4">
        <div className="h-6 w-2/3 rounded-md bg-[var(--color-bg-elevated)]" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        ))}
      </div>
      {frame && children(frame)}
    </div>
  );
}

const SAMPLE_LABELS = [
  { tag: 'performance', count: 24 },
  { tag: 'auth', count: 18 },
  { tag: 'database', count: 12 },
  { tag: 'ui', count: 9 },
  { tag: 'testing', count: 7 },
  { tag: 'infra', count: 5 },
];

/** A label-picker body, mirroring how `FilterMenu` fills the sheet. */
function LabelBody({ selected = ['auth'] }: { selected?: string[] }) {
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Search className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <input
          readOnly
          placeholder="Search labels…"
          className="flex-1 bg-transparent text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] !outline-none"
        />
      </div>
      <div className="p-1">
        {SAMPLE_LABELS.map((l) => {
          const isSelected = selected.includes(l.tag);
          return (
            <div
              key={l.tag}
              className={[
                'flex min-h-8 items-center gap-2 rounded-md px-2 text-xs',
                isSelected ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-secondary)]',
              ].join(' ')}
            >
              <span
                className={[
                  'flex size-3.5 shrink-0 items-center justify-center rounded border',
                  isSelected
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]'
                    : 'border-[var(--color-border)]',
                ].join(' ')}
              >
                {isSelected && <Check className="size-2.5" />}
              </span>
              <span className="flex-1 truncate">{l.tag}</span>
              <span className="tabular-nums text-[var(--color-content-tertiary)]">{l.count}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * The two shapes this surface takes: a scrollable label picker (its first use)
 * and a compact action sheet. Both open, so the snapshot fixes the handle, the
 * rounded top, and the blurred backdrop in one frame.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <DeviceFrame>
        {(frame) => (
          <BottomSheet open onClose={noop} title="Filter by label" container={frame}>
            <LabelBody />
          </BottomSheet>
        )}
      </DeviceFrame>
      <DeviceFrame>
        {(frame) => (
          <BottomSheet open onClose={noop} title="Memory actions" container={frame}>
            <div className="flex flex-col p-2">
              {['Archive', 'Duplicate', 'Copy link'].map((label) => (
                <div
                  key={label}
                  className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-[var(--color-content-secondary)]"
                >
                  <Tag className="size-4" aria-hidden />
                  {label}
                </div>
              ))}
            </div>
          </BottomSheet>
        )}
      </DeviceFrame>
    </div>
  ),
};

export const Playground: Story = {
  render: (args) => (
    <DeviceFrame>
      {(frame) => (
        <BottomSheet {...args} container={frame} onClose={noop}>
          <LabelBody />
        </BottomSheet>
      )}
    </DeviceFrame>
  ),
  args: {
    open: true,
    title: 'Filter by label',
  },
  argTypes: {
    open: { control: 'boolean' },
    title: { control: 'text' },
  },
};

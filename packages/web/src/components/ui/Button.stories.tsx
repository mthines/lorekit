import type { Meta, StoryObj } from '@storybook/react';
import { ArrowRight, Copy, Plus, Trash2 } from 'lucide-react';

import { Button, IconButton } from './Button';
import type { ButtonSize, ButtonVariant } from '@/lib/button-styles';

const meta: Meta<typeof Button> = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
  args: { children: 'Button' },
};

export default meta;
type Story = StoryObj<typeof Button>;

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'danger',
  'danger-outline',
];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];

/**
 * Visual-regression story: the whole matrix in one snapshot. Every variant at
 * every size, plus the icon-button row and the notable states (loading,
 * disabled, icons, link, full-width). A token or sizing regression anywhere
 * fails this single screenshot. The icon-button tooltips are portaled and stay
 * `opacity-0` at rest, so they do not appear here — their behaviour is covered
 * by Button.test.stories.tsx.
 */
export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '30rem' }}>
      {VARIANTS.map((variant) => (
        <div key={variant} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {SIZES.map((size) => (
            <Button key={size} variant={variant} size={size}>
              {variant}
            </Button>
          ))}
        </div>
      ))}

      {/* Icon-only buttons — one per variant. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {VARIANTS.map((variant) => (
          <IconButton key={variant} variant={variant} icon={<Plus className="size-4" />} label={`Add (${variant})`} />
        ))}
      </div>

      {/* States. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
        <Button variant="primary" isLoading>
          Saving
        </Button>
        <Button variant="secondary" disabled>
          Disabled
        </Button>
        <Button variant="secondary" leftIcon={<Copy className="size-4" />}>
          Copy
        </Button>
        <Button variant="primary" rightIcon={<ArrowRight className="size-4" />}>
          Continue
        </Button>
        <Button variant="danger" leftIcon={<Trash2 className="size-4" />}>
          Delete
        </Button>
        <Button variant="outline" href="/lore">
          Link
        </Button>
      </div>

      <Button variant="primary" size="lg" fullWidth>
        Full-width CTA
      </Button>
    </div>
  ),
};

/**
 * Interactive knobs. Keeps the `StoryObj<typeof Button>` type so a prop rename
 * on `Button` breaks this file at compile time — never redeclare a parallel
 * args type.
 */
export const Playground: Story = {
  args: { children: 'Generate token', variant: 'primary', size: 'md' },
  argTypes: {
    variant: { control: 'select', options: VARIANTS, description: 'Visual style.' },
    size: { control: 'select', options: SIZES, description: 'sm / md / lg (lg is the 44px CTA).' },
    isLoading: { control: 'boolean', description: 'Spinner + aria-busy + disabled.' },
    fullWidth: { control: 'boolean' },
    disabled: { control: 'boolean' },
    children: { control: 'text', description: 'Button label.' },
    className: { control: 'text' },
  },
};

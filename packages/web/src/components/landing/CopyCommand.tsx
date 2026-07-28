'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * A single-line, copyable terminal command shown on the public landing page's
 * "Get started" card. Mirrors the copy affordance of the dashboard's
 * `CopyableCode` (ClientConfigTabs) but sized for one inline command.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] pl-3 pr-1.5 py-1.5">
      <code className="min-w-0 truncate font-mono text-xs text-[var(--color-accent)]">
        {command}
      </code>
      <button
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy command to clipboard'}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        {copied
          ? <><Check className="size-3" aria-hidden /> Copied</>
          : <><Copy className="size-3" aria-hidden /> Copy</>}
      </button>
    </div>
  );
}

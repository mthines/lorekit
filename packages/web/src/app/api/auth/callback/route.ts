import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { withSpan, logger, SpanKind, SpanStatusCode } from '@/lib/telemetry';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  return withSpan(
    'lorekit.auth.callback',
    {
      'auth.callback.has_code': !!code,
      'auth.callback.next': next,
    },
    async (span) => {
      if (code) {
        const supabase = await createServerClient();
        const { error, data } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
          span.setAttribute('auth.callback.outcome', 'success');
          span.setAttribute('auth.user_id', data.user?.id ?? 'unknown');
          // auth.provider is safe to surface — it is a bounded value (github, email, …)
          span.setAttribute('auth.provider', data.user?.app_metadata?.['provider'] ?? 'unknown');
          // Leave span status UNSET on success — consistent with withSpan convention
          // (see lib/telemetry.ts: status is set to ERROR only on thrown exceptions).
          logger.info('auth.callback.success', {
            'auth.provider': data.user?.app_metadata?.['provider'] ?? 'unknown',
          });
          return NextResponse.redirect(`${origin}${next}`);
        }

        span.setAttribute('auth.callback.outcome', 'exchange_failed');
        span.setAttribute('auth.error_code', error.code ?? error.name);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        logger.warn('auth.callback.exchange_failed', {
          'auth.error_code': error.code ?? error.name,
          'error.message': error.message,
        });
      } else {
        span.setAttribute('auth.callback.outcome', 'no_code');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'no auth code in callback' });
        logger.warn('auth.callback.no_code', {});
      }

      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    },
    SpanKind.SERVER,
  );
}

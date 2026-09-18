import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { invalidatePhases } from '@/lib/server/phases';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/** Deletes a phase, its room links, checklist, form, and every team's answers. */
export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'phase id');

  const { data, error } = await getServiceClient().from('phases').delete().eq('id', id).select('title').maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Phase not found.');

  invalidatePhases();
  await audit(account.account_id, 'PHASE_DELETED', data.title, null);
  return json({ ok: true });
});

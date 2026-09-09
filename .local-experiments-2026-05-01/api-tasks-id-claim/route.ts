import { NextRequest, NextResponse } from 'next/server';
import { getDatabase, Task, db_helpers } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined;
  return `${prefix}-${String(num).padStart(3, '0')}`;
}

function mapTaskRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  };
}

/**
 * POST /api/tasks/[id]/claim
 *
 * Atomisk claim av en inbox-ticket.
 * Bruker SQLite-transaksjon med conditional UPDATE for å forhindre race conditions
 * mellom parallelle heartbeats/agenter som prøver å ta samme ticket.
 *
 * Body (valgfritt):
 *   { "agent": "Reidar" }   — hvem som claimer (loggformål)
 *
 * Returns:
 *   200 + task  — claim lyktes, ticket er nå in_progress
 *   409         — ticket var allerede claimed av noen andre
 *   404         — ticket finnes ikke
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const db = getDatabase();
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }

    let claimedBy = auth.user.username;
    try {
      const body = await request.json().catch(() => ({}));
      if (body?.agent && typeof body.agent === 'string') {
        claimedBy = body.agent;
      }
    } catch {
      // body is optional — ignore parse errors
    }

    const now = Math.floor(Date.now() / 1000);

    // Atomisk claim: UPDATE begrenses til status IN ('inbox','assigned')
    // Hvis en annen prosess allerede har satt status=in_progress vil changes === 0
    const claimTx = db.transaction(() => {
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'in_progress', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status IN ('inbox', 'assigned')
      `).run(now, taskId, workspaceId);

      return result.changes;
    });

    const changedRows = claimTx();

    if (changedRows === 0) {
      // Sjekk om ticket finnes overhodet
      const existing = db.prepare(
        'SELECT id, status FROM tasks WHERE id = ? AND workspace_id = ?'
      ).get(taskId, workspaceId) as { id: number; status: string } | undefined;

      if (!existing) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      // Ticket finnes men er allerede tatt
      return NextResponse.json(
        { error: 'Task already claimed', current_status: existing.status },
        { status: 409 }
      );
    }

    // Hent oppdatert task
    const updatedTask = db.prepare(`
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `).get(taskId, workspaceId) as Task;

    const parsedTask = mapTaskRow(updatedTask);

    // Logg aktivitet
    db_helpers.logActivity(
      'task_updated',
      'task',
      taskId,
      claimedBy,
      `Task claimed by ${claimedBy}: status inbox → in_progress`,
      { claimedBy, oldStatus: 'inbox', newStatus: 'in_progress' },
      workspaceId
    );

    // Broadcast til SSE-klienter (bruker task.updated — task.claimed er ikke en registrert EventType)
    eventBus.broadcast('task.updated', { ...parsedTask, claimed_by: claimedBy });

    return NextResponse.json({ task: parsedTask, claimed_by: claimedBy });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/claim error');
    return NextResponse.json({ error: 'Failed to claim task' }, { status: 500 });
  }
}

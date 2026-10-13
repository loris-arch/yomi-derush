/**
 * Log de job au format imposé par CLAUDE.md : job, entity_id, duration_ms, status.
 * Une ligne en début, une ligne en fin, quoi qu'il arrive.
 */

export type JobStatus = 'started' | 'ok' | 'skipped' | 'failed';

export type JobLog = {
  readonly done: (status: Exclude<JobStatus, 'started'>, extra?: Record<string, unknown>) => void;
  readonly entity: (id: string) => void;
};

function emit(
  job: string,
  entityId: string | null,
  status: JobStatus,
  durationMs: number | null,
  extra: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = { job, entity_id: entityId, status, ...extra };
  if (durationMs !== null) line['duration_ms'] = durationMs;
  console.log(JSON.stringify(line));
}

/**
 * Une ligne seule, sans la paire début/fin.
 *
 * Pour ce qui n'est pas un job : la mise en file d'une étape, une relève qui a trouvé quelque
 * chose. Encadrer ces événements-là de deux lignes doublerait le volume sans rien apprendre —
 * il n'y a pas de durée à mesurer entre un début et une fin qui sont le même instant.
 */
export function logEvent(
  job: string,
  entityId: string | null,
  status: Exclude<JobStatus, 'started'>,
  extra: Record<string, unknown> = {},
  durationMs: number | null = null,
): void {
  emit(job, entityId, status, durationMs, extra);
}

export function startJob(job: string, entityId: string | null = null): JobLog {
  const startedAt = Date.now();
  let currentEntity = entityId;

  emit(job, currentEntity, 'started', null, {});

  return {
    entity(id: string) {
      currentEntity = id;
    },
    done(status, extra = {}) {
      emit(job, currentEntity, status, Date.now() - startedAt, extra);
    },
  };
}

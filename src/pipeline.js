// @ts-check

/** Fréquence de relecture d'un pipeline qui tourne. */
const PIPELINE_POLL_MS = 30_000;

/** Icône codicon par statut de pipeline ou de job. @type {Record<string, string>} */
const PIPELINE_ICONS = {
  success: 'pass',
  failed: 'error',
  running: 'sync~spin',
  pending: 'clock',
  created: 'clock',
  preparing: 'clock',
  waiting_for_resource: 'clock',
  scheduled: 'clock',
  manual: 'play-circle',
  canceled: 'circle-slash',
  skipped: 'debug-step-over',
};

/** Statuts d'un pipeline qui peut encore changer : ils justifient de le relire. */
const RUNNING_PIPELINE_STATUSES = [
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'scheduled',
];

/**
 * Statut d'un stage : le premier de cette liste porté par l'un de ses jobs. Un job `manual` n'empêche
 * pas un stage d'être réussi, comme dans GitLab.
 */
const STAGE_STATUS_PRIORITY = [
  'failed',
  'running',
  'pending',
  'preparing',
  'waiting_for_resource',
  'created',
  'scheduled',
  'canceled',
  'success',
  'manual',
  'skipped',
];

/**
 * @typedef {{ id: number, name: string, stage: string, status: string, allow_failure: boolean,
 *   duration?: number | null, web_url?: string, failure_reason?: string,
 *   downstream_pipeline?: { id: number, project_id: number, status: string, web_url: string } | null
 * }} Job
 * @typedef {{ name: string, status: string, jobs: Job[] }} Stage
 */

/** Un job en échec autorisé (`allow_failure`) ne fait pas échouer son stage. @param {Job} job */
function isAllowedFailure(job) {
  return job.status === 'failed' && job.allow_failure;
}

/**
 * Jobs groupés par stage, dans l'ordre du pipeline. L'API ne donne pas l'ordre des stages, mais GitLab
 * crée les jobs stage par stage : le plus petit identifiant d'un stage le situe.
 * @param {Job[]} jobs
 * @returns {Stage[]}
 */
function groupJobsByStage(jobs) {
  /** @type {Map<string, Job[]>} */
  const jobsByStage = new Map();
  for (const job of [...jobs].sort((a, b) => a.id - b.id)) {
    jobsByStage.set(job.stage, [...(jobsByStage.get(job.stage) ?? []), job]);
  }
  return [...jobsByStage].map(([name, stageJobs]) => {
    const statuses = stageJobs.map((job) => (isAllowedFailure(job) ? 'success' : job.status));
    return {
      name,
      status:
        STAGE_STATUS_PRIORITY.find((status) => statuses.includes(status)) ?? stageJobs[0].status,
      jobs: stageJobs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    };
  });
}

/** @param {number} seconds */
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes} min ${String(total % 60).padStart(2, '0')} s` : `${total} s`;
}

module.exports = {
  PIPELINE_ICONS,
  PIPELINE_POLL_MS,
  RUNNING_PIPELINE_STATUSES,
  formatDuration,
  groupJobsByStage,
  isAllowedFailure,
};

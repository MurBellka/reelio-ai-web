// Запуск FFmpeg worker'а.
//
// cloud → Cloud Run Job execution (run.googleapis.com/v2, ADC/Workload Identity);
// local → дочерний процесс из LOCAL_WORKER_CMD (для e2e без платных ресурсов).
//
// Набор переменных окружения одинаков в обоих режимах — см. контракт §9.

import { spawn } from 'node:child_process';

function envOverrides({ job, planUri, bucket, progressUrl, workerToken }) {
  return [
    { name: 'REELIO_JOB_ID', value: job.jobId },
    { name: 'REELIO_PROJECT_ID', value: job.projectId },
    { name: 'REELIO_BUCKET', value: bucket },
    { name: 'REELIO_PLAN_URI', value: planUri },
    { name: 'REELIO_OUTPUT_PREFIX', value: job.outputPrefix },
    // Схему путей знает только backend — в ней зашит проверенный uid владельца.
    { name: 'REELIO_PROJECT_PREFIX', value: job.projectPrefix || '' },
    { name: 'REELIO_JOB_PREFIX', value: job.jobPrefix || '' },
    { name: 'REELIO_PROGRESS_URL', value: progressUrl },
    { name: 'REELIO_WORKER_TOKEN', value: workerToken },
    { name: 'REELIO_CONTRACT_VERSION', value: '1' },
  ];
}

class CloudRunJobRunner {
  constructor(config, auth) {
    this.config = config;
    this.auth = auth;
    const { gcpProject, jobRegion, jobName } = config.render;
    this.jobResource = `projects/${gcpProject}/locations/${jobRegion}/jobs/${jobName}`;
    this.api = `https://${jobRegion}-run.googleapis.com/v2`;
  }

  get mode() {
    return 'cloud';
  }

  async #request(path, init) {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    const res = await fetch(`${this.api}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.token ?? token}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      // Тело ответа GCP не пробрасываем клиенту — может содержать детали проекта.
      const err = new Error(`cloud run api ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Запускает execution, возвращает её имя для последующей отмены. */
  async start(context) {
    const body = {
      overrides: {
        containerOverrides: [{ env: envOverrides(context) }],
        taskCount: 1,
        timeout: `${this.config.render.heartbeatTimeoutMs / 1000}s`,
      },
    };
    const op = await this.#request(`${this.jobResource}:run`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    // Долгая операция: имя execution лежит в metadata либо в response.
    return op?.metadata?.name || op?.response?.name || op?.name || null;
  }

  async cancel(executionName) {
    if (!executionName) return false;
    try {
      await this.#request(`${executionName}:cancel`, { method: 'POST', body: '{}' });
      return true;
    } catch {
      return false;
    }
  }
}

/** Локальный исполнитель: LOCAL_WORKER_CMD в дочернем процессе. */
class LocalRunner {
  constructor(config) {
    this.config = config;
    this.processes = new Map();
  }

  get mode() {
    return 'local';
  }

  async start(context) {
    const cmd = this.config.render.localWorkerCmd;
    if (!cmd) return null; // Worker ещё не готов — задача останется queued.

    const env = { ...process.env };
    for (const { name, value } of envOverrides(context)) env[name] = value;

    const child = spawn(cmd, {
      shell: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    const executionName = `local/${context.job.jobId}`;
    this.processes.set(executionName, child);

    const tag = `[worker ${context.job.jobId}]`;
    child.stdout.on('data', (b) => process.stdout.write(`${tag} ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`${tag} ${b}`));
    child.on('exit', () => this.processes.delete(executionName));
    child.on('error', (e) => console.error(`${tag} spawn failed: ${e.code || 'ERR'}`));

    return executionName;
  }

  async cancel(executionName) {
    const child = this.processes.get(executionName);
    if (!child) return false;
    child.kill('SIGTERM');
    // Жёстко добиваем, если worker не завершился за 10 с.
    setTimeout(() => {
      if (this.processes.has(executionName)) child.kill('SIGKILL');
    }, 10_000).unref();
    return true;
  }
}

export async function createRunner(config) {
  if (config.render.mode !== 'cloud') return new LocalRunner(config);
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return new CloudRunJobRunner(config, auth);
}

export { LocalRunner, CloudRunJobRunner, envOverrides };

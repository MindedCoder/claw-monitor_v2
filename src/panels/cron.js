import { fetchWithTimeout } from '../lib/fetch-utils.js';
import { sendJson } from '../lib/http-helpers.js';
import { esc, relative, toBJ } from '../lib/html.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled', 'active'].includes(lower)) return true;
    if (['false', '0', 'no', 'off', 'disabled', 'inactive'].includes(lower)) return false;
  }
  return null;
}

function normalizeTs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && String(numeric) === value.trim()) {
      return normalizeTs(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function formatSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.tz ? `${schedule.expr} (${schedule.tz})` : schedule.expr;
  }
  if (schedule.kind === 'every' && Number.isFinite(schedule.everyMs)) {
    const ms = Number(schedule.everyMs);
    if (ms < 60_000) return `每 ${Math.round(ms / 1000)} 秒`;
    if (ms < 3_600_000) return `每 ${Math.round(ms / 60_000)} 分钟`;
    if (ms < 86_400_000) return `每 ${Math.round(ms / 3_600_000)} 小时`;
    return `每 ${Math.round(ms / 86_400_000)} 天`;
  }
  if (schedule.kind === 'at' && schedule.at) return String(schedule.at);
  return null;
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractTasks(data) {
  const candidates = [
    data?.tasks,
    data?.taskList,
    data?.items,
    data?.jobs,
    data?.data?.tasks,
    data?.data?.taskList,
    data?.data?.items,
    data?.data?.jobs,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeTask(task, index) {
  const name = pickFirst(task?.name, task?.taskName, task?.title, task?.id, task?.key, `task-${index + 1}`);
  const enabled = normalizeBool(pickFirst(
    task?.enabled,
    task?.isEnabled,
    task?.active,
    typeof task?.status === 'string' ? task.status : null,
    typeof task?.state === 'string' ? task.state : null
  ));
  const nextWakeup = normalizeTs(pickFirst(
    task?.nextWakeup,
    task?.nextWakeAt,
    task?.nextRun,
    task?.nextRunAt,
    task?.nextExecutionAt,
    task?.nextExecuteAt,
    task?.wakeupAt,
    task?.state?.nextRunAtMs
  ));
  const cronExpr = pickFirst(
    task?.cron,
    task?.cronExpr,
    task?.cronExpression,
    task?.spec,
    formatSchedule(task?.schedule),
    typeof task?.schedule === 'string' ? task.schedule : null
  );
  const status = pickFirst(
    task?.status,
    task?.phase,
    task?.state?.lastRunStatus,
    task?.state?.lastStatus,
    task?.state?.runningAtMs ? 'running' : null
  );

  return {
    id: task?.id ? String(task.id) : null,
    name: String(name),
    enabled,
    nextWakeup,
    cron: cronExpr ? String(cronExpr) : null,
    status: status ? String(status) : null,
    description: task?.description ? String(task.description) : null,
    lastRunAt: normalizeTs(pickFirst(task?.lastRunAt, task?.state?.lastRunAtMs)),
    lastError: pickFirst(task?.lastError, task?.state?.lastError),
  };
}

function normalizeCronPayload(data) {
  const body = data?.data && typeof data.data === 'object' ? data.data : data;
  const tasks = extractTasks(data).map(normalizeTask);
  const taskCount = Number(pickFirst(
    body?.taskCount,
    body?.count,
    body?.total,
    body?.taskTotal,
    tasks.length
  ) || 0);
  const enabled = normalizeBool(pickFirst(
    body?.enabled,
    body?.isEnabled,
    body?.active,
    body?.running,
    taskCount > 0 ? true : null
  ));
  const nextWakeup = normalizeTs(pickFirst(
    body?.nextWakeup,
    body?.nextWakeAt,
    body?.nextRun,
    body?.nextRunAt,
    body?.nextExecutionAt,
    body?.wakeupAt
  )) || tasks.map((task) => task.nextWakeup).filter(Boolean).sort((a, b) => a - b)[0] || null;

  return {
    enabled,
    taskCount,
    nextWakeup,
    tasks,
    raw: data,
    source: 'api',
  };
}

function loadLocalCronPayload() {
  const jobsPath = resolve(homedir(), '.openclaw/cron/jobs.json');
  const store = readJsonIfExists(jobsPath);
  if (!store || !Array.isArray(store.jobs)) {
    throw new Error('local cron jobs.json not found');
  }
  const tasks = store.jobs.map(normalizeTask);
  const enabled = tasks.some((task) => task.enabled !== false);
  const nextWakeup = tasks.map((task) => task.nextWakeup).filter(Boolean).sort((a, b) => a - b)[0] || null;
  return {
    enabled,
    taskCount: tasks.length,
    nextWakeup,
    tasks,
    raw: store,
    source: 'local',
  };
}

function runOpenclawCronJson(args) {
  const result = spawnSync('openclaw', ['cron', ...args, '--json'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `openclaw cron ${args.join(' ')} failed`).trim());
  }
  const text = (result.stdout || '').trim();
  if (!text) {
    throw new Error(`openclaw cron ${args.join(' ')} returned empty output`);
  }
  return JSON.parse(text);
}

function loadCliCronPayload() {
  const status = runOpenclawCronJson(['status']);
  const list = runOpenclawCronJson(['list', '--all']);
  const merged = {
    ...list,
    ...status,
    jobs: Array.isArray(list?.jobs)
      ? list.jobs
      : Array.isArray(list?.tasks)
        ? list.tasks
        : [],
    taskCount: pickFirst(
      status?.taskCount,
      status?.count,
      list?.taskCount,
      list?.count,
      Array.isArray(list?.jobs) ? list.jobs.length : null,
      Array.isArray(list?.tasks) ? list.tasks.length : null,
    ),
    nextWakeup: pickFirst(
      status?.nextWakeup,
      status?.nextWakeAt,
      status?.nextWakeAtMs,
      status?.nextRun,
      status?.nextRunAt,
      list?.nextWakeup,
      list?.nextWakeAt,
      list?.nextWakeAtMs,
      list?.nextRun,
      list?.nextRunAt,
    ),
  };
  const normalized = normalizeCronPayload(merged);
  return {
    ...normalized,
    raw: { status, list },
    source: 'cli',
  };
}

async function loadRemoteCronPayload(url, timeoutMs) {
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const trimmed = text.trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (trimmed.startsWith('<')) {
      throw new Error('cron 接口返回了 HTML 页面，请检查 cron.url 是否指向了登录页/错误页，或上游服务是否未启动');
    }
    throw error;
  }
}

export default function createCronPanel(config) {
  const cfg = config.cron || {};
  const panelEnabled = cfg.enabled !== false;
  const url = cfg.url || '';
  const intervalMs = cfg.intervalMs || 5000;
  const timeoutMs = cfg.timeoutMs || 5000;

  const state = {
    enabled: null,
    taskCount: 0,
    nextWakeup: null,
    tasks: [],
    raw: null,
    source: null,
    error: null,
    lastCheck: null,
  };

  let timer = null;

  async function refresh() {
    try {
      let normalized = null;
      if (url) {
        const data = await loadRemoteCronPayload(url, timeoutMs);
        normalized = normalizeCronPayload(data);
      } else {
        normalized = loadCliCronPayload();
      }
      state.enabled = normalized.enabled;
      state.taskCount = normalized.taskCount;
      state.nextWakeup = normalized.nextWakeup;
      state.tasks = normalized.tasks;
      state.raw = normalized.raw;
      state.source = normalized.source;
      state.error = null;
    } catch (err) {
      try {
        const cli = loadCliCronPayload();
        state.enabled = cli.enabled;
        state.taskCount = cli.taskCount;
        state.nextWakeup = cli.nextWakeup;
        state.tasks = cli.tasks;
        state.raw = cli.raw;
        state.source = cli.source;
        state.error = null;
      } catch {
        try {
          const local = loadLocalCronPayload();
          state.enabled = local.enabled;
          state.taskCount = local.taskCount;
          state.nextWakeup = local.nextWakeup;
          state.tasks = local.tasks;
          state.raw = local.raw;
          state.source = local.source;
          state.error = null;
        } catch {
          state.error = err.message;
        }
      }
    }
    state.lastCheck = Date.now();
    return getStatus();
  }

  function startPolling() {
    if (!panelEnabled) return;
    refresh();
    timer = setInterval(refresh, intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      taskCount: state.taskCount,
      nextWakeup: state.nextWakeup,
      tasks: state.tasks,
      raw: state.raw,
      source: state.source,
      error: state.error,
      lastCheck: state.lastCheck,
    };
  }

  function routes() {
    return {
      'GET /api/cron': (req, res) => sendJson(res, getStatus()),
      'GET /api/cron/refresh': async (req, res) => {
        await refresh();
        sendJson(res, getStatus());
      },
    };
  }

  function renderTaskRow(task) {
    const enabledText = task.enabled == null ? '-' : task.enabled ? '启用' : '停用';
    const nextWakeup = task.nextWakeup ? `${toBJ(task.nextWakeup)} (${relative(task.nextWakeup)})` : '-';
    const meta = [task.status, task.cron, task.lastError].filter(Boolean).map(esc).join(' · ');
    const title = task.description ? ` title="${esc(task.description)}"` : '';
    return `
      <tr>
        <td data-label="任务"${title}>${esc(task.name)}</td>
        <td data-label="启用">${enabledText}</td>
        <td data-label="下次唤醒">${nextWakeup}</td>
        <td data-label="状态 / 表达式">${meta || '-'}</td>
      </tr>`;
  }

  function render() {
    const badge = state.error
      ? { cls: 'fail' }
      : state.enabled == null
        ? { cls: 'unknown' }
        : state.enabled
          ? { cls: 'ok' }
          : { cls: 'warn' };

    const cards = `
      <div class="panel-cards">
        <div class="panel-card ${badge.cls}">
          <div class="card-title">是否启用</div>
          <div class="card-value">${state.enabled == null ? '-' : state.enabled ? '是' : '否'}</div>
        </div>
        <div class="panel-card ${state.taskCount > 0 ? 'ok' : 'unknown'}">
          <div class="card-title">任务数</div>
          <div class="card-value">${state.taskCount}</div>
        </div>
        <div class="panel-card ${state.nextWakeup ? 'ok' : 'unknown'}">
          <div class="card-title">下次唤醒</div>
          <div class="card-value cron-next">${state.nextWakeup ? esc(relative(state.nextWakeup)) : '-'}</div>
          <div class="card-time">${state.nextWakeup ? esc(toBJ(state.nextWakeup)) : '-'}</div>
        </div>
      </div>`;

    const errorHtml = state.error ? `<div class="claw-error">拉取失败: ${esc(state.error)}</div>` : '';
    const rows = state.tasks.slice(0, 20).map(renderTaskRow).join('');
    const sourceText =
      state.source === 'local'
        ? '来源: 本地 jobs.json'
        : state.source === 'api'
          ? '来源: /cron 接口'
          : state.source === 'cli'
            ? '来源: openclaw cron status/list'
            : '';
    const taskTable = `
      <div class="cron-table-wrap">
        <table class="log-table cron-table">
          <thead><tr><th>任务</th><th>启用</th><th>下次唤醒</th><th>状态 / 表达式</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="no-data">暂无任务</td></tr>'}</tbody>
        </table>
      </div>`;

    return `
      <div class="panel cron-panel">
        <div class="panel-header">
          <h3>定时任务</h3>
        </div>
        ${cards}
        ${errorHtml}
        ${taskTable}
        <div class="card-time">${sourceText || '-'}</div>
        <div class="card-time">更新: ${state.lastCheck ? toBJ(state.lastCheck) : '-'}</div>
      </div>`;
  }

  return { name: 'cron', routes, render, startPolling, stopPolling, refresh, getStatus };
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function fileStamp(filePath) {
  return [filePath, `${filePath}-wal`].map(p => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  }).join('|');
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function isoToMs(iso) {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract resolved native session/conversation ID from a T3 Code provider_thread row.
 * Prefers structured payload_json.nativeThreadRef.nativeId (which resolves even when
 * provider_thread_id still has a "pending:" key!), falling back to provider_thread_id parsing.
 */
export function extractNativeIdFromProviderThread(providerThreadId = '', payloadJson = null) {
  const payload = typeof payloadJson === 'string' ? parseJsonSafe(payloadJson, null) : payloadJson;
  const refId = String(payload?.nativeThreadRef?.nativeId || '').trim();
  if (refId && !/^pending[:%]/i.test(refId)) {
    return refId;
  }

  const raw = String(providerThreadId || '');
  if (!raw || raw.includes(':pending%') || raw.includes(':pending:')) return '';
  const m = raw.match(/native-thread:([^:]+)$/);
  if (m && m[1]) {
    try {
      const decoded = decodeURIComponent(m[1]);
      return /^pending[:%]/i.test(decoded) ? '' : decoded;
    } catch {
      return m[1];
    }
  }
  return '';
}

function friendlyStepMeta(item) {
  const payload = parseJsonSafe(item.payload_json, {}) || {};
  const type = String(item.type || payload.type || 'step');
  const toolName = String(payload.toolName || payload.name || '').trim();
  const title = String(payload.title || payload.summary || toolName || type).trim();

  // Only compute started/completed timestamps from real lifecycle fields; never fabricate 0ms from identical updated_at
  const startedAtMs = isoToMs(payload.startedAt || payload.createdAt);
  const completedAtMs = (item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled')
    ? isoToMs(payload.completedAt)
    : null;

  let phase = 'working';
  let phaseLabel = '执行中';
  if (type === 'reasoning') { phase = 'thinking'; phaseLabel = '思考'; }
  else if (type === 'command_execution') { phase = 'command'; phaseLabel = '命令'; }
  else if (type === 'file_change') { phase = 'edit'; phaseLabel = '编辑'; }
  else if (type === 'file_search' || /search|find|grep/i.test(toolName)) { phase = 'search'; phaseLabel = '检索'; }
  else if (type === 'dynamic_tool') { phase = 'tool'; phaseLabel = toolName ? `工具: ${toolName}` : '工具'; }
  else if (type === 'assistant_message') { phase = 'responding'; phaseLabel = '回复'; }
  else if (type === 'user_message') { phase = 'user'; phaseLabel = '输入'; }
  else if (type === 'subagent' || /subagent|delegate/i.test(type)) { phase = 'subagent'; phaseLabel = '子任务'; }

  return {
    id: item.turn_item_id,
    ordinal: item.ordinal,
    type,
    status: item.status,
    phase,
    phaseLabel,
    toolName,
    title: title.slice(0, 120),
    startedAtMs,
    completedAtMs,
    updatedAtMs: isoToMs(item.updated_at)
  };
}

export function readProviderInstances(settingsPath) {
  const instances = new Map();
  if (!settingsPath || !existsSync(settingsPath)) return instances;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const raw = parsed?.providerInstances;
    if (raw && typeof raw === 'object') {
      for (const [instanceId, cfg] of Object.entries(raw)) {
        if (!cfg || typeof cfg !== 'object') continue;
        instances.set(instanceId, {
          instanceId,
          driver: cfg.driver || instanceId,
          displayName: cfg.displayName || instanceId,
          accentColor: cfg.accentColor || '',
          enabled: cfg.enabled !== false,
          homePath: typeof cfg.config?.homePath === 'string' ? cfg.config.homePath.trim() : ''
        });
      }
    }
  } catch {
    // ignore invalid settings.json
  }
  return instances;
}

export function createT3StateAdapter(paths) {
  let cachedIndexStamp = '';
  let cachedIndex = null;

  let previousUndatedFailures = null;
  function openReadOnly() {
    if (!paths.stateDbPath || !existsSync(paths.stateDbPath)) return null;
    const db = new DatabaseSync(paths.stateDbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    return db;
  }

  function getExistingTables(db) {
    return new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
    );
  }

  function getTableColumns(db, tableName) {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name));
  }

  /**
   * Build cached mapping index:
   * - threadsById: threadId -> metadata
   * - nativeToThread: nativeSessionId -> { threadId, title, accountId, driver }
   * - threadToNatives: threadId -> Array<{ providerThreadId, nativeSessionId, accountId, driver, status }>
   * - providerThreadToNative: providerThreadId -> { nativeSessionId, accountId, driver }
   */
  function readThreadIndex() {
    const stamp = fileStamp(paths.stateDbPath);
    if (cachedIndex && cachedIndexStamp === stamp) return cachedIndex;

    const threadsById = new Map();
    const nativeToThread = new Map();
    const threadToNatives = new Map();
    const providerThreadToNative = new Map();

    let db;
    try {
      db = openReadOnly();
      if (!db) {
        return { threadsById, nativeToThread, threadToNatives, providerThreadToNative, latestThreadId: null, recentThreads: [] };
      }
      const tables = getExistingTables(db);

      if (tables.has('orchestration_v2_projection_threads')) {
        const cols = getTableColumns(db, 'orchestration_v2_projection_threads');
        const env = cols.has('environment_id') ? 'environment_id' : 'NULL';
        const project = cols.has('project_id') ? 'project_id' : 'NULL';
        const rows = db.prepare(`
          SELECT ${env} AS environment_id, ${project} AS project_id, thread_id, title, default_provider, provider_instance_id, updated_at, archived_at, deleted_at
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC
        `).all();
        for (const r of rows) {
          threadsById.set(r.thread_id, {
            threadId: r.thread_id,
            title: r.title || '未命名会话',
            environmentId: r.environment_id, projectId: r.project_id,
            defaultProvider: r.default_provider || '',
            providerInstanceId: r.provider_instance_id || r.default_provider || '',
            updatedAtMs: isoToMs(r.updated_at) || 0,
            archived: Boolean(r.archived_at)
          });
        }
      }

      if (tables.has('orchestration_v2_projection_provider_threads')) {
        const cols = getTableColumns(db, 'orchestration_v2_projection_provider_threads');
        const hasPayload = cols.has('payload_json');
        const sql = hasPayload
          ? `SELECT provider_thread_id, thread_id, provider, driver, provider_instance_id, provider_session_id, status, updated_at, payload_json
             FROM orchestration_v2_projection_provider_threads ORDER BY updated_at DESC`
          : `SELECT provider_thread_id, thread_id, provider, driver, provider_instance_id, provider_session_id, status, updated_at
             FROM orchestration_v2_projection_provider_threads ORDER BY updated_at DESC`;

        for (const r of db.prepare(sql).all()) {
          const nativeId = extractNativeIdFromProviderThread(r.provider_thread_id, r.payload_json);
          if (!nativeId) continue;
          const accountId = r.provider_instance_id || r.provider || r.driver || 'unknown';
          const driver = r.driver || r.provider || 'unknown';
          const threadMeta = threadsById.get(r.thread_id);
          const entry = {
            providerThreadId: r.provider_thread_id,
            nativeSessionId: nativeId,
            threadId: r.thread_id || null,
            title: threadMeta?.title || '',
            accountId,
            driver,
            status: r.status || ''
          };
          providerThreadToNative.set(r.provider_thread_id, entry);
          if (!nativeToThread.has(nativeId)) {
            nativeToThread.set(nativeId, entry);
          }
          if (r.thread_id) {
            let list = threadToNatives.get(r.thread_id);
            if (!list) {
              list = [];
              threadToNatives.set(r.thread_id, list);
            }
            if (!list.some(x => x.nativeSessionId === nativeId && x.providerThreadId === r.provider_thread_id)) {
              list.push(entry);
            }
          }
        }
      }

      if (tables.has('provider_session_runtime')) {
        const rows = db.prepare(`
          SELECT thread_id, provider_name, provider_instance_id, runtime_payload_json
          FROM provider_session_runtime
          WHERE runtime_payload_json IS NOT NULL
        `).all();
        for (const r of rows) {
          const payload = parseJsonSafe(r.runtime_payload_json, null);
          const imported = Array.isArray(payload?.importedTranscripts) ? payload.importedTranscripts : [];
          for (const item of imported) {
            const nativeId = String(item?.providerSessionId || '').trim();
            if (!nativeId) continue;
            const threadMeta = threadsById.get(r.thread_id);
            const accountId = item.providerInstanceId || r.provider_instance_id || r.provider_name || 'codex';
            const driver = item.provider || r.provider_name || 'codex';
            const entry = {
              providerThreadId: '',
              nativeSessionId: nativeId,
              threadId: r.thread_id,
              title: threadMeta?.title || '',
              accountId,
              driver,
              filePath: item.filePath || ''
            };
            if (!nativeToThread.has(nativeId)) nativeToThread.set(nativeId, entry);
            let list = threadToNatives.get(r.thread_id);
            if (!list) { list = []; threadToNatives.set(r.thread_id, list); }
            if (!list.some(x => x.nativeSessionId === nativeId)) list.push(entry);
          }
        }
      }

      const recentThreads = [];
      let latestThreadId = null;
      for (const t of threadsById.values()) {
        if (!t.threadId.startsWith('thread:subagent:') && !t.archived) {
          if (!latestThreadId) latestThreadId = t.threadId;
          if (recentThreads.length < 30) {
            recentThreads.push({
              threadId: t.threadId,
              title: t.title,
              accountId: t.providerInstanceId,
              updatedAtMs: t.updatedAtMs
            });
          }
        }
      }
      if (!latestThreadId) latestThreadId = threadsById.keys().next().value || null;

      cachedIndex = { threadsById, nativeToThread, threadToNatives, providerThreadToNative, latestThreadId, recentThreads };
      cachedIndexStamp = stamp;
      return cachedIndex;
    } catch {
      return cachedIndex || { threadsById, nativeToThread, threadToNatives, providerThreadToNative, latestThreadId: null, recentThreads: [] };
    } finally {
      try { db?.close(); } catch {}
    }
  }

  /**
   * Read real-time run phase, step durations, queued follow-ups, pending approvals,
   * and actively streaming text for a specific T3 Code thread.
   * When allowFallback=false (desktop injected client) and threadId cannot be matched,
   * returns an explicit unresolved state instead of leaking another thread's usage.
   */
  function readThreadExecution(requestedThreadId = '', now = Date.now(), { allowFallback = true } = {}) {
    const index = readThreadIndex();
    const trimmedReq = String(requestedThreadId || '').trim();
    let threadId = '';

    if (trimmedReq) {
      if (index.threadsById.has(trimmedReq)) {
        threadId = trimmedReq;
      } else if (!allowFallback) {
        return {
          unresolved: true,
          reason: '打开会话后显示',
          requestedThreadId: trimmedReq,
          recentThreads: index.recentThreads
        };
      } else {
        threadId = index.latestThreadId || '';
      }
    } else if (allowFallback) {
      threadId = index.latestThreadId || '';
    } else {
      return {
        unresolved: true,
        reason: '打开会话后显示',
        requestedThreadId: '',
        recentThreads: index.recentThreads
      };
    }

    if (!threadId) return null;

    let db;
    try {
      db = openReadOnly();
      if (!db) return null;
      const tables = getExistingTables(db);
      const threadMeta = index.threadsById.get(threadId) || {
        threadId,
        title: '当前会话',
        providerInstanceId: '',
        defaultProvider: ''
      };
      const allNatives = index.threadToNatives.get(threadId) || [];

      // Prefer active run across the ENTIRE thread, count ALL queued runs, and fall back to latest run (fixes P2 #13)
      let selectedRun = null;
      let queuedRuns = 0;
      if (tables.has('orchestration_v2_projection_runs')) {
        const queuedRow = db.prepare(`
          SELECT COUNT(*) AS c FROM orchestration_v2_projection_runs
          WHERE thread_id = ? AND status = 'queued'
        `).get(threadId);
        queuedRuns = Number(queuedRow?.c || 0);

        selectedRun = db.prepare(`
          SELECT run_id, ordinal, provider, provider_instance_id, provider_thread_id, status, requested_at, completed_at, payload_json
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ? AND status IN ('running', 'starting', 'waiting')
          ORDER BY ordinal DESC
          LIMIT 1
        `).get(threadId) || db.prepare(`
          SELECT run_id, ordinal, provider, provider_instance_id, provider_thread_id, status, requested_at, completed_at, payload_json
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ?
          ORDER BY ordinal DESC
          LIMIT 1
        `).get(threadId) || null;
      }

      const runPayload = parseJsonSafe(selectedRun?.payload_json, {}) || {};
      const modelSelection = runPayload.modelSelection || {};
      const accountId = selectedRun?.provider_instance_id || modelSelection.instanceId || selectedRun?.provider || threadMeta.providerInstanceId || '';
      const selectedModel = modelSelection.model || '';
      const runStatus = selectedRun?.status || 'idle';
      const runStartedAtMs = isoToMs(selectedRun?.requested_at);
      const runCompletedAtMs = isoToMs(selectedRun?.completed_at);

      // Order natives so the provider thread attached to selectedRun comes FIRST (fixes P1 #3)
      const orderedNatives = [];
      const runProviderThreadId = selectedRun?.provider_thread_id || runPayload.providerThreadId || '';
      if (runProviderThreadId && index.providerThreadToNative.has(runProviderThreadId)) {
        orderedNatives.push(index.providerThreadToNative.get(runProviderThreadId));
      }
      for (const n of allNatives) {
        if (!orderedNatives.some(x => x.nativeSessionId === n.nativeSessionId && x.driver === n.driver)) {
          orderedNatives.push(n);
        }
      }

      // Pending approvals / user input requests
      let pendingApproval = null;
      if (tables.has('orchestration_v2_projection_runtime_requests')) {
        const req = db.prepare(`
          SELECT runtime_request_id, kind, status, created_at
          FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ? AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
        `).get(threadId);
        if (req) {
          pendingApproval = {
            id: req.runtime_request_id,
            kind: req.kind,
            createdAtMs: isoToMs(req.created_at)
          };
        }
      }

      // Full per-step turn items for selected run
      const steps = [];
      if (selectedRun && tables.has('orchestration_v2_projection_turn_items')) {
        const rows = db.prepare(`
          SELECT turn_item_id, ordinal, type, status, updated_at, payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ? AND run_id = ?
          ORDER BY ordinal ASC
        `).all(threadId, selectedRun.run_id);

        for (const row of rows) {
          const step = friendlyStepMeta(row);
          if (step.type === 'user_message') continue;
          let durationMs = null;
          if (step.startedAtMs != null) {
            if (step.completedAtMs != null && step.completedAtMs >= step.startedAtMs) {
              durationMs = step.completedAtMs - step.startedAtMs;
            } else if (step.status === 'running') {
              durationMs = Math.max(0, now - step.startedAtMs);
            } else if (step.updatedAtMs != null && step.updatedAtMs > step.startedAtMs) {
              durationMs = step.updatedAtMs - step.startedAtMs;
            }
          }
          step.durationMs = durationMs;
          steps.push(step);
        }
      }

      // Check ACTIVELY streaming assistant message only (streaming = 1) (fixes P2 #12)
      let streamingInfo = { active: false, messageId: '', chars: 0, updatedAtMs: null };
      if (selectedRun && runStatus === 'running' && tables.has('orchestration_v2_projection_messages')) {
        const msg = db.prepare(`
          SELECT message_id, streaming, created_at, updated_at, payload_json
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ? AND run_id = ? AND role = 'assistant' AND streaming = 1
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(threadId, selectedRun.run_id);
        if (msg) {
          const mp = parseJsonSafe(msg.payload_json, {}) || {};
          const text = String(mp.text || mp.content || '');
          if (text.length > 0) {
            streamingInfo = {
              active: true,
              messageId: msg.message_id,
              chars: text.length,
              updatedAtMs: isoToMs(msg.updated_at) || now
            };
          }
        }
      }

      // Determine current phase
      const runningStep = [...steps].reverse().find(s => s.status === 'running');
      let phase = 'idle';
      let phaseLabel = '空闲';
      if (pendingApproval) {
        phase = 'waiting_approval';
        phaseLabel = pendingApproval.kind === 'user_input' ? '等待输入' : '等待确认';
      } else if (runStatus === 'running' || runStatus === 'starting') {
        if (runningStep) {
          phase = runningStep.phase;
          phaseLabel = runningStep.phaseLabel;
        } else if (streamingInfo.active) {
          phase = 'responding';
          phaseLabel = '生成中';
        } else {
          phase = 'thinking';
          phaseLabel = '思考中';
        }
      } else if (runStatus === 'queued') {
        phase = 'queued';
        phaseLabel = '排队中';
      } else if (runStatus === 'failed') {
        phase = 'error';
        phaseLabel = '已结束';
      } else if (runStatus === 'cancelled' || runStatus === 'interrupted') {
        phase = 'stopped';
        phaseLabel = '已中断';
      } else if (runStatus === 'completed') {
        phase = 'completed';
        phaseLabel = '已完成';
      }

      const runDurationMs = runStartedAtMs != null
        ? Math.max(0, (runCompletedAtMs ?? (runStatus === 'running' ? now : runStartedAtMs)) - runStartedAtMs)
        : null;

      return {
        unresolved: false,
        threadId,
        title: threadMeta.title,
        accountId,
        selectedModel,
        natives: orderedNatives,
        queuedRuns,
        recentThreads: index.recentThreads,
        run: selectedRun ? {
          runId: selectedRun.run_id,
          ordinal: selectedRun.ordinal,
          status: runStatus,
          startedAtMs: runStartedAtMs,
          completedAtMs: runCompletedAtMs,
          durationMs: runDurationMs
        } : null,
        phase,
        phaseLabel,
        pendingApproval,
        steps,
        totalSteps: steps.length,
        streaming: streamingInfo
      };
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch {}
    }
  }

  return {
    readFailedRuns(sinceMs) {
      const db = openReadOnly();
      try {
        if (!db || !getExistingTables(db).has('orchestration_v2_projection_runs')) return [];
        const rows = db.prepare(`SELECT run_id, thread_id, provider_instance_id, completed_at, payload_json
          FROM orchestration_v2_projection_runs WHERE status='failed' AND (completed_at >= ? OR completed_at IS NULL)`).all(new Date(sinceMs).toISOString());
        const undated = new Set(rows.filter(r => !r.completed_at).map(r => r.run_id));
        const fresh = rows.filter(r => r.completed_at || (previousUndatedFailures && !previousUndatedFailures.has(r.run_id)));
        previousUndatedFailures = undated;
        if (!fresh.length) return [];
        const index = readThreadIndex();
        return fresh.map(r => ({ id: 'run:' + r.run_id, timestampMs: isoToMs(r.completed_at) || Date.now(),
          modelId: parseJsonSafe(r.payload_json, {})?.modelSelection?.model, errorCode: 'failed',
          t3ThreadId: r.thread_id, t3ThreadTitle: index.threadsById.get(r.thread_id)?.title, accountId: r.provider_instance_id }));
      } finally { db?.close(); }
    },
    readThreadIndex,
    readThreadExecution,
    readProviderInstances: () => readProviderInstances(paths.settingsPath)
  };
}

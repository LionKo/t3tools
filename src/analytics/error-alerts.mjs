const labels = { 'rate-limit': '请求限流', region: '权限受限', timeout: '请求超时', eof: '连接中断', failed: '会话失败', unavailable: '服务不可用', connection: '连接失败', other: '其他错误', test: '测试告警' };

export function createErrorAlerts(start = Date.now()) {
  const ring = [], seen = new Map(), windows = new Map(), last = new Map();
  let seq = 0;
  function emit(r, config, now, countInWindow) {
    const errorCode = r.errorCode || 'other';
    const alert = { seq: ++seq, id: String(seq), createdAtMs: now, modelId: r.modelId || '未知模型',
      severity: ['rate-limit','region','failed'].includes(errorCode) ? 'high' : 'warning',
      errorCode, errorLabel: labels[errorCode] || errorCode, errorText: r.errorText || '',
      countInWindow, t3ThreadId: r.t3ThreadId, t3ThreadTitle: r.t3ThreadTitle, accountId: r.accountId,
      desktopNotify: config.enabled && config.desktopNotification && config.mode !== 'quiet' };
    ring.unshift(alert);
    if (ring.length > 30) ring.pop();
    return alert;
  }
  return {
    evaluate(events, config, now = Date.now()) {
      const cutoff = Math.max(start, now - 1800000);
      for (const [id, ts] of seen) if (ts < cutoff) seen.delete(id);
      for (const [model, times] of windows) if (!times.some(t => t >= cutoff)) windows.delete(model);
      for (const [model, alert] of last) if (now - alert.createdAtMs >= config.cooldownMs) last.delete(model);
      for (const r of events.sort((a,b) => a.timestampMs - b.timestampMs)) {
        if (r.timestampMs < cutoff || seen.has(r.id)) continue;
        seen.set(r.id,r.timestampMs);
        if (!config.enabled || (config.mode === 'every' && r.status === 'success')) continue;
        const model = r.modelId || '';
        const times = (windows.get(model) || []).filter(t => t >= now - config.burstWindowMs);
        if (r.timestampMs >= now - config.burstWindowMs) times.push(r.timestampMs);
        windows.set(model,times);
        const immediate = ['rate-limit','region','failed'].includes(r.errorCode);
        if (config.mode === 'smart' && !immediate && times.length < config.burstThreshold) continue;
        const bucket = `${model}::${immediate ? 'high' : 'warning'}`;
        const prev = last.get(bucket);
        if (prev && now - prev.createdAtMs < config.cooldownMs) {
          prev.countInWindow = Math.max(prev.countInWindow + 1,times.length);
          continue;
        }
        last.set(bucket,emit(r,config,now,Math.max(1,times.length)));
      }
    },
    test: config => emit({ modelId: 'T3Tools', errorCode: 'test' },config,Date.now(),1),
    snapshot: () => ({ latestSeq: seq, latestAlert: ring[0] || null, recentAlerts: ring.slice() })
  };
}

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRDblpScheduler = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_DBLP_REQUEST_POLICY = Object.freeze({
    maxConcurrent: 1,
    minDelayMs: 1200,
    jitterMs: Object.freeze([200, 800]),
    maxRetries: 2,
    retryBackoffMs: Object.freeze([5000, 15000]),
    respectRetryAfter: true,
    globalCooldownStorageKey: "gsvr_dblp_cooldown_v1",
    maxRetryAfterMs: 30 * 60 * 1000,
  });

  const REQUEST_PRIORITY = Object.freeze({
    author_search: 0,
    profile_verify_sparql: 0,
    author_xml: 0,
    stream_fast: 1,
    stream_depth: 2,
  });

  function normalizePolicy(policy = {}) {
    const next = policy && typeof policy === "object" ? policy : {};
    const jitter = Array.isArray(next.jitterMs) ? next.jitterMs : DEFAULT_DBLP_REQUEST_POLICY.jitterMs;
    const backoff = Array.isArray(next.retryBackoffMs) ? next.retryBackoffMs : DEFAULT_DBLP_REQUEST_POLICY.retryBackoffMs;
    return {
      ...DEFAULT_DBLP_REQUEST_POLICY,
      ...next,
      maxConcurrent: Math.max(1, Number(next.maxConcurrent ?? DEFAULT_DBLP_REQUEST_POLICY.maxConcurrent) || 1),
      minDelayMs: Math.max(0, Number(next.minDelayMs ?? DEFAULT_DBLP_REQUEST_POLICY.minDelayMs) || 0),
      jitterMs: [
        Math.max(0, Number(jitter[0]) || 0),
        Math.max(0, Number(jitter[1] ?? jitter[0]) || 0),
      ],
      maxRetries: Math.max(0, Number(next.maxRetries ?? DEFAULT_DBLP_REQUEST_POLICY.maxRetries) || 0),
      retryBackoffMs: [
        Math.max(0, Number(backoff[0]) || 0),
        Math.max(0, Number(backoff[1] ?? backoff[0]) || 0),
      ],
      respectRetryAfter: next.respectRetryAfter !== false,
      globalCooldownStorageKey: String(next.globalCooldownStorageKey || DEFAULT_DBLP_REQUEST_POLICY.globalCooldownStorageKey),
      maxRetryAfterMs: Math.max(0, Number(next.maxRetryAfterMs ?? DEFAULT_DBLP_REQUEST_POLICY.maxRetryAfterMs) || 0),
    };
  }

  function parseRetryAfterMs(headers, maxDelay = DEFAULT_DBLP_REQUEST_POLICY.maxRetryAfterMs, now = Date.now()) {
    const retryAfter = headers?.get?.("retry-after") || headers?.get?.("Retry-After");
    if (!retryAfter) {
      return null;
    }
    const retrySeconds = Number(retryAfter);
    if (Number.isFinite(retrySeconds) && retrySeconds >= 0) {
      return Math.min(maxDelay, retrySeconds * 1000);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(maxDelay, Math.max(0, retryAt - now));
    }
    return null;
  }

  function cloneHeaders(responseHeaders) {
    const headersObj = {};
    try {
      responseHeaders?.forEach?.((value, key) => {
        headersObj[key] = value;
      });
    } catch (_) {
      // Header iteration can fail in mocked environments; the body/status still matter.
    }
    return headersObj;
  }

  function buildResponsePayload({ ok = false, status, statusText = "", headers = {}, bodyText = "", meta = null }) {
    return {
      ok,
      status,
      statusText,
      headers,
      bodyText,
      meta: meta && typeof meta === "object" ? meta : null,
    };
  }

  function inferFailureKind(status) {
    const numericStatus = Number(status);
    if (numericStatus === 429) return "rate_limited";
    if (numericStatus === 408 || numericStatus === 504 || numericStatus === 599) return "busy";
    if ([500, 502, 503].includes(numericStatus)) return "busy";
    return null;
  }

  function isRetryableStatus(status) {
    return [408, 500, 502, 503, 504, 599].includes(Number(status));
  }

  function getPriority(requestClass) {
    return REQUEST_PRIORITY[String(requestClass || "").trim()] ?? 1;
  }

  function delay(ms, setTimer) {
    const waitMs = Math.max(0, Number(ms) || 0);
    if (waitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimer(resolve, waitMs));
  }

  function rangeValue(range, random) {
    const min = Math.max(0, Number(range?.[0]) || 0);
    const max = Math.max(min, Number(range?.[1] ?? min) || min);
    if (max <= min) {
      return min;
    }
    return min + Math.floor((max - min) * random());
  }

  function createDblpScheduler(deps = {}) {
    const policy = normalizePolicy(deps.policy);
    const fetchImpl = deps.fetch || globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") {
      throw new Error("createDblpScheduler requires a fetch implementation.");
    }
    const storageArea = deps.storageArea || null;
    const setTimer = deps.setTimeout || setTimeout;
    const clearTimer = deps.clearTimeout || clearTimeout;
    const now = typeof deps.now === "function" ? deps.now : () => Date.now();
    const random = typeof deps.random === "function" ? deps.random : () => Math.random();

    let inFlightCount = 0;
    let cooldownUntil = 0;
    let lastRequestStartedAt = 0;
    let pumpTimeout = null;
    const queue = [];
    const pendingGroups = new Map();

    async function readStoredCooldownUntil() {
      if (!storageArea?.get || !policy.globalCooldownStorageKey) {
        return 0;
      }
      try {
        const result = await storageArea.get(policy.globalCooldownStorageKey);
        const raw = result?.[policy.globalCooldownStorageKey];
        const value = typeof raw === "object" && raw !== null ? Number(raw.cooldownUntil) : Number(raw);
        return Number.isFinite(value) ? value : 0;
      } catch (_) {
        return 0;
      }
    }

    async function rememberCooldownUntil(value, reason = "rate_limited") {
      const next = Math.max(cooldownUntil, Number(value) || 0);
      cooldownUntil = next;
      if (!storageArea?.set || !policy.globalCooldownStorageKey) {
        return next;
      }
      try {
        await storageArea.set({
          [policy.globalCooldownStorageKey]: {
            cooldownUntil: next,
            reason,
            updatedAt: new Date(now()).toISOString(),
          },
        });
      } catch (_) {
        // Memory cooldown still protects this service-worker lifetime.
      }
      return next;
    }

    function schedulePump(delayMs = 0) {
      if (pumpTimeout) {
        clearTimer(pumpTimeout);
      }
      pumpTimeout = setTimer(() => {
        pumpTimeout = null;
        void pumpQueue();
      }, Math.max(0, Number(delayMs) || 0));
    }

    function enqueueGroup(group) {
      const priority = getPriority(group.requestClass);
      let insertIndex = queue.length;
      for (let index = 0; index < queue.length; index += 1) {
        if (getPriority(queue[index].requestClass) > priority) {
          insertIndex = index;
          break;
        }
      }
      queue.splice(insertIndex, 0, group);
    }

    function flushGroup(group, payload) {
      pendingGroups.delete(group.key);
      for (const responder of group.responders) {
        responder(payload);
      }
    }

    async function fetchOnce(group, attempt) {
      let timeoutId = null;
      try {
        const requestedTimeoutMs = Number.isFinite(Number(group.timeoutMs)) ? Number(group.timeoutMs) : 12000;
        const timeoutMs = Math.max(250, Math.min(requestedTimeoutMs, 30000));
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        if (controller) {
          timeoutId = setTimer(() => controller.abort(), timeoutMs);
        }
        const response = await fetchImpl(group.url, {
          ...(group.init || {}),
          signal: controller ? controller.signal : undefined,
        });
        const retryAfterMs = policy.respectRetryAfter
          ? parseRetryAfterMs(response.headers, policy.maxRetryAfterMs, now())
          : null;
        if (response.status === 429) {
          await rememberCooldownUntil(now() + Math.max(retryAfterMs ?? 0, policy.minDelayMs), "rate_limited");
        }
        const bodyText = await response.text();
        return buildResponsePayload({
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: cloneHeaders(response.headers),
          bodyText,
          meta: {
            failureKind: response.ok ? null : inferFailureKind(response.status),
            retryAfterMs: retryAfterMs ?? null,
            cooldownUntil: cooldownUntil || null,
            queuedMs: now() - group.enqueuedAt,
            attempt,
            retryCount: attempt,
          },
        });
      } catch (error) {
        const isTimeout = error && error.name === "AbortError";
        return buildResponsePayload({
          ok: false,
          status: isTimeout ? 504 : 599,
          statusText: isTimeout
            ? `timed out after ${group.timeoutMs || 12000}ms`
            : ((error && error.message) ? String(error.message) : "fetch failed"),
          headers: {},
          bodyText: "",
          meta: {
            failureKind: "busy",
            retryAfterMs: Math.max(0, cooldownUntil - now()) || null,
            cooldownUntil: cooldownUntil || null,
            queuedMs: now() - group.enqueuedAt,
            attempt,
            retryCount: attempt,
          },
        });
      } finally {
        if (timeoutId) {
          clearTimer(timeoutId);
        }
      }
    }

    async function dispatchGroup(group) {
      inFlightCount += 1;
      lastRequestStartedAt = now();
      try {
        let payload = null;
        for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
          payload = await fetchOnce(group, attempt);
          const retryable = !payload.ok && isRetryableStatus(payload.status) && attempt < policy.maxRetries;
          if (!retryable) {
            break;
          }
          await delay(rangeValue(policy.retryBackoffMs, random), setTimer);
        }
        flushGroup(group, payload);
      } finally {
        inFlightCount = Math.max(0, inFlightCount - 1);
        void pumpQueue();
      }
    }

    async function pumpQueue() {
      if (!queue.length) {
        return;
      }

      cooldownUntil = Math.max(cooldownUntil, await readStoredCooldownUntil());
      const currentTime = now();
      if (currentTime < cooldownUntil) {
        schedulePump(cooldownUntil - currentTime);
        return;
      }

      const nextAllowedStart = lastRequestStartedAt > 0
        ? lastRequestStartedAt + policy.minDelayMs + rangeValue(policy.jitterMs, random)
        : 0;
      if (currentTime < nextAllowedStart) {
        schedulePump(nextAllowedStart - currentTime);
        return;
      }

      while (inFlightCount < policy.maxConcurrent && queue.length > 0) {
        const group = queue.shift();
        if (!group || !pendingGroups.has(group.key)) {
          continue;
        }
        const waitedMs = now() - group.enqueuedAt;
        if (Number.isFinite(group.waitBudgetMs) && group.waitBudgetMs > 0 && waitedMs > group.waitBudgetMs) {
          flushGroup(group, buildResponsePayload({
            ok: false,
            status: 599,
            statusText: "DBLP fetch budget exhausted while waiting in queue",
            headers: {},
            bodyText: "",
            meta: {
              failureKind: group.allowDefer ? "deferred" : "busy",
              retryAfterMs: Math.max(0, cooldownUntil - now()) || null,
              cooldownUntil: cooldownUntil || null,
              queuedMs: waitedMs,
              attempt: 0,
              retryCount: 0,
            },
          }));
          continue;
        }
        void dispatchGroup(group);
      }
    }

    function schedule(request) {
      const input = request && typeof request === "object" ? request : {};
      const dedupeKey = String(
        input.dedupeKey
        || `${String(input.init?.method || "GET").toUpperCase()}:${input.url}:${typeof input.init?.body === "string" ? input.init.body : ""}`
      );
      const existing = pendingGroups.get(dedupeKey);
      if (existing) {
        return new Promise((resolve) => {
          existing.responders.push(resolve);
        });
      }
      const group = {
        key: dedupeKey,
        url: String(input.url || ""),
        init: input.init || undefined,
        timeoutMs: input.timeoutMs,
        requestClass: input.requestClass || null,
        waitBudgetMs: Number.isFinite(Number(input.waitBudgetMs)) ? Number(input.waitBudgetMs) : null,
        allowDefer: input.allowDefer === true,
        enqueuedAt: now(),
        responders: [],
      };
      const promise = new Promise((resolve) => {
        group.responders.push(resolve);
      });
      pendingGroups.set(group.key, group);
      enqueueGroup(group);
      void pumpQueue();
      return promise;
    }

    function getState() {
      return {
        inFlightCount,
        cooldownUntil,
        queuedCount: queue.length,
        pendingCount: pendingGroups.size,
        policy: { ...policy, jitterMs: policy.jitterMs.slice(), retryBackoffMs: policy.retryBackoffMs.slice() },
      };
    }

    return {
      schedule,
      getState,
      rememberCooldownUntil,
      readStoredCooldownUntil,
    };
  }

  return {
    DEFAULT_DBLP_REQUEST_POLICY,
    REQUEST_PRIORITY,
    normalizePolicy,
    parseRetryAfterMs,
    cloneHeaders,
    buildResponsePayload,
    inferFailureKind,
    createDblpScheduler,
  };
});

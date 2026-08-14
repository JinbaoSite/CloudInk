import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type ModelOption = { value: string; description: string };
type ScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  cron_expression: string;
  timezone: string;
  model: string | null;
  permission_mode: "auto" | "plan" | "manual" | "acceptEdits";
  overlap_policy: "skip" | "queue";
  enabled: 0 | 1;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: RunStatus | null;
  last_finished_at: string | null;
  run_count: number;
};
type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "canceled"
  | "skipped";
type ScheduledRun = {
  id: string;
  session_id: string | null;
  scheduled_for: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  title: string | null;
};
type ScheduleKind = "minutes" | "hours" | "daily" | "weekly" | "custom";
type TaskDraft = {
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  interval: number;
  time: string;
  weekday: number;
  cronExpression: string;
  timezone: string;
  model: string;
  mode: ScheduledTask["permission_mode"];
  overlapPolicy: ScheduledTask["overlap_policy"];
  enabled: boolean;
};

const emptyDraft = (model: string): TaskDraft => ({
  name: "",
  prompt: "",
  scheduleKind: "daily",
  interval: 30,
  time: "09:00",
  weekday: 1,
  cronExpression: "0 9 * * *",
  timezone: "Asia/Shanghai",
  model,
  mode: "auto",
  overlapPolicy: "skip",
  enabled: true,
});

async function taskApi(path: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败（${response.status}）`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function cronFromDraft(draft: TaskDraft) {
  const [hour, minute] = draft.time.split(":").map(Number);
  if (draft.scheduleKind === "minutes")
    return `*/${Math.max(1, draft.interval)} * * * *`;
  if (draft.scheduleKind === "hours")
    return `0 */${Math.max(1, draft.interval)} * * *`;
  if (draft.scheduleKind === "daily") return `${minute} ${hour} * * *`;
  if (draft.scheduleKind === "weekly")
    return `${minute} ${hour} * * ${draft.weekday}`;
  return draft.cronExpression.trim();
}

function formatDate(value: string | null, timezone = "Asia/Shanghai") {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date(value))
    .replaceAll("/", "-");
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds == null) return "—";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatTokens(run: ScheduledRun) {
  const tokens = (run.input_tokens || 0) + (run.output_tokens || 0);
  if (!tokens) return "—";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

const statusCopy: Record<RunStatus, string> = {
  queued: "等待执行",
  running: "正在执行",
  succeeded: "执行成功",
  failed: "执行失败",
  interrupted: "执行中断",
  canceled: "已取消",
  skipped: "已跳过",
};

function scheduleCopy(task: ScheduledTask) {
  const cron = task.cron_expression;
  const minuteMatch = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (minuteMatch) return `每 ${minuteMatch[1]} 分钟`;
  const hourMatch = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) return `每 ${hourMatch[1]} 小时`;
  const dailyMatch = cron.match(/^(\d+) (\d+) \* \* \*$/);
  if (dailyMatch)
    return `每天 ${dailyMatch[2].padStart(2, "0")}:${dailyMatch[1].padStart(2, "0")}`;
  const weeklyMatch = cron.match(/^(\d+) (\d+) \* \* ([0-6])$/);
  if (weeklyMatch) {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${weekdays[Number(weeklyMatch[3])]} ${weeklyMatch[2].padStart(2, "0")}:${weeklyMatch[1].padStart(2, "0")}`;
  }
  return cron;
}

export default function ScheduledTasks({
  modelOptions,
  currentModel,
  sidebarContainer,
  onOpenRun,
  onOpenSidebar,
}: {
  modelOptions: ModelOption[];
  currentModel: string;
  sidebarContainer: HTMLElement | null;
  onOpenRun: (sessionId: string, title: string) => void;
  onOpenSidebar: () => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState(() => emptyDraft(currentModel));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const selectedTask = tasks.find((task) => task.id === selectedId) || null;

  const loadTasks = async (keepSelection = true) => {
    const result = (await taskApi("/scheduled-tasks")) as ScheduledTask[];
    setTasks(result);
    setSelectedId((current) =>
      keepSelection && result.some((task) => task.id === current)
        ? current
        : result[0]?.id || "",
    );
    setLoading(false);
  };
  const loadRuns = async (taskId: string) => {
    setRuns(
      (await taskApi(`/scheduled-tasks/${taskId}/runs`)) as ScheduledRun[],
    );
  };

  useEffect(() => {
    void loadTasks(false).catch((error) => {
      setNotice((error as Error).message);
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    void loadRuns(selectedId).catch((error) =>
      setNotice((error as Error).message),
    );
  }, [selectedId]);
  const hasLiveRun = useMemo(
    () =>
      runs.some((run) => run.status === "queued" || run.status === "running"),
    [runs],
  );
  useEffect(() => {
    if (!selectedId || !hasLiveRun) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadRuns(selectedId), loadTasks()]);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [selectedId, hasLiveRun]);

  const openCreate = () => {
    setEditingId("");
    setDraft(emptyDraft(currentModel));
    setNotice("");
    setFormOpen(true);
  };
  const openEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setDraft({
      name: task.name,
      prompt: task.prompt,
      scheduleKind: "custom",
      interval: 30,
      time: "09:00",
      weekday: 1,
      cronExpression: task.cron_expression,
      timezone: task.timezone,
      model: task.model || currentModel,
      mode: task.permission_mode,
      overlapPolicy: task.overlap_policy,
      enabled: Boolean(task.enabled),
    });
    setNotice("");
    setFormOpen(true);
  };
  const saveTask = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    try {
      const body = {
        name: draft.name,
        prompt: draft.prompt,
        cronExpression: cronFromDraft(draft),
        timezone: draft.timezone,
        model: draft.model || null,
        mode: draft.mode,
        overlapPolicy: draft.overlapPolicy,
        enabled: draft.enabled,
      };
      await taskApi(
        editingId ? `/scheduled-tasks/${editingId}` : "/scheduled-tasks",
        {
          method: editingId ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      setFormOpen(false);
      await loadTasks(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const updateTask = async (
    task: ScheduledTask,
    overrides: Partial<{ enabled: boolean }>,
  ) => {
    await taskApi(`/scheduled-tasks/${task.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: task.name,
        prompt: task.prompt,
        cronExpression: task.cron_expression,
        timezone: task.timezone,
        model: task.model,
        mode: task.permission_mode,
        overlapPolicy: task.overlap_policy,
        enabled: overrides.enabled ?? Boolean(task.enabled),
      }),
    });
    await loadTasks();
  };

  const sidebar = (
    <div className="schedule-task-list" aria-label="定时任务列表">
      <div className="schedule-sidebar-heading">
        <div>
          <b>定时任务</b>
          <small>{tasks.length} 个任务</small>
        </div>
        <button type="button" onClick={openCreate}>
          <span aria-hidden="true">+</span>
          新建
        </button>
      </div>
      <div className="schedule-sidebar-list">
        {loading ? (
          <div className="schedule-empty">正在读取任务…</div>
        ) : tasks.length ? (
          tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              className={task.id === selectedId ? "active" : ""}
              onClick={() => setSelectedId(task.id)}
            >
              <span
                className={`schedule-state${task.enabled ? " enabled" : ""}`}
              />
              <span className="schedule-task-copy">
                <b>{task.name}</b>
                <small>{scheduleCopy(task)}</small>
              </span>
              {task.last_status && (
                <span className={`run-status ${task.last_status}`}>
                  {statusCopy[task.last_status]}
                </span>
              )}
            </button>
          ))
        ) : (
          <div className="schedule-empty">
            <span className="schedule-empty-clock" aria-hidden="true">
              ◷
            </span>
            <b>还没有定时任务</b>
            <span>创建后，Claude 会按周期在后台执行。</span>
            <button type="button" onClick={openCreate}>
              创建第一个任务
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <section className="schedule-page">
      {sidebarContainer && createPortal(sidebar, sidebarContainer)}
      <header className="schedule-page-header">
        <button
          type="button"
          className="mobile-header-button menu-button"
          aria-label="打开侧边栏"
          onClick={onOpenSidebar}
        >
          ☰
        </button>
        <div>
          <h1>定时任务</h1>
          <p>按计划让 Claude 在后台执行工作</p>
        </div>
      </header>
      <div className="schedule-page-body">
        <main className="schedule-detail">
          {selectedTask ? (
            <>
              <div className="schedule-detail-heading">
                <div>
                  <div className="schedule-title-row">
                    <h2>{selectedTask.name}</h2>
                    <span
                      className={selectedTask.enabled ? "enabled" : "paused"}
                    >
                      {selectedTask.enabled ? "已启用" : "已暂停"}
                    </span>
                  </div>
                  <p>
                    {scheduleCopy(selectedTask)} · {selectedTask.timezone}
                  </p>
                </div>
                <div className="schedule-heading-actions">
                  <button type="button" onClick={() => openEdit(selectedTask)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateTask(selectedTask, {
                        enabled: !selectedTask.enabled,
                      }).catch((error) => setNotice((error as Error).message))
                    }
                  >
                    {selectedTask.enabled ? "暂停" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="schedule-run-now"
                    onClick={() => {
                      setNotice("");
                      void taskApi(`/scheduled-tasks/${selectedTask.id}/run`, {
                        method: "POST",
                      })
                        .then(() =>
                          Promise.all([loadRuns(selectedTask.id), loadTasks()]),
                        )
                        .catch((error) => setNotice((error as Error).message));
                    }}
                  >
                    立即执行
                  </button>
                </div>
              </div>
              <div className="schedule-summary-grid">
                <div>
                  <span>下次执行</span>
                  <b>
                    {formatDate(
                      selectedTask.next_run_at,
                      selectedTask.timezone,
                    )}
                  </b>
                </div>
                <div>
                  <span>模型</span>
                  <b>{selectedTask.model || "CLI 默认"}</b>
                </div>
                <div>
                  <span>执行模式</span>
                  <b>{selectedTask.permission_mode}</b>
                </div>
                <div>
                  <span>累计执行</span>
                  <b>{selectedTask.run_count} 次</b>
                </div>
              </div>
              <section className="schedule-prompt-card">
                <div>
                  <b>执行内容</b>
                  <span>每次运行都会作为用户消息发送</span>
                </div>
                <p>{selectedTask.prompt}</p>
              </section>
              <div className="schedule-history-heading">
                <div>
                  <h3>执行历史</h3>
                  <span>点击记录查看完整聊天内容</span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void Promise.all([loadRuns(selectedTask.id), loadTasks()])
                  }
                >
                  刷新
                </button>
              </div>
              <div className="schedule-run-list">
                {runs.length ? (
                  runs.map((run) => (
                    <button
                      type="button"
                      key={run.id}
                      disabled={!run.session_id}
                      onClick={() =>
                        run.session_id &&
                        onOpenRun(run.session_id, `定时 · ${selectedTask.name}`)
                      }
                    >
                      <span className={`run-status-dot ${run.status}`} />
                      <span className="schedule-run-main">
                        <b>
                          {formatDate(run.scheduled_for, selectedTask.timezone)}
                        </b>
                        <small>
                          {run.error ||
                            (run.status === "running"
                              ? "Claude 正在后台执行…"
                              : statusCopy[run.status])}
                        </small>
                      </span>
                      <span className={`run-status ${run.status}`}>
                        {statusCopy[run.status]}
                      </span>
                      <span className="schedule-run-stat">
                        <small>耗时</small>
                        <b>{formatDuration(run.duration_ms)}</b>
                      </span>
                      <span className="schedule-run-stat">
                        <small>Tokens</small>
                        <b>{formatTokens(run)}</b>
                      </span>
                      {run.session_id && (
                        <span className="schedule-run-arrow">›</span>
                      )}
                    </button>
                  ))
                ) : (
                  <div className="schedule-empty compact">还没有执行记录</div>
                )}
              </div>
              <button
                type="button"
                className="schedule-delete"
                onClick={() => {
                  if (
                    !window.confirm(
                      `删除定时任务“${selectedTask.name}”及全部执行记录？`,
                    )
                  )
                    return;
                  void taskApi(`/scheduled-tasks/${selectedTask.id}`, {
                    method: "DELETE",
                  })
                    .then(() => loadTasks(false))
                    .catch((error) => setNotice((error as Error).message));
                }}
              >
                删除任务及执行记录
              </button>
            </>
          ) : !loading ? (
            <div className="schedule-detail-empty">
              <span>◷</span>
              <b>选择或创建一个定时任务</b>
              <p>任务的执行内容会保存在聊天对话中。</p>
            </div>
          ) : null}
        </main>
      </div>
      {formOpen && (
        <div
          className="schedule-modal-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setFormOpen(false)
          }
        >
          <form className="schedule-form" onSubmit={saveTask}>
            <header>
              <div>
                <h2>{editingId ? "编辑定时任务" : "新建定时任务"}</h2>
                <p>配置 Claude 自动执行的内容和周期</p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setFormOpen(false)}
              >
                ×
              </button>
            </header>
            <label>
              <span>任务名称</span>
              <input
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder="例如：每日推荐数据报告"
              />
            </label>
            <label>
              <span>执行内容</span>
              <textarea
                required
                rows={7}
                value={draft.prompt}
                onChange={(event) =>
                  setDraft({ ...draft, prompt: event.target.value })
                }
                placeholder="描述希望 Claude 周期性完成的工作…"
              />
            </label>
            <div className="schedule-form-row">
              <label>
                <span>执行周期</span>
                <select
                  value={draft.scheduleKind}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      scheduleKind: event.target.value as ScheduleKind,
                    })
                  }
                >
                  <option value="minutes">每隔几分钟</option>
                  <option value="hours">每隔几小时</option>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="custom">自定义 Cron</option>
                </select>
              </label>
              {(draft.scheduleKind === "minutes" ||
                draft.scheduleKind === "hours") && (
                <label>
                  <span>间隔</span>
                  <input
                    type="number"
                    min="1"
                    max={draft.scheduleKind === "minutes" ? 1440 : 168}
                    value={draft.interval}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        interval: Number(event.target.value),
                      })
                    }
                  />
                </label>
              )}
              {(draft.scheduleKind === "daily" ||
                draft.scheduleKind === "weekly") && (
                <label>
                  <span>执行时间</span>
                  <input
                    type="time"
                    required
                    value={draft.time}
                    onChange={(event) =>
                      setDraft({ ...draft, time: event.target.value })
                    }
                  />
                </label>
              )}
              {draft.scheduleKind === "weekly" && (
                <label>
                  <span>星期</span>
                  <select
                    value={draft.weekday}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        weekday: Number(event.target.value),
                      })
                    }
                  >
                    {[
                      "周日",
                      "周一",
                      "周二",
                      "周三",
                      "周四",
                      "周五",
                      "周六",
                    ].map((day, index) => (
                      <option value={index} key={day}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {draft.scheduleKind === "custom" && (
              <label>
                <span>5 段 Cron 表达式</span>
                <input
                  required
                  value={draft.cronExpression}
                  onChange={(event) =>
                    setDraft({ ...draft, cronExpression: event.target.value })
                  }
                  placeholder="0 9 * * 1-5"
                />
                <small>
                  分钟 小时 日期 月份 星期，例如工作日 09:00：0 9 * * 1-5
                </small>
              </label>
            )}
            <div className="schedule-form-row three">
              <label>
                <span>时区</span>
                <input
                  value={draft.timezone}
                  onChange={(event) =>
                    setDraft({ ...draft, timezone: event.target.value })
                  }
                />
              </label>
              <label>
                <span>模型</span>
                <select
                  value={draft.model}
                  onChange={(event) =>
                    setDraft({ ...draft, model: event.target.value })
                  }
                >
                  {modelOptions.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Mode</span>
                <select
                  value={draft.mode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      mode: event.target.value as TaskDraft["mode"],
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="acceptEdits">Edit automatically</option>
                  <option value="plan">Plan</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
            </div>
            <div className="schedule-form-row">
              <label>
                <span>任务重叠时</span>
                <select
                  value={draft.overlapPolicy}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      overlapPolicy: event.target
                        .value as TaskDraft["overlapPolicy"],
                    })
                  }
                >
                  <option value="skip">跳过本周期</option>
                  <option value="queue">排队等待</option>
                </select>
              </label>
              <label className="schedule-enabled">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft({ ...draft, enabled: event.target.checked })
                  }
                />
                <span>创建后立即启用</span>
              </label>
            </div>
            {notice && <div className="schedule-form-error">{notice}</div>}
            <footer>
              <button type="button" onClick={() => setFormOpen(false)}>
                取消
              </button>
              <button
                type="submit"
                className="schedule-primary"
                disabled={saving}
              >
                {saving ? "保存中…" : "保存任务"}
              </button>
            </footer>
          </form>
        </div>
      )}
      {notice && !formOpen && (
        <div className="schedule-toast" role="status">
          {notice}
          <button type="button" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
    </section>
  );
}

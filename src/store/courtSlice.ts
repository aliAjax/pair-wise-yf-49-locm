import { createSlice, type Draft, type PayloadAction } from "@reduxjs/toolkit";
import type { CourtEnvelope, Evidence, LegacyEnvelope, LedgerRevision, LedgerSegment, LedgerSession, LedgerState, Objection, Settlement, SettlementEntry, SessionPhase, SessionState, TimelineEntry } from "../types";

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "展示中", note: "第4页涉及合同补充约定", version: 1 },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩", version: 1 },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45", version: 1 }
];
const seedSession: SessionState = { phase: "质证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

const SEED_TIME = nowIso();
/** 初始台账：首条证据已上屏（S-1 / r1，公开屏已确认） */
const initialLedger: LedgerState = {
  nextRev: 2,
  nextSessionNo: 2,
  revLog: [{ rev: 1, sessionId: "S-1", evidenceId: "e1", kind: "display" as const, evidenceVersion: 1, createdAt: SEED_TIME }],
  sessions: [{
    id: "S-1", evidenceId: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", revisions: [1],
    segments: [{ startRev: 1, endRev: null, evidenceVersion: 1, startAt: SEED_TIME, endAt: null }],
    status: "上屏中" as const, shown: true, publishedAt: SEED_TIME, lastAppliedRev: 1,
    evidenceVersionAtShow: 1, invalidated: false, settledSeconds: null, recomputed: false, settlementId: null
  }],
  publicAppliedRev: 1,
  publicConfirmedAt: SEED_TIME,
  publicCurrentSessionId: "S-1",
  publicCurrentEvidenceId: "e1",
  publicCurrentVersion: 1,
  settlements: [],
  settlementPendingSync: false
};

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: CourtEnvelope["snapshots"];
  session: SessionState;
  ledger: typeof initialLedger;
  online: boolean;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: nowIso() }],
  timeline: [{ id: "t1", time: nowIso(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [], session: seedSession, ledger: initialLedger, online: true
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: uid(), time: nowIso(), actor, action, detail });
}

function findSession(state: State, sessionId: string): Draft<LedgerSession> | undefined {
  return state.ledger.sessions.find((entry) => entry.id === sessionId);
}

function closeOpenSegment(session: Draft<LedgerSession>, at: string) {
  const open = session.segments.find((segment) => segment.endAt === null);
  if (open) open.endAt = at;
}

/** 操作屏上屏：给会话号和修订号，写入修订日志 */
function publishDisplay(state: State, item: Evidence) {
  const ledger = state.ledger;
  const sessionId = `S-${ledger.nextSessionNo}`;
  ledger.nextSessionNo += 1;
  const rev = ledger.nextRev;
  ledger.nextRev += 1;
  const entry: LedgerRevision = { rev, sessionId, evidenceId: item.id, kind: "display", evidenceVersion: item.version, createdAt: nowIso() };
  ledger.revLog.push(entry);
  ledger.sessions.unshift({
    id: sessionId, evidenceId: item.id, exhibitNo: item.exhibitNo, title: item.title, revisions: [rev],
    segments: [], status: "未上屏", shown: false, publishedAt: entry.createdAt, lastAppliedRev: null,
    evidenceVersionAtShow: null, invalidated: false, settledSeconds: null, recomputed: false, settlementId: null
  });
  return { sessionId, rev };
}

/** 证据改动产生 edit 修订：旧会话时长标记失效 */
function publishEdit(state: State, evidence: Evidence, reason: string) {
  evidence.version += 1;
  const active = state.ledger.sessions.find((entry) => entry.evidenceId === evidence.id && entry.status !== "已结算");
  if (!active) return;
  const rev = state.ledger.nextRev;
  state.ledger.nextRev += 1;
  state.ledger.revLog.push({ rev, sessionId: active.id, evidenceId: evidence.id, kind: "edit", evidenceVersion: evidence.version, createdAt: nowIso() });
  active.revisions.push(rev);
  active.invalidated = true;
  addEntry(state, "审判庭", "证据内容改动", `${evidence.exhibitNo} ${reason}，修订号 r${rev}，会话 ${active.id} 改动前时长失效`);
}

/**
 * 公开屏同步：只认连续修订，跳号先补上再显示。
 * 连续切换里没上过屏的会话合并跳过；上过屏的时段照记；edit 修订按号补记并重开计时段。
 */
function syncPublic(state: State) {
  if (!state.online) return;
  const ledger = state.ledger;
  const pending = ledger.revLog.filter((entry) => entry.rev > ledger.publicAppliedRev);
  if (!pending.length) return;

  // 连续切换合并：一批补号中，连续 display 修订里只有最后一个“上屏”，更早的未上屏会话跳过
  const keptDisplayRevs = new Set<number>();
  for (let i = 0; i < pending.length; i += 1) {
    const entry = pending[i];
    if (entry.kind !== "display") continue;
    let j = i + 1;
    while (j < pending.length && pending[j].kind !== "display") j += 1;
    if (j === pending.length) keptDisplayRevs.add(entry.rev); // 最新一条上屏
    i = j - 1;
  }

  let currentSessionId = ledger.publicCurrentSessionId;
  for (const revEntry of pending) {
    const at = nowIso();
    const session = findSession(state, revEntry.sessionId);
    if (revEntry.kind === "display") {
      // 先把公开屏正在显示的旧会话截至本修订号（上过屏的时长照记）
      if (currentSessionId && currentSessionId !== revEntry.sessionId) {
        const previous = findSession(state, currentSessionId);
        if (previous && previous.shown) {
          closeOpenSegment(previous, at);
          if (previous.status !== "已结算") previous.status = "待结算";
        }
      }
      if (keptDisplayRevs.has(revEntry.rev)) {
        if (session) {
          session.shown = true;
          session.status = "上屏中";
          session.lastAppliedRev = revEntry.rev;
          session.evidenceVersionAtShow = revEntry.evidenceVersion;
          session.segments.push({ startRev: revEntry.rev, endRev: null, evidenceVersion: revEntry.evidenceVersion, startAt: at, endAt: null });
        }
        currentSessionId = revEntry.sessionId;
        ledger.publicCurrentSessionId = revEntry.sessionId;
        ledger.publicCurrentEvidenceId = revEntry.evidenceId;
        ledger.publicCurrentVersion = revEntry.evidenceVersion;
      } else if (session) {
        // 连续切换合并：该会话没上过公开屏，先补号再跳过，时长留空
        session.status = "跳过";
        session.lastAppliedRev = revEntry.rev;
        if (currentSessionId === session.id) {
          // 被跳过的会话不占公开屏，等本批最新一条上屏
          currentSessionId = null;
          ledger.publicCurrentSessionId = null;
          ledger.publicCurrentEvidenceId = null;
        }
      }
    } else if (session && session.shown) {
      // edit 修订按号补记：改动前时段封口，按新版本重开时段
      closeOpenSegment(session, at);
      session.lastAppliedRev = revEntry.rev;
      if (ledger.publicCurrentSessionId === session.id) {
        session.segments.push({ startRev: revEntry.rev, endRev: null, evidenceVersion: revEntry.evidenceVersion, startAt: at, endAt: null });
        ledger.publicCurrentVersion = revEntry.evidenceVersion;
      }
    }
    ledger.publicAppliedRev = revEntry.rev;
    ledger.publicConfirmedAt = at;
  }
}

function segmentSeconds(segment: LedgerSegment, at: string) {
  const end = segment.endAt ? new Date(segment.endAt).getTime() : new Date(at).getTime();
  return Math.max(0, Math.round((end - new Date(segment.startAt).getTime()) / 1000));
}

/** 结束：按公开屏确认时间结算，写入庭审记录；已结算会话不重复结算；未上屏的先留着 */
function settle(state: State, at: string) {
  const ledger = state.ledger;
  const targets = ledger.sessions.filter((entry) => entry.shown && entry.settlementId === null);
  if (!targets.length) return;
  // 公开屏正在显示的会话按确认时间封口
  const openSession = targets.find((entry) => entry.id === ledger.publicCurrentSessionId);
  if (openSession) closeOpenSegment(openSession, at);

  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const entries: SettlementEntry[] = [];
  let totalSeconds = 0;
  for (const session of targets) {
    let seconds = 0;
    let recomputed = false;
    let note: string;
    if (session.invalidated) {
      // 证据改动后：只按公开屏确认的最新版本时段重算
      const latestVersion = evidenceById.get(session.evidenceId ?? "")?.version ?? session.evidenceVersionAtShow ?? 1;
      seconds = session.segments.filter((segment) => segment.evidenceVersion >= latestVersion).reduce((sum, segment) => sum + segmentSeconds(segment, at), 0);
      recomputed = true;
      note = "证据改动后按公开屏最新版本时段重算，改动前时长失效";
    } else {
      const evidence = evidenceById.get(session.evidenceId ?? "");
      const shownVersionMismatch = evidence && session.evidenceVersionAtShow !== null && evidence.version > session.evidenceVersionAtShow;
      if (shownVersionMismatch && evidence) {
        // 证据版本已变（历史版本）：用最新证据时长重算
        seconds = evidence.duration * 60;
        recomputed = true;
        note = `证据已修订至 v${evidence.version}，按当前计划时长 ${evidence.duration} 分钟重算`;
      } else {
        seconds = session.segments.reduce((sum, segment) => sum + segmentSeconds(segment, at), 0);
        note = "按公开屏确认时间结算";
      }
    }
    session.status = "已结算";
    session.settledSeconds = seconds;
    session.recomputed = recomputed;
    totalSeconds += seconds;
    entries.push({ sessionId: session.id, exhibitNo: session.exhibitNo, title: session.title, seconds, flag: recomputed ? "重算" : "正常", note });
  }

  const settlement: Settlement = { id: uid(), time: at, online: state.online, sessionIds: targets.map((entry) => entry.id), entries, totalSeconds: totalSeconds };
  ledger.settlements.unshift(settlement);
  for (const session of targets) session.settlementId = settlement.id;

  addEntry(state, "书记员", "庭审展示时长结算", `共 ${entries.length} 场展示会话，合计 ${formatMinutes(totalSeconds)}（${settlement.id.slice(0, 8)}）${state.online ? "" : "，离线结算待联网补记"}`);
  for (const entry of entries) {
    addEntry(state, "书记员", "写入庭审记录", `会话 ${entry.sessionId}｜${entry.exhibitNo} ${entry.title}：${formatMinutes(entry.seconds)}${entry.flag === "重算" ? "（重算）" : ""}`);
  }
  ledger.settlementPendingSync = !state.online;
  if (state.online) ledger.publicCurrentSessionId = null;
}

function formatMinutes(seconds: number) {
  if (!seconds) return "0 分钟";
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return `${minutes} 分钟`;
}

/** 旧记录缺会话号：升级补成单条会话并入账 */
function migrateLegacy(rawEvidence: Array<Omit<Evidence, "version"> & { version?: number }>): { ledger: LedgerState; timelineEntry: TimelineEntry } {
  const evidence = rawEvidence.map((item) => ({ ...item, version: item.version ?? 1 }));
  const upgraded = evidence;
  const shown = upgraded.filter((item) => item.status === "展示中" || item.status === "已展示");
  const at = nowIso();
  const sessions: LedgerSession[] = [];
  const revLog: LedgerRevision[] = [];
  let rev = 1;
  const entries: SettlementEntry[] = shown.map((item) => {
    const sessionId = `S-OLD-${item.id}`;
    revLog.push({ rev, sessionId, evidenceId: item.id, kind: "display", evidenceVersion: item.version, createdAt: at });
    sessions.push({
      id: sessionId, evidenceId: item.id, exhibitNo: item.exhibitNo, title: item.title, revisions: [rev],
      segments: [{ startRev: rev, endRev: rev, evidenceVersion: item.version, startAt: at, endAt: at }],
      status: "已结算", shown: true, publishedAt: at, lastAppliedRev: rev, evidenceVersionAtShow: item.version,
      invalidated: false, settledSeconds: item.duration * 60, recomputed: false, settlementId: "SET-MIGRATED"
    });
    rev += 1;
    return { sessionId, exhibitNo: item.exhibitNo, title: item.title, seconds: item.duration * 60, flag: "正常" as const, note: "旧记录补会话号升级，按计划时长合并为单条" };
  });
  const settlement: Settlement = {
    id: "SET-MIGRATED", time: at, online: true,
    sessionIds: entries.map((entry) => entry.sessionId), entries,
    totalSeconds: entries.reduce((sum, entry) => sum + entry.seconds, 0), migrated: true
  };
  const current = upgraded.find((item) => item.status === "展示中") ?? null;
  const ledger: LedgerState = {
    nextRev: rev, nextSessionNo: 1, revLog, sessions: sessions.reverse(),
    publicAppliedRev: Math.max(0, rev - 1), publicConfirmedAt: at,
    publicCurrentSessionId: entries.length ? `S-OLD-${current?.id ?? ""}` : null,
    publicCurrentEvidenceId: current?.id ?? null,
    publicCurrentVersion: current?.version ?? 1,
    settlements: entries.length ? [settlement] : [], settlementPendingSync: false
  };
  return {
    ledger,
    timelineEntry: { id: uid(), time: at, actor: "书记员", action: "旧记录升级", detail: `历史记录缺会话号，已补号并合并为 ${entries.length || 0} 条单条展示会话入账` }
  };
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, _action: PayloadAction<Evidence[]>) { if (!state.initialized) state.initialized = true; },
    hydrate(state, action: PayloadAction<CourtEnvelope | LegacyEnvelope | null>) {
      if (state.initialized || !action.payload) return;
      state.initialized = true;
      if ("legacy" in action.payload) {
        const migrated = migrateLegacy(action.payload.evidence);
        state.evidence = action.payload.evidence.map((item) => ({ ...item, version: item.version ?? 1 }));
        state.ledger = migrated.ledger;
        state.timeline.unshift(migrated.timelineEntry);
        return;
      }
      const envelope = action.payload;
      state.evidence = envelope.evidence;
      state.objections = envelope.objections;
      state.timeline = envelope.timeline;
      state.snapshots = envelope.snapshots;
      state.session = envelope.session;
      state.ledger = envelope.ledger;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      const wasOffline = !state.online;
      state.online = action.payload;
      if (action.payload) {
        // 断网恢复：公开屏按会话号/修订号补记，同一会话不重复结算
        syncPublic(state);
        if (wasOffline && state.ledger.settlementPendingSync) {
          state.ledger.settlementPendingSync = false;
          const ids = state.ledger.settlements[0]?.sessionIds.join("、") ?? "";
          addEntry(state, "书记员", "离线结算补记", `联网恢复，已按会话号补记结算（${ids || "无"}），同一会话不重复结算`);
        }
      }
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) { state.evidence = action.payload; addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序"); },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.session.currentEvidenceId = item.id; // 操作屏切走：不影响公开屏
      state.session.timerSeconds = item.duration * 60;
      const { sessionId, rev } = publishDisplay(state, item);
      addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}，会话 ${sessionId} 修订号 r${rev}`);
      // 公开屏不立即跟切：只记修订号，等公开屏按连续修订确认（每秒 tick / 联网恢复 / 结算前）
    },
    showEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      item.status = "展示中";
      state.session.phase = "质证";
      // 若无该证据的未结算会话（如初始操作），补一次上屏
      const hasLive = state.ledger.sessions.some((session) => session.evidenceId === item.id && session.status !== "已结算");
      if (!hasLive) {
        const { sessionId, rev } = publishDisplay(state, item);
        addEntry(state, item.presenter, "开始展示", `${item.title}，会话 ${sessionId} 修订号 r${rev}`);
      }
    },
    completeEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      item.status = "已展示";
      const next = state.evidence.find((entry) => entry.status === "待展示");
      state.session.currentEvidenceId = next?.id ?? null;
      state.session.timerSeconds = (next?.duration ?? 0) * 60;
      state.session.phase = next ? "举证" : "休庭";
      addEntry(state, "审判庭", "完成质证", item.title);
      if (next) {
        const { sessionId, rev } = publishDisplay(state, next);
        addEntry(state, next.presenter, "切换展示证据", `${next.exhibitNo} ${next.title}，会话 ${sessionId} 修订号 r${rev}`);
      }
    },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.sensitive = !item.sensitive;
      publishEdit(state, item, item.sensitive ? "公开屏内容遮罩" : "恢复公开内容");
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      state.objections.unshift({ ...action.payload, id: uid(), status: "待裁定", createdAt: nowIso() });
      state.session.phase = "质证";
      addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) {
        item.status = "已跳过";
        addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`);
      } else {
        addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证");
      }
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: uid(), label: action.payload, time: nowIso(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
    },
    restore(state, action: PayloadAction<string>) {
      const saved = state.snapshots.find((entry) => entry.id === action.payload);
      if (!saved) return;
      state.evidence = structuredClone(saved.evidence);
      state.session.phase = saved.phase;
      state.session.currentEvidenceId = saved.currentEvidenceId;
      addEntry(state, "审判庭", "恢复庭审快照", saved.label);
      const item = state.evidence.find((entry) => entry.id === saved.currentEvidenceId);
      if (item) {
        const { sessionId, rev } = publishDisplay(state, item);
        addEntry(state, item.presenter, "快照恢复后重新上屏", `${item.exhibitNo}，会话 ${sessionId} 修订号 r${rev}`);
      }
    },
    tick(state) {
      if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1;
      // 公开屏每秒尝试确认新修订（在线时）
      syncPublic(state);
    },
    settleDisplay(state) {
      settle(state, nowIso());
      state.session.phase = "结束";
    },
    setPhase(state, action: PayloadAction<SessionPhase>) {
      state.session.phase = action.payload;
      addEntry(state, "审判庭", "切换庭审阶段", action.payload);
      if (action.payload === "结束") settle(state, nowIso());
    }
  }
});

export const { initialize, hydrate, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence, toggleSensitive, addObjection, resolveObjection, snapshot, restore, tick, settleDisplay, setPhase } = slice.actions;
export { formatMinutes, segmentSeconds };
export default slice.reducer;

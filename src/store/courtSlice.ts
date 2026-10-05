import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Evidence, Objection, PersistedState, SessionPhase, SessionState, TimelineEntry } from "../types";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
  // 展示会话台账
  displaySessions: import("../types").DisplaySession[];
  publicScreen: import("../types").PublicScreenState;
  settlements: import("../types").SettlementRecord[];
  revisionCounter: number;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  session: seedSession,
  online: true,
  displaySessions: [],
  publicScreen: { confirmedRevision: 0, currentSessionId: null, lastConfirmedAt: null },
  settlements: [],
  revisionCounter: 0
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

function nowISO() { return new Date().toISOString(); }

function secondsBetween(from: string | null, to: string): number {
  if (!from) return 0;
  const diff = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return Math.max(0, Math.round(diff));
}

function findEvidence(state: State, id: string | null | undefined) {
  return state.evidence.find((entry) => entry.id === id);
}

// 公开屏只认连续修订：把 confirmedRevision 之后、targetRevision 之前的待处理会话补齐。
// 中间被操作端切走、公开屏没上过屏的会话合并跳过（保留但不计时长），
// targetRevision 对应的会话确认上屏；上一任已上屏会话在此时结束并结算时长。
function resolvePublicScreen(state: State, targetRevision: number) {
  const now = nowISO();
  const pending = state.displaySessions
    .filter((s) => s.status === "待上屏" && s.revision > state.publicScreen.confirmedRevision)
    .sort((a, b) => a.revision - b.revision);
  for (const s of pending) {
    if (s.revision > targetRevision) break;
    if (s.revision === targetRevision) {
      if (state.publicScreen.currentSessionId && state.publicScreen.currentSessionId !== s.id) {
        const prev = state.displaySessions.find((x) => x.id === state.publicScreen.currentSessionId);
        if (prev && prev.status === "已上屏" && !prev.endedAt && prev.confirmedAt) {
          prev.endedAt = now;
          prev.durationSeconds = secondsBetween(prev.confirmedAt, now);
        }
      }
      s.status = "已上屏";
      s.confirmedAt = now;
      state.publicScreen.currentSessionId = s.id;
      state.publicScreen.lastConfirmedAt = now;
    } else {
      // 连续切换中被跳过、没上过屏的会话：保留但不计时长
      s.status = "已跳过";
    }
  }
  if (targetRevision > state.publicScreen.confirmedRevision) {
    state.publicScreen.confirmedRevision = targetRevision;
  }
}

// 证据一改动，旧会话时长失效：清空时长、撤回已结算记录，状态回退为已上屏，待下次结算重算。
function invalidateEvidence(state: State, evidenceId: string) {
  for (const s of state.displaySessions) {
    if (s.evidenceId !== evidenceId || s.status === "已跳过") continue;
    s.invalidated = true;
    s.durationSeconds = null;
    s.settled = false;
    s.status = "已上屏";
    if (s.recordId) {
      state.settlements = state.settlements.filter((r) => r.id !== s.recordId);
      s.recordId = null;
    }
  }
}

// 结算：按公开屏确认时间把已上屏会话写入庭审记录。
// endCurrent=true（庭审结束）时先结束当前在屏会话；false（断网补记）只补已结束的会话。
// 同一会话不重复结算（按 sessionId 幂等）。
function settleSessions(state: State, endCurrent: boolean) {
  const now = nowISO();
  if (endCurrent && state.publicScreen.currentSessionId) {
    const cur = state.displaySessions.find((s) => s.id === state.publicScreen.currentSessionId);
    if (cur && cur.status === "已上屏" && !cur.endedAt && cur.confirmedAt) {
      cur.endedAt = now;
      cur.durationSeconds = secondsBetween(cur.confirmedAt, now);
    }
  }
  for (const s of state.displaySessions) {
    if (s.status !== "已上屏" || s.settled) continue;
    if (!endCurrent && !s.endedAt) continue; // 仍在屏、时长未定，留着
    // 幂等：同一会话已有记录则不再写
    const existing = state.settlements.find((r) => r.sessionId === s.id);
    if (existing) { s.settled = true; s.status = "已结算"; s.recordId = existing.id; continue; }
    if (s.durationSeconds == null || s.invalidated) {
      s.durationSeconds = s.endedAt && s.confirmedAt ? secondsBetween(s.confirmedAt, s.endedAt) : 0;
    }
    const ev = findEvidence(state, s.evidenceId);
    const record = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      evidenceId: s.evidenceId,
      exhibitNo: ev?.exhibitNo ?? "",
      title: ev?.title ?? "(证据已移除)",
      durationSeconds: s.durationSeconds ?? 0,
      settledAt: now,
      source: "会话结算" as const,
      note: s.invalidated ? "证据改动后重新结算" : ""
    };
    state.settlements.unshift(record);
    s.settled = true;
    s.status = "已结算";
    s.recordId = record.id;
  }
}

// 旧记录缺会话号：升级时把历史已展示证据合并补成单条。
function migrateLegacy(state: State) {
  if (state.settlements.some((r) => r.source === "历史合并")) return;
  const legacy = state.evidence.filter((e) => e.status === "已展示" && !state.displaySessions.some((s) => s.evidenceId === e.id));
  if (!legacy.length) return;
  state.settlements.unshift({
    id: crypto.randomUUID(),
    sessionId: null,
    evidenceId: null,
    exhibitNo: legacy.map((e) => e.exhibitNo).join("、"),
    title: `历史展示证据合并（${legacy.length}条，无会话号）`,
    durationSeconds: legacy.reduce((sum, e) => sum + e.duration * 60, 0),
    settledAt: nowISO(),
    source: "历史合并",
    note: "旧记录缺会话号，升级补成单条"
  });
  addEntry(state, "书记员", "升级旧记录", `历史展示记录 ${legacy.length} 条合并为单条（无会话号）`);
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<Partial<PersistedState> | undefined>) {
      if (state.initialized) return;
      const p = action.payload ?? {};
      state.evidence = p.evidence?.length ? p.evidence : state.evidence;
      state.objections = p.objections?.length ? p.objections : state.objections;
      state.timeline = p.timeline?.length ? p.timeline : state.timeline;
      state.snapshots = p.snapshots ?? state.snapshots;
      state.session = p.session ?? state.session;
      state.online = p.online ?? state.online;
      state.displaySessions = p.displaySessions ?? state.displaySessions;
      state.publicScreen = p.publicScreen ?? state.publicScreen;
      state.settlements = p.settlements ?? state.settlements;
      state.revisionCounter = p.revisionCounter ?? state.revisionCounter;
      migrateLegacy(state);
      state.initialized = true;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
      if (action.payload) {
        // 断网恢复：按会话号补记，同一会话不重复结算
        const before = state.settlements.length;
        settleSessions(state, false);
        addEntry(state, "书记员", "网络恢复", `补记庭审记录 ${state.settlements.length - before} 条（按会话号，不重复结算）`);
      }
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) { state.evidence = action.payload; addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序"); },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = findEvidence(state, action.payload);
      if (!item) return;
      state.session.currentEvidenceId = item.id;
      state.session.timerSeconds = item.duration * 60;
      addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`);
    },
    showEvidence(state) {
      const item = findEvidence(state, state.session.currentEvidenceId);
      if (!item) return;
      item.status = "展示中";
      state.session.phase = "质证";
      const revision = ++state.revisionCounter;
      state.displaySessions.push({
        id: crypto.randomUUID(),
        evidenceId: item.id,
        revision,
        status: "待上屏",
        createdAt: nowISO(),
        confirmedAt: null,
        endedAt: null,
        durationSeconds: null,
        invalidated: false,
        settled: false,
        recordId: null
      });
      addEntry(state, item.presenter, "开始展示", `${item.exhibitNo} ${item.title}（修订 ${revision}，待公开屏确认）`);
    },
    completeEvidence(state) {
      const item = findEvidence(state, state.session.currentEvidenceId);
      if (!item) return;
      item.status = "已展示";
      const next = state.evidence.find((entry) => entry.status === "待展示");
      state.session.currentEvidenceId = next?.id ?? null;
      state.session.timerSeconds = (next?.duration ?? 0) * 60;
      state.session.phase = next ? "举证" : "休庭";
      addEntry(state, "审判庭", "完成质证", item.title);
    },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = findEvidence(state, action.payload);
      if (!item) return;
      item.sensitive = !item.sensitive;
      // 证据改动：旧会话时长失效，待下次结算重算
      invalidateEvidence(state, item.id);
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", `${item.title}（证据改动，旧会话时长失效重算）`);
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = findEvidence(state, action.payload.evidenceId);
      state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: nowISO() });
      state.session.phase = "质证";
      addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      const item = findEvidence(state, objection.evidenceId);
      if (action.payload.status === "支持" && item) { item.status = "已跳过"; addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`); }
      else { addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证"); }
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: nowISO(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
    },
    restore(state, action: PayloadAction<string>) {
      const snapshot = state.snapshots.find((entry) => entry.id === action.payload);
      if (!snapshot) return;
      state.evidence = structuredClone(snapshot.evidence);
      state.session.phase = snapshot.phase;
      state.session.currentEvidenceId = snapshot.currentEvidenceId;
      addEntry(state, "审判庭", "恢复庭审快照", snapshot.label);
    },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) {
      state.session.phase = action.payload;
      addEntry(state, "审判庭", "切换庭审阶段", action.payload);
      if (action.payload === "结束") {
        // 结束：按公开屏确认时间结算并写入庭审记录
        settleSessions(state, true);
        addEntry(state, "书记员", "庭审结束", "按公开屏确认时间结算并写入庭审记录");
      }
    },
    // 公开屏同步到最新修订：跳号先补上（合并跳过中间未上屏会话）再显示最新
    publicSync(state) {
      const latest = state.displaySessions.reduce((max, s) => Math.max(max, s.revision, state.publicScreen.confirmedRevision), state.publicScreen.confirmedRevision);
      if (latest > state.publicScreen.confirmedRevision) {
        resolvePublicScreen(state, latest);
        addEntry(state, "审判庭", "公开屏同步", `补号至修订 ${latest}，连续切换已合并跳过`);
      }
    },
    // 公开屏确认下一修订：只认连续修订，跳号先补上再显示
    publicConfirmNext(state) {
      const next = state.displaySessions
        .filter((s) => s.status === "待上屏" && s.revision > state.publicScreen.confirmedRevision)
        .sort((a, b) => a.revision - b.revision)[0];
      if (!next) return;
      resolvePublicScreen(state, next.revision);
      addEntry(state, "审判庭", "公开屏确认", `修订 ${next.revision} 已上屏`);
    },
    // 手动补记结算：只结算已结束（切走）但尚未写入记录的会话，不结束当前在屏会话。
    // 幂等，同一会话不重复结算。
    settleNow(state) {
      settleSessions(state, false);
      addEntry(state, "书记员", "补记庭审记录", "按公开屏确认时间补记已结束会话（同一会话不重复结算）");
    }
  }
});

export const {
  initialize, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence,
  toggleSensitive, addObjection, resolveObjection, snapshot, restore, tick, setPhase,
  publicSync, publicConfirmNext, settleNow
} = slice.actions;
export default slice.reducer;

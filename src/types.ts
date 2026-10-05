export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
  /** 内容版本号：证据每改动一次 +1，用于判定旧会话时长是否失效 */
  version: number;
}

export interface Objection {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回";
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员";
  action: string;
  detail: string;
}

/** 上屏修订：操作屏每次“上屏/改动”产生一条，修订号全局连续 */
export interface LedgerRevision {
  rev: number;
  sessionId: string;
  evidenceId: string;
  kind: "display" | "edit";
  evidenceVersion: number;
  createdAt: string;
}

/** 公开屏确认的连续展示时段：修订号边界内计时 */
export interface LedgerSegment {
  startRev: number;
  endRev: number | null;
  evidenceVersion: number;
  startAt: string;
  endAt: string | null;
}

export type LedgerSessionStatus = "未上屏" | "上屏中" | "待结算" | "跳过" | "已结算";

/** 展示会话：一次上屏一条，按会话号记账 */
export interface LedgerSession {
  id: string;
  evidenceId: string | null;
  exhibitNo: string;
  title: string;
  /** 该会话产生过的修订号（上屏 + 证据改动） */
  revisions: number[];
  /** 公开屏已确认的展示时段，可能多段（切走后又切回） */
  segments: LedgerSegment[];
  status: LedgerSessionStatus;
  /** 是否上过公开屏 */
  shown: boolean;
  publishedAt: string | null;
  lastAppliedRev: number | null;
  evidenceVersionAtShow: number | null;
  /** 展示期间证据被改动，改动前时长失效 */
  invalidated: boolean;
  /** 结算结果 */
  settledSeconds: number | null;
  recomputed: boolean;
  settlementId: string | null;
}

export interface SettlementEntry {
  sessionId: string;
  exhibitNo: string;
  title: string;
  seconds: number;
  flag: "正常" | "重算";
  note: string;
}

export interface Settlement {
  id: string;
  time: string;
  online: boolean;
  sessionIds: string[];
  entries: SettlementEntry[];
  totalSeconds: number;
  migrated?: boolean;
}

export interface LedgerState {
  nextRev: number;
  nextSessionNo: number;
  revLog: LedgerRevision[];
  sessions: LedgerSession[];
  /** 公开屏已确认到的连续修订号 */
  publicAppliedRev: number;
  publicConfirmedAt: string | null;
  publicCurrentSessionId: string | null;
  publicCurrentEvidenceId: string | null;
  publicCurrentVersion: number;
  settlements: Settlement[];
  /** 离线结束后已结算，等待联网按会话号补记 */
  settlementPendingSync: boolean;
}

export interface CourtSnapshot {
  id: string;
  label: string;
  time: string;
  evidence: Evidence[];
  phase: SessionPhase;
  currentEvidenceId: string | null;
}

export interface SessionState {
  phase: SessionPhase;
  /** 操作屏当前选中（与公开屏解耦） */
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

/** v2 本地持久化结构 */
export interface CourtEnvelope {
  version: 2;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: CourtSnapshot[];
  session: SessionState;
  ledger: LedgerState;
}

/** 旧版本记录：证据没有版本号、没有会话台账 */
export type LegacyEvidence = Omit<Evidence, "version"> & { version?: number };
export interface LegacyEnvelope {
  legacy: true;
  evidence: LegacyEvidence[];
}

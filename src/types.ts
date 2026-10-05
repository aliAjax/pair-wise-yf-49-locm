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

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

// 展示会话：一次上屏（公开屏确认）的记账单元。
// 每次上屏给一个会话号和一个连续修订号；公开屏只认连续修订，
// 跳号先补上（合并跳过）再显示。
export type DisplaySessionStatus = "待上屏" | "已上屏" | "已跳过" | "已结算";
export interface DisplaySession {
  id: string;                 // 会话号
  evidenceId: string;
  revision: number;           // 修订号（全局连续递增）
  status: DisplaySessionStatus;
  createdAt: string;          // 操作端发起上屏时间
  confirmedAt: string | null;  // 公开屏确认上屏时间
  endedAt: string | null;     // 公开屏确认结束（切走）时间
  durationSeconds: number | null; // 按公开屏确认时间结算的时长
  invalidated: boolean;       // 证据改动后旧会话时长失效
  settled: boolean;           // 是否已结算写入庭审记录
  recordId: string | null;     // 写入的庭审记录 id
}

// 公开屏状态：只认连续修订，跳号先补上再显示。
export interface PublicScreenState {
  confirmedRevision: number;       // 已处理（确认或跳过）的最高修订号
  currentSessionId: string | null; // 公开屏当前展示的会话
  lastConfirmedAt: string | null;
}

// 庭审记录（结算记录）：按公开屏确认时间结算后写入。
export type SettlementSource = "会话结算" | "历史合并";
export interface SettlementRecord {
  id: string;                 // 记录号
  sessionId: string | null;   // 会话号（旧记录缺省为 null）
  evidenceId: string | null;
  exhibitNo: string;
  title: string;
  durationSeconds: number;
  settledAt: string;          // 结算时间
  source: SettlementSource;
  note: string;
}

// 持久化到本地的完整庭审状态。
export interface PersistedState {
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  displaySessions: DisplaySession[];
  publicScreen: PublicScreenState;
  settlements: SettlementRecord[];
  revisionCounter: number;
  online: boolean;
}

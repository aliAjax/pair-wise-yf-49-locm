import { useEffect, useMemo, useState } from "react";
import { Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useGetCourtQuery, useSaveCourtMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addObjection, completeEvidence, formatMinutes, hydrate, reorder, resolveObjection, restore, selectEvidence, segmentSeconds, setMode, setOnline, setPhase, settleDisplay, showEvidence, snapshot, tick, toggleSensitive } from "./store/courtSlice";
import type { CourtEnvelope, LedgerSession, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatClock(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

const sessionTagColor: Record<LedgerSession["status"], string> = { "未上屏": "gray", 上屏中: "orange", 待结算: "gold", 跳过: "purple", 已结算: "green" };

function sessionLiveSeconds(session: LedgerSession | undefined): number {
  if (!session) return 0;
  const now = new Date().toISOString();
  return session.segments.reduce((sum, segment) => sum + segmentSeconds(segment, now), 0);
}

function LedgerCard() {
  const ledger = useAppSelector((root) => root.court.ledger);
  const online = useAppSelector((root) => root.court.online);
  const sessionById = new Map(ledger.sessions.map((session) => [session.id, session]));
  const pendingDisplay = ledger.revLog.filter((entry) => entry.rev > ledger.publicAppliedRev).length;
  return <Card className="ledger-card"
    title="展示会话台账"
    extra={<Space size={4}>
      <Tag color={online ? "green" : "red"}>公开屏已确认 r{ledger.publicAppliedRev}</Tag>
      <Tag color={pendingDisplay ? "orange" : "gray"}>待上屏 {pendingDisplay}</Tag>
      {ledger.settlementPendingSync && <Tag color="orangered">结算待补记</Tag>}
    </Space>}>
    <div className="ledger-list">
      {ledger.sessions.map((session) => {
        const open = session.id === ledger.publicCurrentSessionId;
        return <div className={`ledger-row${open ? " on-public" : ""}`} key={session.id}>
          <div className="ledger-head">
            <b>{session.id}</b>
            <span>{session.exhibitNo} {session.title}</span>
            <Tag color={sessionTagColor[session.status]}>{session.status}</Tag>
            {session.invalidated && <Tag color="red">时长已失效</Tag>}
            {open && <Tag color="arcoblue">公开屏中</Tag>}
          </div>
          <small>
            修订 {session.revisions.map((rev) => `r${rev}`).join("、") || "—"} ·
            公开屏确认 {session.shown ? `r${session.lastAppliedRev ?? "—"}` : "未确认"} ·
            时长 {session.status === "已结算" && session.settledSeconds !== null
              ? `${formatMinutes(session.settledSeconds)}${session.recomputed ? "（重算）" : ""}`
              : session.shown ? `${formatClock(sessionLiveSeconds(session))}（确认中）` : "未上屏，时长留空"}
          </small>
        </div>;
      })}
    </div>
    {ledger.settlements.length > 0 && <div className="settle-list">
      {ledger.settlements.slice(0, 3).map((settlement) => <div className="settle-row" key={settlement.id}>
        <b>{settlement.migrated ? "旧记录升级" : `结算 ${settlement.id.slice(0, 8)}`}</b>
        <span>{new Date(settlement.time).toLocaleString("zh-CN")} · {settlement.sessionIds.length} 场 · 合计 {formatMinutes(settlement.totalSeconds)}</span>
        <Tag size="small" color={settlement.online ? "green" : "orange"}>{settlement.online ? "已写入记录" : "离线待补记"}</Tag>
      </div>)}
    </div>}
    <p className="ledger-hint">公开屏只认连续修订：断网期间跳号先补再显示；连续切换未上屏的会话合并跳过；上过屏的按确认时间照记。</p>
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const [, forceRender] = useState(0);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  // 公开屏只显示台账里已连续确认到的内容，操作屏切走不影响它
  const publicItem = state.evidence.find((item) => item.id === state.ledger.publicCurrentEvidenceId);
  const publicSession = state.ledger.sessions.find((item) => item.id === state.ledger.publicCurrentSessionId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const unsettledShown = state.ledger.sessions.filter((item) => item.shown && item.settlementId === null).length;
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => forceRender((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };
  const doSettle = () => { dispatch(settleDisplay()); Message.success("已按公开屏确认时间结算并写入庭审记录"); };

  return <div className="court-grid">
    <Card className="operator" title="证据操作台" extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
      <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟 · v{item.version}</small></div><Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag><Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>上屏</Button>
      </article>)}</div>
      <div className="control-strip"><Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button><Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button><Button onClick={() => dispatch(toggleSensitive(current?.id ?? ""))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button><Button status="danger" onClick={doSettle} disabled={!unsettledShown}>结束并结算（{unsettledShown}）</Button></div>
      <LedgerCard />
    </Card>
    <div className="side-stack">
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{ value: "控制", label: "控制者视图" }, { value: "预览", label: "公开屏" }] } />} className="preview-card">
        <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{publicItem?.exhibitNo ?? "等待上屏"}</h2><h3>{publicItem?.title ?? "庭审进行中"}</h3>{publicItem?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{publicItem?.note}</p>}<footer>
          {publicSession ? <>会话 {publicSession.id} · r{state.ledger.publicAppliedRev} · 已展示 {formatClock(sessionLiveSeconds(publicSession))}</> : "公开屏空闲"}
          {publicSession?.invalidated && <Tag size="small" color="red" style={{ marginLeft: 8 }}>改动后重算</Tag>}
          <br />{state.session.phase} · {state.online ? `确认时间 ${state.ledger.publicConfirmedAt ? new Date(state.ledger.publicConfirmedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}` : "离线，恢复后补号"}
        </footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag><div className="operator-hint">操作屏当前：{current ? `${current.exhibitNo} ${current.title}` : "无"}；公开屏停留在：{publicItem ? publicItem.exhibitNo : "空"}。切走证据只发修订号，公开屏按连续修订确认后才更新。</div></>}</div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
    </div>
    <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}>
      <Form layout="vertical">
        <Form.Item label="异议类型">
          <Controller name="ground" control={control} render={({ field }) => (
            <Select {...field} options={[{ value: "关联性异议", label: "关联性异议" }, { value: "真实性异议", label: "真实性异议" }, { value: "合法性异议", label: "合法性异议" }]} />
          )} />
        </Form.Item>
        <Form.Item label="异议说明">
          <Controller name="explanation" control={control} render={({ field }) => (
            <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />
          )} />
        </Form.Item>
      </Form>
    </Modal>
    <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group><p className="ledger-hint">切到“结束”会按公开屏确认时间结算，逐会话写入庭审记录；同一会话不重复结算。</p></Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><div className="side-stack"><Card title="结算记录（庭审记录）">{state.ledger.settlements.length ? state.ledger.settlements.map((settlement) => <div className="settle-record" key={settlement.id}><div className="settle-row"><b>{settlement.migrated ? "旧记录升级" : `结算 ${settlement.id.slice(0, 8)}`}</b><Tag size="small" color={settlement.online ? "green" : "orange"}>{settlement.online ? "已写入" : "离线待补记"}</Tag></div><small>{new Date(settlement.time).toLocaleString("zh-CN")} · 合计 {formatMinutes(settlement.totalSeconds)}</small>{settlement.entries.map((entry) => <p key={entry.sessionId}>{entry.sessionId}｜{entry.exhibitNo} {entry.title}：{formatMinutes(entry.seconds)} {entry.flag === "重算" && <Tag size="small" color="red">重算</Tag>}<br /><span>{entry.note}</span></p>)}</div>) : <p>尚未结算。</p>}</Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <Card title="证据目录与公开属性"><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title} <Tag size="small">v{item.version}</Tag></b><p>{item.note}</p></div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩（改动产生修订并重算时长）</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive(item.id))} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data } = useGetCourtQuery();
  const [save] = useSaveCourtMutation();
  const { t, i18n } = useTranslation();

  useEffect(() => { if (data) dispatch(hydrate(data)); }, [data, dispatch]);
  // 公开屏按自己的节奏每秒确认连续修订（全局生效，切走页面也不停）
  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const envelope: CourtEnvelope = useMemo(() => ({
    version: 2, evidence: state.evidence, objections: state.objections, timeline: state.timeline,
    snapshots: state.snapshots, session: state.session, ledger: state.ledger
  }), [state.evidence, state.objections, state.timeline, state.snapshots, state.session, state.ledger]);
  useEffect(() => {
    if (!state.initialized) return;
    const timer = window.setTimeout(() => void save(envelope), 300);
    return () => window.clearTimeout(timer);
  }, [envelope, save, state.initialized]);

  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length, settled: state.ledger.settlements.length }), [state]);
  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>本地恢复 <Switch checked={!state.online} onChange={(value) => dispatch(setOnline(!value))} /></label><Tag color={state.online ? "green" : "orange"}>{state.online ? "协作同步" : "离线操作"}</Tag></div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="结算批次" value={metrics.settled} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}

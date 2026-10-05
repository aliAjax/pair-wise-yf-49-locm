import { useDispatch, useSelector } from "react-redux";
import { Button, Card, Empty, Statistic, Tag, Timeline } from "@arco-design/web-react";
import { publicConfirmNext, publicSync } from "../store/courtSlice";
import type { RootState } from "../store";

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}分${s}秒`;
}

// 公开屏：与操作屏分离，只认连续修订，跳号先补上再显示。
export default function PublicScreen() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.court);
  const { publicScreen, displaySessions } = state;

  const currentSession = displaySessions.find((s) => s.id === publicScreen.currentSessionId) ?? null;
  const currentEvidence = currentSession ? state.evidence.find((e) => e.id === currentSession.evidenceId) ?? null : null;

  const pending = displaySessions
    .filter((s) => s.status === "待上屏" && s.revision > publicScreen.confirmedRevision)
    .sort((a, b) => a.revision - b.revision);
  const skipped = displaySessions.filter((s) => s.status === "已跳过");
  const confirmedCount = displaySessions.filter((s) => s.status === "已上屏" || s.status === "已结算").length;

  // 跳号：下一个待处理修订与已确认修订之间有空缺
  const hasGap = pending.length > 0 && pending[0].revision > publicScreen.confirmedRevision + 1;

  return (
    <div className="public-screen-page">
      <Card
        title="公开屏（独立显示）"
        extra={
          <Tag color={state.online ? "green" : "red"}>
            {state.online ? "协作在线" : "离线 · 断网恢复后补记"}
          </Tag>
        }
      >
        <div className="public-screen big">
          <small>公开展示 · 仅显示公开屏已确认内容</small>
          <h2>{currentEvidence?.exhibitNo ?? "暂无证据"}</h2>
          <h3>{currentEvidence?.title ?? "等待操作屏上屏"}</h3>
          {currentEvidence?.sensitive ? (
            <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div>
          ) : currentEvidence ? (
            <p>{currentEvidence.note}</p>
          ) : null}
          <footer>
            {currentSession ? (
              <span>会话号 {currentSession.id.slice(0, 8)} · 修订 {currentSession.revision} · 确认于 {currentSession.confirmedAt ? new Date(currentSession.confirmedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
            ) : (
              <span>公开屏尚未确认任何修订</span>
            )}
          </footer>
        </div>
      </Card>

      <div className="public-screen-stats">
        <Card><Statistic title="已确认上屏" value={confirmedCount} /></Card>
        <Card><Statistic title="待上屏修订" value={pending.length} /></Card>
        <Card><Statistic title="连续切换已跳过" value={skipped.length} /></Card>
        <Card><Statistic title="当前确认修订" value={publicScreen.confirmedRevision} /></Card>
      </div>

      <Card
        title="待公开屏确认的修订"
        extra={
          <span className="public-screen-actions">
            <Button size="small" onClick={() => dispatch(publicConfirmNext())} disabled={!pending.length}>确认下一修订</Button>
            <Button size="small" type="primary" onClick={() => dispatch(publicSync())} disabled={!pending.length}>同步到最新修订</Button>
          </span>
        }
      >
        {hasGap && (
          <div className="gap-warn">
            <Tag color="orange">跳号</Tag>
            <span>下一修订 {pending[0].revision} 与已确认修订 {publicScreen.confirmedRevision} 不连续，将先补号（合并跳过中间未上屏会话）再显示。</span>
          </div>
        )}
        {!pending.length && <Empty description="没有待确认的修订" />}
        <Timeline>
          {pending.map((s) => {
            const ev = state.evidence.find((e) => e.id === s.evidenceId);
            return (
              <Timeline.Item key={s.id} label={`修订 ${s.revision}`}>
                <b>{ev?.exhibitNo} · {ev?.title}</b>
                <Tag color="blue">待上屏</Tag>
                <p>会话号 {s.id.slice(0, 8)} · 操作端发起于 {new Date(s.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</p>
              </Timeline.Item>
            );
          })}
        </Timeline>
      </Card>

      <Card title="已跳过（连续切换中未上屏，保留不计时长）">
        {!skipped.length && <Empty description="暂无跳过会话" />}
        {skipped.map((s) => {
          const ev = state.evidence.find((e) => e.id === s.evidenceId);
          return (
            <div className="skipped-row" key={s.id}>
              <Tag>已跳过</Tag>
              <span>{ev?.exhibitNo} · {ev?.title}</span>
              <small>会话号 {s.id.slice(0, 8)} · 修订 {s.revision} · 没上过屏，时长不计</small>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

export { formatDuration };

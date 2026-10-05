import { useDispatch, useSelector } from "react-redux";
import { Button, Card, Empty, Statistic, Table, Tag } from "@arco-design/web-react";
import { settleNow } from "../store/courtSlice";
import type { RootState } from "../store";
import type { DisplaySession, SettlementRecord } from "../types";
import { formatDuration } from "./PublicScreen";

// 庭审记录：按公开屏确认时间结算后写入；断网恢复按会话号补记，同一会话不重复结算。
export default function Records() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.court);
  const { settlements, displaySessions } = state;

  const sessionColumns = [
    { title: "会话号", dataIndex: "id", render: (id: string) => <code>{id.slice(0, 8)}</code> },
    { title: "修订号", dataIndex: "revision", render: (r: number) => <Tag color="blue">修订 {r}</Tag> },
    {
      title: "证据",
      render: (_: unknown, s: DisplaySession) => {
        const ev = state.evidence.find((e) => e.id === s.evidenceId);
        return <span>{ev?.exhibitNo} · {ev?.title}</span>;
      }
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (st: DisplaySession["status"]) => {
        const color = st === "已结算" ? "green" : st === "已上屏" ? "orange" : st === "已跳过" ? "gray" : "blue";
        return <Tag color={color}>{st}</Tag>;
      }
    },
    { title: "上屏确认", dataIndex: "confirmedAt", render: (t: string | null) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "—") },
    { title: "切走确认", dataIndex: "endedAt", render: (t: string | null) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "—") },
    { title: "时长", dataIndex: "durationSeconds", render: (d: number | null) => formatDuration(d) },
    {
      title: "失效",
      dataIndex: "invalidated",
      render: (v: boolean) => (v ? <Tag color="red">已失效·重算</Tag> : <Tag>正常</Tag>)
    }
  ];

  const recordColumns = [
    { title: "记录号", dataIndex: "id", render: (id: string) => <code>{id.slice(0, 8)}</code> },
    { title: "会话号", dataIndex: "sessionId", render: (sid: string | null) => (sid ? <code>{sid.slice(0, 8)}</code> : <Tag color="gold">无·历史合并</Tag>) },
    { title: "证据", render: (_: unknown, r: SettlementRecord) => <span>{r.exhibitNo} · {r.title}</span> },
    { title: "时长", dataIndex: "durationSeconds", render: (d: number) => formatDuration(d) },
    { title: "来源", dataIndex: "source", render: (s: SettlementRecord["source"]) => <Tag color={s === "会话结算" ? "blue" : "gold"}>{s}</Tag> },
    { title: "结算时间", dataIndex: "settledAt", render: (t: string) => new Date(t).toLocaleString("zh-CN", { hour12: false }) },
    { title: "备注", dataIndex: "note", render: (n: string) => n || "—" }
  ];

  const settledCount = settlements.filter((r) => r.source === "会话结算").length;
  const legacyCount = settlements.filter((r) => r.source === "历史合并").length;
  const pendingCount = displaySessions.filter((s) => s.status === "已上屏" && !s.settled && s.endedAt).length;

  return (
    <div className="records-page">
      <div className="records-stats">
        <Card><Statistic title="已结算会话" value={settledCount} /></Card>
        <Card><Statistic title="历史合并记录" value={legacyCount} /></Card>
        <Card><Statistic title="待补记会话" value={pendingCount} /></Card>
        <Card>
          <Button type="primary" onClick={() => dispatch(settleNow())}>
            补记已结束会话
          </Button>
          <small className="records-hint">按公开屏确认时间补记已结束会话；庭审阶段为「结束」时自动总结算，断网恢复后自动补记</small>
        </Card>
      </div>

      <Card title="庭审记录（结算台账）" extra={<Tag color="green">{settlements.length} 条</Tag>}>
        {!settlements.length ? <Empty description="暂无结算记录" /> : (
          <Table rowKey="id" columns={recordColumns} data={settlements} pagination={false} size="small" />
        )}
      </Card>

      <Card title="展示会话台账（按会话号记账）" extra={<Tag>{displaySessions.length} 条</Tag>}>
        {!displaySessions.length ? <Empty description="暂无展示会话" /> : (
          <Table rowKey="id" columns={sessionColumns} data={displaySessions} pagination={false} size="small" />
        )}
      </Card>
    </div>
  );
}

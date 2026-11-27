import { useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ListTodo, MessageSquareText, Plus, Save, Trash2, UsersRound, X } from "lucide-react";
import { pluginRegistry } from "../plugins/registry";
import {
  expertTeamRegistry,
  projectTeamMessages,
  projectTeamTasks,
  type ExpertTeam,
  type ExpertTeamMember,
} from "../plugins/expertTeams";

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function blankTeam(): ExpertTeam {
  const now = Date.now();
  return { id: newId("team"), name: "", description: "", members: [], createdAt: now, updatedAt: now };
}

export default function ExpertTeamManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const teams = useSyncExternalStore(expertTeamRegistry.subscribe.bind(expertTeamRegistry), expertTeamRegistry.getSnapshot.bind(expertTeamRegistry));
  const runVersion = useSyncExternalStore(expertTeamRegistry.subscribe.bind(expertTeamRegistry), expertTeamRegistry.getVersion.bind(expertTeamRegistry));
  const pluginVersion = useSyncExternalStore(pluginRegistry.subscribe.bind(pluginRegistry), pluginRegistry.getVersion.bind(pluginRegistry));
  const experts = useMemo(() => pluginRegistry.listExperts(), [pluginVersion]);
  const [draft, setDraft] = useState<ExpertTeam | null>(null);
  const [memberExpertId, setMemberExpertId] = useState("");
  const [memberRole, setMemberRole] = useState("");
  const [error, setError] = useState("");
  const teamRuns = useMemo(
    () => draft ? expertTeamRegistry.listRuns(draft.id).sort((left, right) => right.updatedAt - left.updatedAt) : [],
    [draft?.id, runVersion],
  );

  if (!open) return null;

  const startCreate = () => {
    setDraft(blankTeam());
    setError("");
  };
  const startEdit = (team: ExpertTeam) => {
    setDraft({ ...team, members: team.members.map((member) => ({ ...member })) });
    setError("");
  };
  const addMember = () => {
    const expert = experts.find((entry) => entry.id === memberExpertId);
    if (!expert || !memberRole.trim() || !draft) return;
    const member: ExpertTeamMember = {
      id: newId("member"),
      expertId: expert.id,
      name: expert.name,
      role: memberRole.trim(),
    };
    setDraft({ ...draft, members: [...draft.members, member] });
    setMemberExpertId("");
    setMemberRole("");
  };
  const save = () => {
    if (!draft) return;
    try {
      expertTeamRegistry.save({ ...draft, name: draft.name.trim(), description: draft.description.trim() });
      setDraft(null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const remove = (team: ExpertTeam) => {
    try {
      expertTeamRegistry.remove(team.id);
      if (draft?.id === team.id) setDraft(null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return createPortal((
    <>
      <div className="expert-team-manager-backdrop" onClick={onClose} />
      <section className="omni-dialog expert-team-manager" role="dialog" aria-modal="true" aria-labelledby="expert-team-manager-title">
        <header className="expert-team-manager__header">
          <div>
            <h2 id="expert-team-manager-title">专家团</h2>
          </div>
          <button type="button" className="omni-dialog__close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="expert-team-manager__body">
          <aside className="expert-team-manager__list" aria-label="已配置专家团">
            <button type="button" className="expert-team-manager__new" onClick={startCreate}><Plus size={15} /> 新建专家团</button>
            {teams.map((team) => (
              <button key={team.id} type="button" className={`expert-team-manager__row${draft?.id === team.id ? " is-active" : ""}`} onClick={() => startEdit(team)}>
                <strong>{team.name || "未命名专家团"}</strong>
                <span>{team.members.length} 位成员</span>
              </button>
            ))}
            {teams.length === 0 && <p className="expert-team-manager__empty">创建专家团后，可为成员设定明确分工。</p>}
          </aside>

          <div className="expert-team-manager__editor">
            {draft ? (
              <>
                <label className="expert-team-manager__field">名称<input value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：产品发布评审组" /></label>
                <label className="expert-team-manager__field">工作目标<textarea value={draft.description} rows={2} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="描述团队要共同完成的目标" /></label>

                <div className="expert-team-manager__section-head"><strong>成员与分工</strong><span>{draft.members.length}/5</span></div>
                <div className="expert-team-manager__members">
                  {draft.members.map((member) => (
                    <div className="expert-team-manager__member" key={member.id}>
                      <div><strong>{member.name}</strong><span>{member.role}</span></div>
                      <button type="button" title={`移除 ${member.name}`} aria-label={`移除 ${member.name}`} onClick={() => setDraft({ ...draft, members: draft.members.filter((item) => item.id !== member.id) })}><X size={15} /></button>
                    </div>
                  ))}
                  {draft.members.length === 0 && <p className="expert-team-manager__empty">添加专家档案并说明它在团队中的具体职责。</p>}
                </div>

                {draft.members.length < 5 && (
                  <div className="expert-team-manager__add-member">
                    <select aria-label="选择成员专家" value={memberExpertId} onChange={(event) => setMemberExpertId(event.target.value)}>
                      <option value="">选择专家</option>
                      {experts.map((expert) => <option key={expert.id} value={expert.id}>{expert.name}</option>)}
                    </select>
                    <input aria-label="成员分工" value={memberRole} onChange={(event) => setMemberRole(event.target.value)} placeholder="职责，例如：核对数据与证据" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMember(); } }} />
                    <button type="button" title="添加成员" aria-label="添加成员" disabled={!memberExpertId || !memberRole.trim()} onClick={addMember}><Plus size={16} /></button>
                  </div>
                )}

                {error && <p className="expert-team-manager__error" role="alert">{error}</p>}
                <footer className="expert-team-manager__actions">
                  {teams.some((team) => team.id === draft.id) && <button type="button" className="expert-team-manager__delete" onClick={() => remove(draft)}><Trash2 size={14} /> 删除</button>}
                  <button type="button" className="expert-team-manager__save" disabled={!draft.name.trim() || draft.members.length === 0} onClick={save}><Save size={14} /> 保存专家团</button>
                </footer>

                {teamRuns.length > 0 && (
                  <section className="expert-team-manager__history" aria-label="专家团协作记录">
                    <div className="expert-team-manager__section-head"><strong>协作记录</strong><span>{teamRuns.length} 次运行</span></div>
                    {teamRuns.map((run) => {
                      const tasks = projectTeamTasks(run.events);
                      const messages = projectTeamMessages(run.events);
                      return (
                        <details className="expert-team-manager__run" key={run.id}>
                          <summary>
                            <span className={`expert-team-manager__run-state expert-team-manager__run-state--${run.status}`} />
                            <span>{new Date(run.createdAt).toLocaleString()}</span>
                            <strong>{run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : run.status === "interrupted" ? "已中断" : "进行中"}</strong>
                          </summary>
                          <div className="expert-team-manager__run-content">
                            <div className="expert-team-manager__run-group">
                              <div className="expert-team-manager__run-label"><ListTodo size={13} /> 任务板</div>
                              {tasks.length > 0 ? tasks.map((task) => (
                                <div className="expert-team-manager__run-task" key={task.id}>
                                  <span>{task.title}</span>
                                  <small>{task.status === "completed" ? "已完成" : task.status === "in_progress" ? "进行中" : task.status === "blocked" ? "受阻" : "待处理"}</small>
                                </div>
                              )) : <p className="expert-team-manager__empty">运行未生成任务状态。</p>}
                            </div>
                            <div className="expert-team-manager__run-group">
                              <div className="expert-team-manager__run-label"><MessageSquareText size={13} /> 成员汇报</div>
                              {messages.length > 0 ? messages.map((message) => {
                                const member = draft.members.find((entry) => entry.id === message.fromMemberId);
                                return <article className="expert-team-manager__report" key={message.id}><strong>{member?.name ?? "团队成员"}</strong><p>{message.content}</p></article>;
                              }) : <p className="expert-team-manager__empty">暂无成员汇报。</p>}
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </section>
                )}
              </>
            ) : (
              <div className="expert-team-manager__welcome"><UsersRound size={24} /><strong>按目标组合专家</strong><span>每位成员都绑定现有专家档案，并拥有清晰分工。</span></div>
            )}
            {experts.length === 0 && <p className="expert-team-manager__error">请先创建并启用专家档案，再配置团队成员。</p>}
          </div>
        </div>
      </section>
    </>
  ), document.body);
}

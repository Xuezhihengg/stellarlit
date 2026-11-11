"use client";

import { useCallback, useEffect, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { Modal } from "@/components/ui/Modal";
import {
  changeAccountPassword,
  fetchAccount,
  logoutAccount,
  revokeAllSessions,
  updateAccountName,
} from "@/lib/api/client";
import { formatDate, formatNumber, formatTokens } from "@/lib/format";
import { navigateWithFade } from "@/lib/navigation/transition";
import type { AccountOverviewDto, UsageDayDto } from "@/types/account";

const inputClass =
  "w-full rounded-lg border border-hair-2 bg-hair/15 px-3 py-2 text-[12px] text-ink outline-none transition-colors duration-[var(--dur-fast)] placeholder:text-ink-4/70 focus:border-accent/45";

const HEAT_LEVELS = [
  "bg-hair/70",
  "bg-accent/20",
  "bg-accent/40",
  "bg-accent/60",
  "bg-accent/85",
] as const;

export default function AccountPage() {
  const [data, setData] = useState<AccountOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchAccount();
      setData(next);
      setName(next.user.name);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取账号信息失败");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!data || savingName) return;
    const nextName = name.trim();
    if (!nextName) {
      setError("昵称不能为空");
      return;
    }
    setSavingName(true);
    setError(null);
    setNotice(null);
    try {
      const user = await updateAccountName(nextName);
      setData({ ...data, user });
      setNotice("昵称已更新");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingName(false);
    }
  };

  const openPassword = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
    setPasswordOpen(true);
  };

  const closePassword = () => {
    if (savingPassword) return;
    setPasswordOpen(false);
    setPasswordError(null);
  };

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingPassword) return;
    setPasswordError(null);
    if (newPassword.length < 8) {
      setPasswordError("新密码至少 8 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }
    setSavingPassword(true);
    try {
      await changeAccountPassword({ currentPassword, newPassword });
      setPasswordOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("密码已更新，其它设备上的登录已退出");
      void refresh();
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : "修改密码失败");
    } finally {
      setSavingPassword(false);
    }
  };

  const revoke = async () => {
    if (!window.confirm("这会退出所有设备，包括当前这台。确定继续吗？")) return;
    setRevoking(true);
    try {
      await revokeAllSessions();
      navigateWithFade("/login", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "退出失败");
      setRevoking(false);
    }
  };

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await logoutAccount();
    } finally {
      navigateWithFade("/login", { replace: true });
    }
  };

  return (
    <>
      <SecondaryPage
        title="账号与用量"
        actions={
          <GhostButton size="sm" onClick={() => void refresh()}>
            刷新
          </GhostButton>
        }
      >
        {error ? (
          <p className="mb-5 rounded-lg border border-alert/30 px-3 py-2 text-[12px] text-alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mb-5 rounded-lg border border-accent/30 px-3 py-2 text-[12px] text-accent">
            {notice}
          </p>
        ) : null}

        {!data ? (
          <p className="text-[12.5px] text-ink-4">正在读取账号信息…</p>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <section className="relative overflow-hidden rounded-2xl border border-hair bg-surface/35 p-6">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-20 -right-16 h-48 w-48 rounded-full bg-accent/8 blur-3xl"
                />
                <div className="relative">
                  <div className="flex items-center gap-3.5">
                    <span className="grid h-12 w-12 place-items-center rounded-full border border-accent/25 bg-accent/8 font-mono text-[16px] text-accent">
                      {data.user.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[16px] text-ink">{data.user.name}</p>
                      <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-4">
                        {data.user.email}
                      </p>
                    </div>
                  </div>

                  <p className="mt-5 font-mono text-[9.5px] tracking-[0.12em] text-ink-4 uppercase">
                    注册于 {formatDate(data.user.createdAt)}
                  </p>

                  <form onSubmit={saveName} className="mt-6 border-t border-hair pt-5">
                    <label className="block">
                      <span className="mb-1.5 block text-[10px] text-ink-4">昵称</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={40}
                        className={inputClass}
                      />
                    </label>
                    <div className="mt-3 flex justify-end">
                      <GhostButton
                        type="submit"
                        size="sm"
                        active={name.trim() !== data.user.name}
                        disabled={savingName || name.trim() === data.user.name}
                      >
                        {savingName ? "保存中…" : "保存昵称"}
                      </GhostButton>
                    </div>
                  </form>
                </div>
              </section>

              <section className="rounded-2xl border border-hair bg-surface/20 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] tracking-[0.12em] text-ink-4 uppercase">
                      今日 token 预算
                    </p>
                    <p className="mt-3 font-mono text-[27px] leading-none tracking-[-0.03em] text-ink">
                      {formatTokens(data.usage.tokens)}
                      <span className="ml-1.5 text-[12px] text-ink-4">
                        / {formatTokens(data.usage.budget)}
                      </span>
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] ${
                      data.usage.percent >= 100
                        ? "border-alert/35 text-alert"
                        : "border-hair-2 text-ink-4"
                    }`}
                  >
                    {data.usage.percent.toFixed(1)}%
                  </span>
                </div>

                <div className="mt-4 h-1 overflow-hidden rounded-full bg-hair">
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${
                      data.usage.percent >= 100 ? "bg-alert/75" : "bg-accent/70"
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, data.usage.percent))}%` }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[10px] text-ink-4">
                  <span>剩余 {formatTokens(data.usage.remaining)}</span>
                  <span>今日 {formatNumber(data.usage.calls)} 次模型调用</span>
                </div>

                <div className="mt-6 border-t border-hair pt-5">
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="text-[10px] tracking-[0.12em] text-ink-4 uppercase">过去 16 周</p>
                    <p className="text-[10px] text-ink-4">每日使用热度</p>
                  </div>
                  <ContributionHeatmap history={data.history} budget={data.usage.budget} />
                  <p className="mt-3 text-[10px] leading-relaxed text-ink-4">
                    预算按账号独立计算，每天 0 点重置。
                  </p>
                </div>
              </section>
            </div>

            <section className="overflow-hidden rounded-2xl border border-hair bg-hair">
              <div className="grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5">
                <Metric label="星空" value={data.stats.starfields} />
                <Metric label="论文" value={data.stats.papers} />
                <Metric label="问答历史" value={data.stats.history} />
                <Metric label="自定义关系" value={data.stats.presets} />
                <Metric label="模型账户" value={data.stats.modelAccounts} />
              </div>
            </section>

            <section className="rounded-2xl border border-hair px-6 py-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[12.5px] text-ink">账号安全</p>
                  <p className="mt-1 text-[10.5px] text-ink-4">
                    更新密码后，其它设备会自动退出登录。
                  </p>
                </div>
                <GhostButton size="sm" onClick={openPassword}>
                  修改密码
                </GhostButton>
              </div>

              <div className="mt-5 flex flex-col gap-4 border-t border-hair pt-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[11.5px] text-ink-2">登录会话</p>
                  <p className="mt-0.5 text-[10.5px] text-ink-4">
                    当前有 {data.sessions} 个登录会话
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <GhostButton size="sm" disabled={revoking || leaving} onClick={() => void revoke()}>
                    {revoking ? "正在退出…" : "退出所有设备"}
                  </GhostButton>
                  <GhostButton size="sm" disabled={leaving} onClick={() => void leave()}>
                    {leaving ? "正在退出…" : "退出当前账号"}
                  </GhostButton>
                </div>
              </div>
            </section>
          </div>
        )}
      </SecondaryPage>

      <Modal
        open={passwordOpen}
        onClose={closePassword}
        label="修改密码"
        className="max-w-[430px]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-medium text-ink">修改密码</h2>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">
              更新后，其它设备上的登录会自动退出。
            </p>
          </div>
          <button
            type="button"
            onClick={closePassword}
            className="text-[11px] text-ink-4 transition-colors hover:text-ink-2"
          >
            关闭
          </button>
        </div>

        <form onSubmit={savePassword} className="mt-5 space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-[10px] text-ink-4">当前密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[10px] text-ink-4">新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="至少 8 位"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[10px] text-ink-4">确认新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className={inputClass}
            />
          </label>

          {passwordError ? (
            <p className="rounded-md border border-alert/25 px-2.5 py-1.5 text-[10.5px] text-alert">
              {passwordError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <GhostButton size="sm" shape="rect" onClick={closePassword}>
              取消
            </GhostButton>
            <GhostButton
              type="submit"
              size="sm"
              shape="rect"
              active={Boolean(currentPassword && newPassword && confirmPassword)}
              disabled={
                savingPassword || !currentPassword || !newPassword || !confirmPassword
              }
            >
              {savingPassword ? "更新中…" : "更新密码"}
            </GhostButton>
          </div>
        </form>
      </Modal>
    </>
  );
}

function ContributionHeatmap({ history, budget }: { history: UsageDayDto[]; budget: number }) {
  const first = history[0];
  const leading = first ? (new Date(`${first.day}T00:00:00`).getDay() + 6) % 7 : 0;
  const cells: Array<UsageDayDto | null> = [
    ...Array.from({ length: leading }, () => null),
    ...history,
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const activeDays = history.filter((day) => day.tokens > 0).length;
  const total = history.reduce((sum, day) => sum + day.tokens, 0);

  return (
    <>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-5">
        <div
          role="img"
          aria-label={`过去 ${history.length} 天，${activeDays} 天有使用，共 ${formatTokens(total)} token`}
          className="grid grid-flow-col grid-rows-7 gap-[3px]"
        >
          {cells.map((day, index) =>
            day ? (
              <span
                key={day.day}
                title={`${day.day} · ${formatTokens(day.tokens)} token · ${formatNumber(day.calls)} 次调用`}
                className={`h-[10px] w-[10px] rounded-[2px] transition-colors hover:ring-1 hover:ring-accent/45 ${
                  HEAT_LEVELS[usageLevel(day.tokens, budget)]
                }`}
              />
            ) : (
              <span key={`empty-${index}`} aria-hidden="true" className="h-[10px] w-[10px]" />
            ),
          )}
        </div>

        <div className="ml-auto space-y-1 text-right text-[10px] text-ink-4">
          <p>
            <span className="font-mono text-[13px] text-ink-2">{activeDays}</span> 天有使用
          </p>
          <p>共 {formatTokens(total)} token</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-1 text-[9px] text-ink-4">
        <span className="mr-0.5">少</span>
        {HEAT_LEVELS.map((tone) => (
          <span key={tone} aria-hidden="true" className={`h-[8px] w-[8px] rounded-[2px] ${tone}`} />
        ))}
        <span className="ml-0.5">多</span>
      </div>
    </>
  );
}

function usageLevel(tokens: number, budget: number): number {
  if (tokens <= 0) return 0;
  const ratio = budget > 0 ? tokens / budget : 0;
  if (ratio < 0.2) return 1;
  if (ratio < 0.45) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg px-5 py-4">
      <p className="font-mono text-[19px] tracking-[-0.02em] text-ink tabular-nums">
        {formatNumber(value)}
      </p>
      <p className="mt-0.5 text-[10px] text-ink-4">{label}</p>
    </div>
  );
}

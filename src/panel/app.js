import { clear, h } from "@/lib/dom";
import { icon } from "@/lib/icons";
import { activeCwd, shortPath } from "@/lib/cwd";
import {
  getArchivedSessions,
  getListFilter,
  getPreferredCli,
  getShowArchived,
  setListFilter,
  setPreferredCli,
  setShowArchived,
} from "@/lib/storage";
import { openResumeTerminal, openStartTerminal } from "@/lib/resume";
import { filterGroups, listAll, pickStartCli } from "@/lib/sessions/index";
import { dateGroup, relativeTime } from "@/lib/time";
import { groupByDate } from "@/lib/sessions/group";
import { archiveSession, deleteSession, renameSession } from "@/lib/sessions/manage";
import { providerById } from "@/lib/sessions/providers";

export class SessionsPanel {
  constructor(root) {
    this.root = root;
    this.cwd = null;
    this.installed = [];
    this.groups = [];
    this.filter = "all";
    this.preferredCli = "grok";
    this.loading = true;
    this.error = null;
    this.busyId = null;
    this.showArchived = false;
    this.archivedSet = new Set();
  }

  async start() {
    this.preferredCli = await getPreferredCli();
    this.filter = await getListFilter();
    this.showArchived = await getShowArchived();
    this.archivedSet = await getArchivedSessions();

    muxy.events.subscribe("command.refresh-sessions", () => this.refresh());
    muxy.events.subscribe("project.switched", () => this.refresh());
    muxy.events.subscribe("worktree.switched", () => this.refresh());

    await this.refresh();
  }

  async refresh() {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      this.cwd = await activeCwd();
      this.archivedSet = await getArchivedSessions();
      const { installed, groups } = await listAll(this.cwd, { archivedSet: this.archivedSet });
      this.installed = installed;
      this.groups = groups;
      if (this.filter !== "all" && !installed.some((p) => p.id === this.filter)) {
        this.filter = "all";
        await setListFilter("all");
      }
    } catch (err) {
      this.error = err?.message || String(err);
      this.installed = [];
      this.groups = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async setFilter(filter) {
    this.filter = filter;
    await setListFilter(filter);
    this.render();
  }

  async resume(session) {
    this.busyId = `${session.cli}:${session.id}`;
    this.render();
    try {
      await openResumeTerminal(session.cli, session.id);
      if (session.cli !== this.preferredCli) {
        this.preferredCli = session.cli;
        await setPreferredCli(session.cli);
      }
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: "Could not resume session",
          body: err?.message || String(err),
        });
      } catch {
        // notifications optional
      }
    } finally {
      this.busyId = null;
      this.render();
    }
  }

  async startNew() {
    const cli = pickStartCli(this.preferredCli, this.installed);
    if (!cli) return;
    try {
      await openStartTerminal(cli);
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: "Could not start session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
    }
  }

  async toggleShowArchived() {
    this.showArchived = !this.showArchived;
    await setShowArchived(this.showArchived);
    this.render();
  }

  async rename(session) {
    const newTitle = await muxy.ui
      ?.prompt?.("Rename session", "Enter a new title:", session.title)
      .catch(() => null);
    if (newTitle === null || newTitle === undefined) return;
    const trimmed = newTitle.trim();
    if (!trimmed || trimmed === session.title) return;
    const key = `${session.cli}:${session.id}`;
    this.busyId = key;
    this.render();
    try {
      await renameSession(session.cli, session.id, trimmed);
      await this.refresh();
    } catch (err) {
      this.busyId = null;
      this.render();
      try {
        await muxy.notifications.notify({
          title: "Could not rename session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
    }
  }

  async archive(session) {
    const newArchived = !session.archived;
    const key = `${session.cli}:${session.id}`;
    this.busyId = key;
    this.render();
    try {
      await archiveSession(session.cli, session.id, newArchived);
      this.archivedSet = await getArchivedSessions();
      const { groups } = await listAll(this.cwd, { archivedSet: this.archivedSet });
      this.groups = groups;
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: newArchived ? "Could not archive session" : "Could not unarchive session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
    } finally {
      this.busyId = null;
      this.render();
    }
  }

  async delete(session) {
    const confirmed = await muxy.ui
      ?.confirm?.(`Delete session "${session.title}"? This cannot be undone.`)
      .catch(() => false);
    if (!confirmed) return;
    const key = `${session.cli}:${session.id}`;
    this.busyId = key;
    this.render();
    try {
      await deleteSession(session.cli, session.id, this.cwd);
      await this.refresh();
    } catch (err) {
      this.busyId = null;
      this.render();
      try {
        await muxy.notifications.notify({
          title: "Could not delete session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
    }
  }

  render() {
    clear(this.root);
    this.root.appendChild(this.view());
  }

  view() {
    const allVisible = filterGroups(this.groups, this.filter);
    // Apply archived filter: unless showArchived is on, hide archived sessions
    const visible = allVisible.map((g) => ({
      ...g,
      sessions: this.showArchived ? g.sessions : g.sessions.filter((s) => !s.archived),
    })).filter((g) => g.sessions.length || g.error);
    const flat =
      this.filter !== "all"
        ? visible.flatMap((g) => g.sessions)
        : null;

    return h(
      "div",
      { class: "flex h-full flex-col" },
      this.toolbar(),
      h(
        "div",
        { class: "px-2.5 pb-1.5 text-[10px] text-muted-foreground truncate" },
        this.cwd ? shortPath(this.cwd, 56) : "No active project",
      ),
      h(
        "div",
        { class: "min-h-0 flex-1 overflow-y-auto px-1 pb-2" },
        this.loading
          ? this.emptyState("Loading sessions…")
          : this.error
            ? this.emptyState(this.error)
            : !this.installed.length
              ? this.noCliState()
              : this.filter === "all"
                ? this.groupedBody(visible)
                : this.flatBody(flat, visible[0]),
      ),
      this.footer(),
    );
  }

  toolbar() {
    const chips = [
      { id: "all", label: "All" },
      ...this.installed.map((p) => ({ id: p.id, label: p.displayName })),
    ];

    const hasArchived = this.groups.some((g) => g.sessions.some((s) => s.archived));

    return h(
      "div",
      { class: "flex flex-wrap items-center gap-1 px-2.5 pt-2.5 pb-1" },
      ...chips.map((chip) =>
        h(
          "button",
          {
            type: "button",
            class:
              this.filter === chip.id
                ? "h-6 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground outline-none"
                : "h-6 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none hover:bg-accent",
            onclick: () => this.setFilter(chip.id),
          },
          chip.label,
        ),
      ),
      (hasArchived || this.showArchived)
        ? h(
            "button",
            {
              type: "button",
              class: this.showArchived
                ? "ml-auto h-6 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground outline-none"
                : "ml-auto h-6 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none hover:bg-accent",
              onclick: () => this.toggleShowArchived(),
            },
            icon("archive", 10),
            " Archived",
          )
        : null,
    );
  }

  groupedBody(groups) {
    if (!groups.length) {
      return this.emptyState("No sessions for this folder", true);
    }
    const errors = groups.filter((g) => g.error);
    const allSessions = groups
      .flatMap((g) => g.sessions)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const dateGroups = groupByDate(allSessions, dateGroup);
    return h(
      "div",
      { class: "flex flex-col gap-1" },
      ...errors.map((g) =>
        h(
          "div",
          { class: "px-2 py-1 text-[11px] text-muted-foreground" },
          `${g.displayName}: ${g.error}`,
        ),
      ),
      ...dateGroups.map(({ label, sessions }) =>
        this.dateSection(label, sessions),
      ),
    );
  }

  flatBody(sessions, group) {
    if (group?.error && !sessions?.length) {
      return this.emptyState(group.error);
    }
    if (!sessions?.length) {
      return this.emptyState("No sessions for this folder", true);
    }
    const dateGroups = groupByDate(sessions, dateGroup);
    return h(
      "div",
      { class: "flex flex-col" },
      group?.error
        ? h(
            "div",
            { class: "px-2 py-1 text-[11px] text-muted-foreground" },
            group.error,
          )
        : null,
      ...dateGroups.map(({ label, sessions: dateSessions }) =>
        this.dateSection(label, dateSessions),
      ),
    );
  }

  dateSection(label, sessions) {
    return h(
      "div",
      { class: "flex flex-col" },
      h(
        "div",
        {
          class:
            "sticky top-0 z-10 flex items-center justify-between bg-background px-2 py-1",
        },
        h(
          "span",
          {
            class:
              "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
          },
          label,
        ),
        h(
          "span",
          { class: "font-mono text-[10px] text-muted-foreground" },
          String(sessions.length),
        ),
      ),
      ...sessions.map((s) => this.row(s)),
    );
  }

  row(session) {
    const key = `${session.cli}:${session.id}`;
    const busy = this.busyId === key;
    const idShort = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
    const secondary = [relativeTime(session.updatedAt), idShort, session.branch]
      .filter(Boolean)
      .join(" · ");

    const caps = providerById(session.cli)?.capabilities ?? {};

    const actionButtons = [];
    if (caps.rename) {
      actionButtons.push(
        h("button", {
          type: "button",
          title: "Rename",
          class:
            "flex items-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent outline-none",
          onclick: (e) => { e.stopPropagation(); this.rename(session); },
        }, icon("pencil", 11)),
      );
    }
    if (caps.archive) {
      actionButtons.push(
        h("button", {
          type: "button",
          title: session.archived ? "Unarchive" : "Archive",
          class:
            "flex items-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent outline-none",
          onclick: (e) => { e.stopPropagation(); this.archive(session); },
        }, icon(session.archived ? "archive-restore" : "archive", 11)),
      );
    }
    if (caps.delete) {
      actionButtons.push(
        h("button", {
          type: "button",
          title: "Delete",
          class:
            "flex items-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-accent outline-none",
          onclick: (e) => { e.stopPropagation(); this.delete(session); },
        }, icon("trash", 11)),
      );
    }

    const wrapper = h(
      "div",
      {
        class: `group relative flex w-full items-stretch rounded-md hover:bg-accent${session.archived ? " opacity-60" : ""}`,
      },
      h(
        "button",
        {
          type: "button",
          disabled: busy,
          class:
            "flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5 text-left outline-none disabled:opacity-60",
          onclick: () => this.resume(session),
        },
        h(
          "div",
          { class: "flex w-full items-center gap-2" },
          session.archived
            ? icon("archive", 10, "shrink-0 text-muted-foreground")
            : null,
          h(
            "span",
            { class: "min-w-0 flex-1 truncate text-[12px] text-foreground" },
            session.title,
          ),
          busy ? icon("refresh", 12, "text-muted-foreground animate-spin") : null,
        ),
        h(
          "span",
          { class: "font-mono text-[10px] text-muted-foreground" },
          secondary,
        ),
      ),
      actionButtons.length
        ? h(
            "div",
            { class: "flex items-center gap-0.5 pr-1.5" },
            ...actionButtons,
          )
        : null,
    );
    return wrapper;
  }

  footer() {
    const canStart = this.installed.length > 0;
    const startCli = pickStartCli(this.preferredCli, this.installed);
    const label = startCli
      ? `Start new ${this.installed.find((p) => p.id === startCli)?.displayName ?? startCli}`
      : "Start new session";

    return h(
      "div",
      { class: "border-t border-border px-2.5 py-2" },
      h(
        "button",
        {
          type: "button",
          disabled: !canStart,
          class:
            "flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-surface text-[12px] text-foreground outline-none hover:bg-accent disabled:opacity-50",
          onclick: () => this.startNew(),
        },
        icon("sparkles", 12),
        label,
      ),
    );
  }

  emptyState(message, showStart = false) {
    return h(
      "div",
      {
        class:
          "flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-[12px] text-muted-foreground",
      },
      h("p", null, message),
      showStart && this.installed.length
        ? h(
            "button",
            {
              type: "button",
              class:
                "h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground",
              onclick: () => this.startNew(),
            },
            "Start new session",
          )
        : null,
    );
  }

  noCliState() {
    return h(
      "div",
      {
        class:
          "flex flex-col gap-2 px-4 py-8 text-[12px] text-muted-foreground",
      },
      h(
        "p",
        { class: "text-center font-medium text-foreground" },
        "No AI CLIs found on PATH",
      ),
      h(
        "p",
        { class: "text-center" },
        "Install grok, claude, codex, copilot, or cursor-agent, then refresh.",
      ),
    );
  }
}
